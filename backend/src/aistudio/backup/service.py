"""Scheduled backups of ``studio.db`` and every workspace memory repo (spec §18).

Layout of one backup (``<backup.dir>/aistudio-<UTC timestamp>/``)::

    manifest.json              format version, app version, reason, files with size + sha256
    studio.db                  consistent copy via the SQLite online backup API (rollback-journal mode)
    memory/<slug>.bundle       ``git bundle --all`` of each workspace memory repo

A backup is assembled in a hidden ``.partial`` directory and renamed into place only when complete,
so a crash never leaves a half-written backup that looks valid. Only directories matching the
backup naming scheme are ever pruned; other files in the chosen folder are never touched.

Restore caveats (also surfaced to the UI through ``RestoreResult.restart_required``):
    * The live database is overwritten page by page through the SQLite online backup API while
      studiod keeps running; other connections see the restored data on their next transaction.
      Appends to the event log are held off during the copy and the hash chain continues from
      the restored tail, so ``verify_chain`` stays valid.
    * In-memory state of other modules (running agent sessions, approval waiters, engine runs) is
      not rolled back, and tables added by a newer version are only created at the next start:
      restart the app after a restore.
    * Events written between the backup and the restore are gone (that is the point of restoring).
    * Memory repos contained in the backup are replaced entirely; repos not in the backup are left
      untouched. A safety backup of the current state is taken first unless explicitly disabled.

Events: ``backup.created`` (info), ``backup.restored`` (normal), ``backup.failed`` (high).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from aistudio import __version__
from aistudio.core import proc
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound, StudioError, ValidationFailed
from aistudio.core.events import Severity
from aistudio.core.ids import ulid

log = logging.getLogger(__name__)

SETTING_INTERVAL = "backup.interval_hours"  # 0 disables scheduled backups
SETTING_DIR = "backup.dir"  # None / "" = <home>/backups
SETTING_KEEP = "backup.keep"
DEFAULTS: dict[str, object] = {SETTING_INTERVAL: 24, SETTING_DIR: None, SETTING_KEEP: 14}

FORMAT_VERSION = 1
MANIFEST = "manifest.json"
DB_FILE = "studio.db"
NAME_RE = re.compile(r"^aistudio-\d{8}T\d{6}Z(?:-\d{1,3})?$")
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
_CHUNK = 1024 * 1024

Reason = Literal["manual", "scheduled", "pre-restore"]


class BackupError(StudioError):
    status_code = 500
    code = "backup_failed"


class BackupFile(BaseModel):
    path: str  # relative to the backup directory
    kind: Literal["database", "memory"]
    size: int
    sha256: str
    workspace_slug: str | None = None
    head: str | None = None  # memory repo HEAD at backup time


class BackupManifest(BaseModel):
    version: int = FORMAT_VERSION
    app_version: str
    name: str
    reason: Reason = "manual"
    created_at: datetime
    files: list[BackupFile] = Field(default_factory=list)
    total_size: int = 0


class BackupInfo(BaseModel):
    name: str
    path: str
    created_at: datetime
    reason: Reason
    total_size: int
    workspaces: list[str] = Field(default_factory=list)
    app_version: str


class RestoreResult(BaseModel):
    name: str
    restored_workspaces: list[str] = Field(default_factory=list)
    safety_backup: str | None = None
    restart_required: bool = True


class BackupSettings(BaseModel):
    interval_hours: float
    dir: str | None
    keep: int
    resolved_dir: str
    last_backup_at: datetime | None = None
    next_backup_at: datetime | None = None


class BackupSettingsUpdate(BaseModel):
    interval_hours: float | None = Field(default=None, ge=0, le=24 * 31)
    dir: str | None = None  # "" resets to the default folder
    keep: int | None = Field(default=None, ge=1, le=1000)


# --------------------------------------------------------------------------- blocking helpers


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(_CHUNK):
            h.update(chunk)
    return h.hexdigest()


def _sqlite_snapshot(src_path: str, dst_path: str) -> None:
    """Consistent copy of a live database into a self-contained (rollback-journal) file."""
    src = sqlite3.connect(src_path, timeout=30)
    try:
        dst = sqlite3.connect(dst_path)
        try:
            src.backup(dst)
            dst.execute("PRAGMA journal_mode=DELETE")
            ok = dst.execute("PRAGMA integrity_check").fetchone()
            if not ok or ok[0] != "ok":
                raise BackupError("Yedeklenen veritabanı bütünlük denetiminden geçmedi.")
        finally:
            dst.close()
    finally:
        src.close()


def _sqlite_check(path: str) -> None:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        ok = conn.execute("PRAGMA integrity_check").fetchone()
    finally:
        conn.close()
    if not ok or ok[0] != "ok":
        raise ValidationFailed("Yedekteki veritabanı bozuk; geri yüklenemez.")


def _sqlite_restore(backup_path: str, live_path: str) -> None:
    """Copy the backup into the live database file (the live file keeps its WAL mode)."""
    src = sqlite3.connect(f"file:{backup_path}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(live_path, timeout=30)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


# --------------------------------------------------------------------------- service


class BackupServiceImpl:
    def __init__(self, ctx: AppContext) -> None:
        self._ctx = ctx
        self._lock = asyncio.Lock()
        self._task: asyncio.Task[None] | None = None
        # Scheduler timing (instance attributes so tests can shorten them).
        self.startup_delay = 120.0  # never back up during app start
        self.max_sleep = 600.0  # re-read settings at least this often
        self.retry_after_failure = 3600.0

    @staticmethod
    def declare_settings(ctx: AppContext) -> None:
        for key, value in DEFAULTS.items():
            ctx.store.declare(key, value)

    # ------------------------------------------------------------------ settings
    async def backup_dir(self) -> Path:
        raw = await self._ctx.store.get(SETTING_DIR)
        if isinstance(raw, str) and raw.strip():
            return Path(raw).expanduser()
        return self._ctx.settings.paths.backups

    async def _interval_hours(self) -> float:
        raw = await self._ctx.store.get(SETTING_INTERVAL)
        try:
            return max(0.0, float(raw))
        except (TypeError, ValueError):
            return float(DEFAULTS[SETTING_INTERVAL])  # type: ignore[arg-type]

    async def _keep(self) -> int:
        raw = await self._ctx.store.get(SETTING_KEEP)
        try:
            return max(1, int(raw))
        except (TypeError, ValueError):
            return int(DEFAULTS[SETTING_KEEP])  # type: ignore[call-overload]

    async def settings(self) -> BackupSettings:
        backups = await self.list()
        last = backups[0].created_at if backups else None
        interval = await self._interval_hours()
        nxt: datetime | None = None
        if interval > 0:
            nxt = (last + timedelta(hours=interval)) if last else utcnow()
        raw_dir = await self._ctx.store.get(SETTING_DIR)
        return BackupSettings(
            interval_hours=interval,
            dir=raw_dir if isinstance(raw_dir, str) and raw_dir.strip() else None,
            keep=await self._keep(),
            resolved_dir=str(await self.backup_dir()),
            last_backup_at=last,
            next_backup_at=nxt,
        )

    async def update_settings(self, update: BackupSettingsUpdate) -> BackupSettings:
        if update.dir is not None:
            if update.dir.strip():
                target = Path(update.dir.strip()).expanduser()
                if not target.is_absolute():
                    raise ValidationFailed("Yedek klasörü tam bir yol olmalı.", details={"dir": update.dir})
                await asyncio.to_thread(self._check_writable, target)
                await self._ctx.store.set(SETTING_DIR, str(target))
            else:
                await self._ctx.store.set(SETTING_DIR, None)
        if update.interval_hours is not None:
            await self._ctx.store.set(SETTING_INTERVAL, update.interval_hours)
        if update.keep is not None:
            await self._ctx.store.set(SETTING_KEEP, update.keep)
        await self._ctx.events.append("backup.settings_changed", update.model_dump(exclude_none=True), actor="user")
        return await self.settings()

    @staticmethod
    def _check_writable(target: Path) -> None:
        try:
            target.mkdir(parents=True, exist_ok=True)
            probe = target / f".aistudio-write-test-{os.getpid()}"
            probe.write_bytes(b"ok")
            probe.unlink()
        except OSError as e:
            raise ValidationFailed(
                "Yedek klasörüne yazılamıyor.", details={"dir": str(target), "error": e.strerror or str(e)}
            ) from e

    # ------------------------------------------------------------------ listing
    def _read_manifest(self, directory: Path) -> BackupManifest | None:
        try:
            data = json.loads((directory / MANIFEST).read_text(encoding="utf-8"))
            manifest = BackupManifest.model_validate(data)
        except (OSError, ValueError, ValidationError):
            return None
        return manifest if manifest.name == directory.name else None

    def _scan(self, root: Path) -> list[tuple[Path, BackupManifest]]:
        if not root.is_dir():
            return []
        found: list[tuple[Path, BackupManifest]] = []
        for entry in root.iterdir():
            if entry.is_dir() and NAME_RE.match(entry.name):
                manifest = self._read_manifest(entry)
                if manifest is not None:
                    found.append((entry, manifest))
        found.sort(key=lambda item: (item[1].created_at, item[0].name), reverse=True)
        return found

    async def list(self) -> list[BackupInfo]:
        root = await self.backup_dir()
        items = await asyncio.to_thread(self._scan, root)
        return [
            BackupInfo(
                name=m.name,
                path=str(p),
                created_at=m.created_at,
                reason=m.reason,
                total_size=m.total_size,
                workspaces=[f.workspace_slug for f in m.files if f.kind == "memory" and f.workspace_slug],
                app_version=m.app_version,
            )
            for p, m in items
        ]

    async def manifest(self, name: str) -> BackupManifest:
        directory = await self._backup_path(name)
        manifest = await asyncio.to_thread(self._read_manifest, directory)
        if manifest is None:
            raise ValidationFailed("Yedeğin bildirim dosyası (manifest.json) okunamadı.", details={"name": name})
        return manifest

    async def _backup_path(self, name: str) -> Path:
        if not NAME_RE.match(name):
            raise NotFound("Yedek bulunamadı.", details={"name": name})
        directory = (await self.backup_dir()) / name
        if not directory.is_dir():
            raise NotFound("Yedek bulunamadı.", details={"name": name})
        return directory

    # ------------------------------------------------------------------ create
    def _live_db_path(self) -> str:
        path = self._ctx.db.engine.url.database
        if not path or path == ":memory:":
            raise BackupError("Bellek içi veritabanı yedeklenemez.")
        return path

    async def create(self, *, reason: Reason = "manual", protect: frozenset[str] = frozenset()) -> BackupInfo:
        async with self._lock:
            try:
                return await self._create(reason=reason, protect=protect)
            except Exception as e:
                await self._failed("create", e)
                if isinstance(e, StudioError):
                    raise
                raise BackupError("Yedek alınamadı.", details={"error": str(e)}) from e

    async def _create(self, *, reason: Reason, protect: frozenset[str]) -> BackupInfo:
        started = time.monotonic()
        root = await self.backup_dir()
        await asyncio.to_thread(root.mkdir, parents=True, exist_ok=True)
        await asyncio.to_thread(self._clean_partials, root)
        now = utcnow()
        name = self._unique_name(root, now)
        work = root / f".{name}.{ulid()[-8:]}.partial"
        await asyncio.to_thread(work.mkdir)
        try:
            files: list[BackupFile] = []
            db_target = work / DB_FILE
            await asyncio.to_thread(_sqlite_snapshot, self._live_db_path(), str(db_target))
            files.append(await self._describe(work, DB_FILE, "database"))

            for slug, repo in await asyncio.to_thread(self._memory_repos):
                head = await proc.git("rev-parse", "--verify", "-q", "HEAD", cwd=str(repo))
                if head.returncode != 0:
                    continue  # empty repo: nothing to bundle
                rel = f"memory/{slug}.bundle"
                (work / "memory").mkdir(exist_ok=True)
                res = await proc.git("bundle", "create", "-q", str(work / rel), "--all", cwd=str(repo), timeout=600)
                if res.returncode != 0:
                    raise BackupError(
                        "Hafıza reposu paketlenemedi.", details={"workspace": slug, "stderr": res.stderr.strip()[-500:]}
                    )
                files.append(
                    await self._describe(work, rel, "memory", workspace_slug=slug, head=head.stdout.strip() or None)
                )

            manifest = BackupManifest(
                app_version=__version__,
                name=name,
                reason=reason,
                created_at=now,
                files=files,
                total_size=sum(f.size for f in files),
            )
            await asyncio.to_thread((work / MANIFEST).write_text, manifest.model_dump_json(indent=2), encoding="utf-8")
            final = root / name
            await asyncio.to_thread(work.rename, final)
        except BaseException:
            await asyncio.to_thread(shutil.rmtree, work, True)
            raise
        removed = await self._prune(root, await self._keep(), protect=protect | {name})
        info = BackupInfo(
            name=name,
            path=str(final),
            created_at=now,
            reason=reason,
            total_size=manifest.total_size,
            workspaces=[f.workspace_slug for f in files if f.workspace_slug],
            app_version=__version__,
        )
        await self._ctx.events.append(
            "backup.created",
            {
                "name": name,
                "path": str(final),
                "size": manifest.total_size,
                "workspaces": len(info.workspaces),
                "reason": reason,
                "pruned": removed,
                "duration_ms": int((time.monotonic() - started) * 1000),
            },
        )
        return info

    async def _describe(
        self, work: Path, rel: str, kind: Literal["database", "memory"], **extra: str | None
    ) -> BackupFile:
        path = work / rel
        size = (await asyncio.to_thread(path.stat)).st_size
        digest = await asyncio.to_thread(_sha256, path)
        return BackupFile(path=rel, kind=kind, size=size, sha256=digest, **extra)

    def _unique_name(self, root: Path, now: datetime) -> str:
        base = f"aistudio-{now.astimezone(UTC):%Y%m%dT%H%M%SZ}"
        name, n = base, 2
        while (root / name).exists():
            name = f"{base}-{n}"
            n += 1
        return name

    def _memory_repos(self) -> list[tuple[str, Path]]:
        root = self._ctx.settings.paths.workspaces
        if not root.is_dir():
            return []
        repos: list[tuple[str, Path]] = []
        for ws_dir in sorted(root.iterdir()):
            mem = ws_dir / "memory"
            if _SLUG_RE.match(ws_dir.name) and (mem / ".git").exists():
                repos.append((ws_dir.name, mem))
        return repos

    @staticmethod
    def _clean_partials(root: Path) -> None:
        cutoff = time.time() - 6 * 3600
        for entry in root.iterdir():
            if entry.name.startswith(".aistudio-") and entry.name.endswith(".partial") and entry.is_dir():
                with contextlib.suppress(OSError):
                    if entry.stat().st_mtime < cutoff:
                        shutil.rmtree(entry)

    async def prune(self) -> list[str]:
        async with self._lock:
            return await self._prune(await self.backup_dir(), await self._keep(), protect=frozenset())

    async def _prune(self, root: Path, keep: int, *, protect: frozenset[str]) -> list[str]:
        items = await asyncio.to_thread(self._scan, root)
        removed: list[str] = []
        for path, manifest in items[keep:]:
            if manifest.name in protect:
                continue
            await asyncio.to_thread(shutil.rmtree, path)
            removed.append(manifest.name)
        return removed

    # ------------------------------------------------------------------ restore
    async def restore(self, name: str, *, safety_backup: bool = True, actor: str = "user") -> RestoreResult:
        directory = await self._backup_path(name)
        manifest = await self.manifest(name)
        try:
            await self._verify(directory, manifest)
        except StudioError as e:
            await self._failed("restore", e, name=name)
            raise
        safety: str | None = None
        if safety_backup:
            safety = (await self.create(reason="pre-restore", protect=frozenset({name}))).name
        async with self._lock:
            try:
                restored = await self._restore(directory, manifest)
            except Exception as e:
                await self._failed("restore", e, name=name)
                if isinstance(e, StudioError):
                    raise
                raise BackupError("Yedek geri yüklenemedi.", details={"error": str(e)}) from e
        result = RestoreResult(name=name, restored_workspaces=restored, safety_backup=safety)
        await self._ctx.events.append(
            "backup.restored",
            {
                "name": name,
                "workspaces": restored,
                "safety_backup": safety,
                "restart_required": True,
            },
            severity=Severity.normal,
            actor=actor,
        )
        return result

    async def _verify(self, directory: Path, manifest: BackupManifest) -> None:
        if manifest.version > FORMAT_VERSION:
            raise ValidationFailed("Bu yedek daha yeni bir AI Studio sürümüyle alınmış; önce uygulamayı güncelleyin.")
        if not any(f.kind == "database" for f in manifest.files):
            raise ValidationFailed("Yedekte veritabanı yok.")
        for f in manifest.files:
            rel = Path(f.path)
            if rel.is_absolute() or ".." in rel.parts:
                raise ValidationFailed("Yedek bildirimi geçersiz bir dosya yolu içeriyor.", details={"path": f.path})
            if f.kind == "memory" and not (f.workspace_slug and _SLUG_RE.match(f.workspace_slug)):
                raise ValidationFailed("Yedek bildirimi geçersiz bir çalışma alanı içeriyor.", details={"path": f.path})
            path = directory / rel
            if not path.is_file():
                raise ValidationFailed("Yedek eksik: dosya bulunamadı.", details={"path": f.path})
            size = (await asyncio.to_thread(path.stat)).st_size
            digest = await asyncio.to_thread(_sha256, path)
            if size != f.size or digest != f.sha256:
                raise ValidationFailed("Yedek doğrulanamadı: dosya değişmiş ya da bozulmuş.", details={"path": f.path})
        await asyncio.to_thread(_sqlite_check, str(directory / DB_FILE))

    async def _restore(self, directory: Path, manifest: BackupManifest) -> list[str]:
        live = self._live_db_path()
        async with self._ctx.events.exclusive():
            await asyncio.to_thread(_sqlite_restore, str(directory / DB_FILE), live)
        restored: list[str] = []
        for f in manifest.files:
            if f.kind != "memory" or not f.workspace_slug:
                continue
            await self._restore_memory(f.workspace_slug, directory / f.path)
            restored.append(f.workspace_slug)
        return restored

    async def _restore_memory(self, slug: str, bundle: Path) -> None:
        target = self._ctx.settings.paths.memory_dir(slug)
        parent = target.parent
        await asyncio.to_thread(parent.mkdir, parents=True, exist_ok=True)
        token = ulid()[-8:]
        staging = parent / f".memory-restore-{token}"
        res = await proc.git("clone", "-q", str(bundle), str(staging), cwd=str(parent), timeout=600)
        if res.returncode != 0:
            await asyncio.to_thread(shutil.rmtree, staging, True)
            raise BackupError(
                "Hafıza reposu yedekten açılamadı.", details={"workspace": slug, "stderr": res.stderr.strip()[-500:]}
            )
        await proc.git("remote", "remove", "origin", cwd=str(staging))
        old = parent / f".memory-old-{token}"
        if target.exists():
            await asyncio.to_thread(target.rename, old)
        await asyncio.to_thread(staging.rename, target)
        await asyncio.to_thread(shutil.rmtree, old, True)

    async def _failed(self, operation: str, error: BaseException, *, name: str | None = None) -> None:
        message = error.message if isinstance(error, StudioError) else str(error) or type(error).__name__
        log.error("backup %s failed: %s", operation, message)
        with contextlib.suppress(Exception):
            await self._ctx.events.append(
                "backup.failed",
                {"operation": operation, "name": name, "error": message},
                severity=Severity.high,
            )

    # ------------------------------------------------------------------ scheduler
    async def seconds_until_due(self) -> float | None:
        """``None`` when scheduled backups are disabled; ``<= 0`` when one is due now."""
        interval = await self._interval_hours()
        if interval <= 0:
            return None
        backups = await self.list()
        if not backups:
            return 0.0
        due = backups[0].created_at + timedelta(hours=interval)
        return (due - utcnow()).total_seconds()

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = self._ctx.spawn(self._loop(), name="backup-scheduler")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _loop(self) -> None:
        await asyncio.sleep(self.startup_delay)
        while True:
            try:
                wait = await self.seconds_until_due()
            except Exception:
                log.exception("backup scheduler could not read its state")
                wait = self.max_sleep
            if wait is None:
                await asyncio.sleep(self.max_sleep)
                continue
            if wait > 0:
                await asyncio.sleep(min(wait, self.max_sleep))
                continue
            try:
                await self.create(reason="scheduled")
            except asyncio.CancelledError:
                raise
            except Exception:  # already reported through backup.failed
                await asyncio.sleep(self.retry_after_failure)
