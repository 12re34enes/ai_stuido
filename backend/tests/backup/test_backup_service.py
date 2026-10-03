from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from pathlib import Path

import pytest
from backup_helpers import BackupEnv

from aistudio.backup.service import (
    SETTING_INTERVAL,
    SETTING_KEEP,
    BackupError,
    BackupSettingsUpdate,
)
from aistudio.core.errors import NotFound, ValidationFailed
from aistudio.core.events import EventFilter, Severity
from aistudio.workspaces.service import WorkspaceCreate


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


async def test_create_writes_consistent_backup(backup_env: BackupEnv) -> None:
    env = backup_env
    info = await env.svc.create()
    root = Path(info.path)
    assert root.parent == env.ctx.settings.paths.backups
    assert root.name == info.name and info.name.startswith("aistudio-") and info.reason == "manual"
    assert info.workspaces == [env.ws.slug]

    manifest = json.loads((root / "manifest.json").read_text())
    assert manifest["version"] == 1 and manifest["name"] == info.name
    files = {f["path"]: f for f in manifest["files"]}
    assert set(files) == {"studio.db", f"memory/{env.ws.slug}.bundle"}
    for rel, f in files.items():
        assert (root / rel).stat().st_size == f["size"]
        assert _sha(root / rel) == f["sha256"]
    assert manifest["total_size"] == sum(f["size"] for f in files.values())
    assert files[f"memory/{env.ws.slug}.bundle"]["head"] == await env.memory.head(env.ws.id)

    # Self-contained SQLite file with our data, no WAL side files.
    assert not (root / "studio.db-wal").exists()
    conn = sqlite3.connect(f"file:{root / 'studio.db'}?mode=ro", uri=True)
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
        names = [r[0] for r in conn.execute("SELECT name FROM workspaces")]
    finally:
        conn.close()
    assert names == ["Yedek Testi"]

    created = await env.ctx.events.query(EventFilter(types=["backup.created"]))
    assert created[0].payload["name"] == info.name and created[0].payload["workspaces"] == 1

    listed = await env.svc.list()
    assert [b.name for b in listed] == [info.name]
    manifest_model = await env.svc.manifest(info.name)
    assert manifest_model.files[0].kind == "database"
    assert not any(p.name.endswith(".partial") for p in root.parent.iterdir())


async def test_backup_restore_round_trip(backup_env: BackupEnv) -> None:
    env = backup_env
    head_before = await env.memory.head(env.ws.id)
    events_before = await env.ctx.events.last_id()
    backup = await env.svc.create()

    # Mutate everything after the backup.
    await env.memory.write(env.ws.id, "facts.md", "# Proje gerçekleri\n\nSonradan değişti.\n", message="sonra")
    await env.memory.write(env.ws.id, "decisions/2026-10-03-yeni.md", "# Yeni karar\n", message="karar")
    later = await env.workspaces.create(WorkspaceCreate(name="Sonraki Alan"))
    await env.memory.ensure(later.id)
    await env.ctx.store.set(SETTING_KEEP, 3)
    for i in range(5):
        await env.ctx.events.append("test.after_backup", {"i": i})

    result = await env.svc.restore(backup.name)
    assert result.restart_required is True
    assert result.restored_workspaces == [env.ws.slug]
    assert result.safety_backup is not None

    # Database content is back to the backup state.
    names = [w.name for w in await env.workspaces.list()]
    assert names == ["Yedek Testi"]
    assert await env.ctx.store.get(SETTING_KEEP) == 14
    assert await env.ctx.events.query(EventFilter(types=["test.after_backup"])) == []

    # Memory repo is back (history included), the later workspace's repo is untouched.
    memory_root = env.ctx.settings.paths.memory_dir(env.ws.slug)
    assert "İlk hal." in (memory_root / "facts.md").read_text()
    assert not (memory_root / "decisions/2026-10-03-yeni.md").exists()
    assert await env.memory.head(env.ws.id) == head_before
    assert (env.ctx.settings.paths.memory_dir(later.slug) / "facts.md").exists()
    assert not any(p.name.startswith(".memory-") for p in memory_root.parent.iterdir())

    # The hash chain continues from the restored tail.
    restored = await env.ctx.events.query(EventFilter(types=["backup.restored"]))
    assert len(restored) == 1 and restored[0].payload["name"] == backup.name
    assert restored[0].id > events_before
    await env.ctx.events.append("test.after_restore")
    assert await env.ctx.events.verify_chain() == (True, None)

    # The safety backup captured the mutated state and can itself be restored.
    names_in_list = [b.name for b in await env.svc.list()]
    assert result.safety_backup in names_in_list
    safety = await env.svc.manifest(result.safety_backup)
    assert safety.reason == "pre-restore"
    assert {f.workspace_slug for f in safety.files if f.kind == "memory"} == {env.ws.slug, later.slug}


async def test_restore_rejects_tampered_or_missing_backups(backup_env: BackupEnv) -> None:
    env = backup_env
    info = await env.svc.create()
    db_file = Path(info.path) / "studio.db"
    with db_file.open("r+b") as f:
        f.seek(200)
        f.write(b"\x00garbage\x00")
    with pytest.raises(ValidationFailed) as exc:
        await env.svc.restore(info.name)
    assert "doğrulanamadı" in exc.value.message
    failed = await env.ctx.events.query(EventFilter(types=["backup.failed"]))
    assert failed[-1].severity == Severity.high and failed[-1].payload["operation"] == "restore"
    assert len(await env.svc.list()) == 1  # no safety backup for an invalid restore

    with pytest.raises(NotFound):
        await env.svc.restore("aistudio-20000101T000000Z")
    with pytest.raises(NotFound):
        await env.svc.restore("../../etc")

    other = await env.svc.create()
    (Path(other.path) / f"memory/{env.ws.slug}.bundle").unlink()
    with pytest.raises(ValidationFailed) as exc:
        await env.svc.restore(other.name)
    assert exc.value.message == "Yedek eksik: dosya bulunamadı."


async def test_prune_keeps_newest_and_ignores_foreign_files(backup_env: BackupEnv) -> None:
    env = backup_env
    root = env.ctx.settings.paths.backups
    root.mkdir(parents=True, exist_ok=True)
    (root / "notlarim.txt").write_text("dokunma")
    (root / "aistudio-elle").mkdir()
    await env.ctx.store.set(SETTING_KEEP, 2)
    names = [(await env.svc.create()).name for _ in range(3)]
    assert len(set(names)) == 3  # same-second backups get unique names
    remaining = [b.name for b in await env.svc.list()]
    assert remaining == [names[2], names[1]]
    assert (root / "notlarim.txt").exists() and (root / "aistudio-elle").is_dir()
    pruned = (await env.ctx.events.query(EventFilter(types=["backup.created"])))[-1].payload["pruned"]
    assert pruned == [names[0]]


async def test_restore_protects_the_backup_being_restored_from_pruning(backup_env: BackupEnv) -> None:
    env = backup_env
    await env.ctx.store.set(SETTING_KEEP, 1)
    first = await env.svc.create()
    result = await env.svc.restore(first.name)  # the safety backup must not prune `first`
    assert result.safety_backup is not None
    assert await env.svc.manifest(first.name)


async def test_settings_and_custom_directory(backup_env: BackupEnv, tmp_path: Path) -> None:
    env = backup_env
    s = await env.svc.settings()
    assert s.interval_hours == 24 and s.keep == 14 and s.dir is None
    assert s.resolved_dir == str(env.ctx.settings.paths.backups)
    assert s.last_backup_at is None and s.next_backup_at is not None

    target = tmp_path / "iCloud" / "AI Studio Yedekleri"
    s = await env.svc.update_settings(BackupSettingsUpdate(dir=str(target), keep=5, interval_hours=6))
    assert s.resolved_dir == str(target) and s.keep == 5 and s.interval_hours == 6
    info = await env.svc.create()
    assert Path(info.path).parent == target
    s = await env.svc.settings()
    assert s.last_backup_at == info.created_at
    assert s.next_backup_at is not None and (s.next_backup_at - info.created_at).total_seconds() == 6 * 3600

    with pytest.raises(ValidationFailed):
        await env.svc.update_settings(BackupSettingsUpdate(dir="goreli/yol"))
    s = await env.svc.update_settings(BackupSettingsUpdate(dir=""))
    assert s.dir is None and s.resolved_dir == str(env.ctx.settings.paths.backups)
    with pytest.raises(ValueError, match="greater than or equal to 1"):
        BackupSettingsUpdate(keep=0)


async def test_create_failure_emits_high_severity_event(backup_env: BackupEnv, tmp_path: Path) -> None:
    env = backup_env
    blocker = tmp_path / "dosya"
    blocker.write_text("klasör değil")
    await env.ctx.store.set("backup.dir", str(blocker / "alt"))
    with pytest.raises(BackupError):
        await env.svc.create()
    failed = await env.ctx.events.query(EventFilter(types=["backup.failed"]))
    assert len(failed) == 1
    assert failed[0].severity == Severity.high and failed[0].payload["operation"] == "create"


async def test_scheduler_due_logic_and_loop(backup_env: BackupEnv) -> None:
    env = backup_env
    await env.ctx.store.set(SETTING_INTERVAL, 0)
    assert await env.svc.seconds_until_due() is None
    await env.ctx.store.set(SETTING_INTERVAL, 24)
    assert await env.svc.seconds_until_due() == 0.0
    await env.svc.create()
    remaining = await env.svc.seconds_until_due()
    assert remaining is not None and 23.9 * 3600 < remaining <= 24 * 3600

    # Run the real loop with tiny timings: a scheduled backup appears.
    await env.ctx.store.set(SETTING_INTERVAL, 0.0002)  # ~0.7 s
    env.svc.startup_delay = 0
    env.svc.max_sleep = 0.05
    env.svc.start()
    deadline = asyncio.get_running_loop().time() + 10
    while asyncio.get_running_loop().time() < deadline:
        if any(b.reason == "scheduled" for b in await env.svc.list()):
            break
        await asyncio.sleep(0.05)
    else:
        raise AssertionError("scheduled backup was not created")
    await env.svc.stop()
