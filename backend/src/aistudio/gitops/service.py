"""WorktreeManager implementation (spec §7, §18).

Safety rules with the user's repositories:

* Agent work happens only in worktrees under studiod's worktree root on ``aistudio/...`` branches.
* Merges never check anything out: trees come from ``merge-tree --write-tree``, commits from
  ``commit-tree`` and the target branch moves with a compare-and-swap ``update-ref``. The only
  time the user's working tree is touched is when the target branch is checked out and clean:
  then it is advanced with ``git merge --ff-only`` (never anything that could lose work).
* Checkpoints snapshot through a temporary index; the user's index and HEAD are never touched.
"""

from __future__ import annotations

import asyncio
import builtins
import contextlib
import logging
import posixpath
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field

from aistudio.contracts.agents import AgentManager
from aistudio.contracts.common import Location
from aistudio.contracts.engine import FlowEngine
from aistudio.contracts.gitops import Checkpoint, DiffResult, FileOverlap, MergePreview, MergeResult, Worktree
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.remote import RemoteService
from aistudio.contracts.workspaces import Repo, WorkspaceService
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, NotFound, StudioError, Unavailable, ValidationFailed
from aistudio.core.events import ET, Severity
from aistudio.core.ids import new_id
from aistudio.core.text import slugify
from aistudio.gitops import git, settings
from aistudio.gitops.git import DiffLimits, MergeTreeResult
from aistudio.gitops.runner import AISTUDIO_IDENTITY, GitCommandError, GitRunner, LocalGitRunner, TransportGitRunner
from aistudio.gitops.settings import float_setting
from aistudio.gitops.tables import checkpoints as cp_t
from aistudio.gitops.tables import worktrees as wt_t

log = logging.getLogger("aistudio.gitops")

MergeStrategy = Literal["merge", "squash", "cherry_pick"]
WorktreeStatus = Literal["active", "merged", "abandoned", "removed"]

CHECKPOINT_REF_PREFIX = "refs/aistudio/checkpoints"
REMOTE_ROOT = ".aistudio/worktrees"  # relative to the SSH user's home
DEFAULT_COMMAND_OUTPUT = 200_000
_CAS_ATTEMPTS = 3

# Module-specific event types (cross-module ones live in core.events.ET).
EV_WORKTREE_CREATED = "gitops.worktree.created"
EV_WORKTREE_COMMITTED = "gitops.worktree.committed"
EV_WORKTREE_MERGED = "gitops.worktree.merged"
EV_MERGE_CONFLICT = "gitops.merge.conflict"
EV_WORKTREE_PUSHED = "gitops.worktree.pushed"
EV_WORKTREE_REMOVED = "gitops.worktree.removed"
EV_WORKTREE_ABANDONED = "gitops.worktree.abandoned"
EV_CHECKPOINT_RESTORED = "gitops.checkpoint.restored"
EV_CLEANUP = "gitops.cleanup"


class PairCheck(BaseModel):
    """Would the current states of two worktrees conflict if both were merged?"""

    repo_id: str
    worktree_ids: list[str]
    clean: bool
    conflicts: list[str] = Field(default_factory=list)


class CleanupReport(BaseModel):
    removed: list[str] = Field(default_factory=list)
    abandoned: list[str] = Field(default_factory=list)
    pruned_repos: int = 0
    errors: dict[str, str] = Field(default_factory=dict)


class BranchInfo(BaseModel):
    name: str  # "main" / "origin/main"
    ref: str
    sha: str
    remote: str | None = None
    upstream: str | None = None
    subject: str = ""
    committed_at: Any = None
    checked_out: bool = False
    is_default: bool = False


class RepoBranches(BaseModel):
    repo_id: str
    default_branch: str
    local: list[BranchInfo] = Field(default_factory=list)
    remote: list[BranchInfo] = Field(default_factory=list)


@dataclass
class _Rec:
    """A worktree plus the repo location it was created from."""

    wt: Worktree
    repo_path: str
    host_id: str | None


def _row_to_rec(row: Any) -> _Rec:
    loc = row["location"] or {}
    wt = Worktree(
        id=row["id"],
        repo_id=row["repo_id"],
        workspace_id=row["workspace_id"],
        path=row["path"],
        branch=row["branch"],
        base_ref=row["base_ref"],
        base_sha=row["base_sha"],
        location=Location(**loc) if loc else Location(),
        run_id=row["run_id"],
        task_id=row["task_id"],
        label=row["label"],
        status=row["status"],
        created_at=row["created_at"],
    )
    return _Rec(wt=wt, repo_path=row["repo_path"], host_id=row["host_id"])


def _row_to_checkpoint(row: Any) -> Checkpoint:
    return Checkpoint(
        id=row["id"],
        run_id=row["run_id"],
        node_id=row["node_id"],
        label=row["label"],
        refs=dict(row["refs"] or {}),
        memory_commit=row["memory_commit"],
        created_at=row["created_at"],
    )


class WorktreeManagerImpl:
    def __init__(self, ctx: AppContext, *, diff_limits: DiffLimits | None = None) -> None:
        from aistudio.gitops.watcher import ConflictWatcher

        self._ctx = ctx
        self._local = LocalGitRunner(ctx.masker)
        self._versions: dict[str, tuple[int, int, int]] = {}
        self._wt_locks: dict[str, asyncio.Lock] = {}
        self._repo_locks: dict[str, asyncio.Lock] = {}
        self._alloc_lock = asyncio.Lock()
        self._reserved: set[str] = set()
        self._stop = asyncio.Event()
        self._tasks: list[asyncio.Task[Any]] = []
        self.diff_limits = diff_limits or DiffLimits()
        self.max_command_output = DEFAULT_COMMAND_OUTPUT
        self.watcher = ConflictWatcher(self, ctx)

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self._stop.clear()
        self.watcher.reset()
        self._tasks = [
            self._ctx.spawn(self.watcher.run(), name="gitops.conflict_watch"),
            self._ctx.spawn(self.watcher.watch_files(self._ctx.settings.paths.worktrees), name="gitops.fs_watch"),
            self._ctx.spawn(self._cleanup_loop(), name="gitops.cleanup"),
        ]

    async def stop(self) -> None:
        self._stop.set()
        self.watcher.stop()
        if not self._tasks:
            return
        _, pending = await asyncio.wait(self._tasks, timeout=5)
        for t in pending:
            t.cancel()
        for t in pending:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._tasks = []

    # ------------------------------------------------------------------ helpers
    def _wt_lock(self, worktree_id: str) -> asyncio.Lock:
        return self._wt_locks.setdefault(worktree_id, asyncio.Lock())

    def _repo_lock(self, repo_key: str) -> asyncio.Lock:
        return self._repo_locks.setdefault(repo_key, asyncio.Lock())

    async def runner(self, host_id: str | None) -> GitRunner:
        if host_id is None:
            return self._local
        remote = self._ctx.services.maybe(RemoteService)  # type: ignore[type-abstract]
        if remote is None:
            raise Unavailable("Uzak bağlantı servisi hazır değil.")
        transport = await remote.transport(host_id)
        return TransportGitRunner(transport, self._ctx.masker, host_id=host_id)

    async def _version(self, r: GitRunner, cwd: str) -> tuple[int, int, int]:
        key = r.host_id or "local"
        if key not in self._versions:
            self._versions[key] = await git.git_version(r, cwd)
        return self._versions[key]

    async def _merge_base_flag(self, r: GitRunner, cwd: str) -> bool:
        return (await self._version(r, cwd))[:2] >= git.MERGE_BASE_FLAG_VERSION

    async def _root(self, r: GitRunner) -> str:
        if r.kind == "local":
            return str(self._ctx.settings.paths.worktrees)
        return posixpath.join(await r.home(), REMOTE_ROOT)

    async def _load(self, worktree_id: str) -> _Rec:
        async with self._ctx.db.connect() as conn:
            row = (await conn.execute(sa.select(wt_t).where(wt_t.c.id == worktree_id))).mappings().first()
        if row is None:
            raise NotFound("Worktree bulunamadı.", details={"worktree_id": worktree_id})
        return _row_to_rec(row)

    async def _load_live(self, worktree_id: str) -> _Rec:
        rec = await self._load(worktree_id)
        if rec.wt.status == "removed":
            raise Conflict("Bu worktree kaldırılmış.", details={"worktree_id": worktree_id})
        return rec

    async def _set_status(self, worktree_id: str, status: WorktreeStatus, **extra: Any) -> None:
        async with self._ctx.db.begin() as conn:
            await conn.execute(
                wt_t.update().where(wt_t.c.id == worktree_id).values(status=status, updated_at=utcnow(), **extra)
            )

    async def _emit(self, type_: str, rec: _Rec | None, payload: dict[str, Any], **kw: Any) -> None:
        if rec is not None:
            kw.setdefault("workspace_id", rec.wt.workspace_id)
            kw.setdefault("run_id", rec.wt.run_id)
            kw.setdefault("task_id", rec.wt.task_id)
        await self._ctx.events.append(type_, payload, **kw)

    async def _repo(self, repo_id: str) -> Repo | None:
        svc = self._ctx.services.maybe(WorkspaceService)  # type: ignore[type-abstract]
        if svc is None:
            return None
        try:
            return await svc.get_repo(repo_id)
        except NotFound:
            return None

    async def _task_slug(self, task_id: str | None) -> str:
        if not task_id:
            return "manual"
        suffix = slugify(task_id.rsplit("_", 1)[-1][-6:], fallback="x")
        engine = self._ctx.services.maybe(FlowEngine)  # type: ignore[type-abstract]
        if engine is not None:
            try:
                task = await engine.get_task(task_id)
                return f"{slugify(task.title, max_len=32, fallback='gorev')}-{suffix}"
            except Exception:
                log.debug("task %s not resolvable for slug", task_id, exc_info=True)
        return f"task-{suffix}"

    # ------------------------------------------------------------------ create / read
    async def create(
        self,
        repo_id: str,
        *,
        base_ref: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        label: str = "agent",
        location: Location | None = None,
    ) -> Worktree:
        ws_svc = self._ctx.services.get(WorkspaceService)  # type: ignore[type-abstract]
        repo = await ws_svc.get_repo(repo_id)
        workspace = await ws_svc.get(repo.workspace_id)
        if location is not None:
            wanted_host = location.host_id if location.kind == "remote" else None
            if wanted_host != repo.host_id:
                raise ValidationFailed("Worktree, reponun bulunduğu konumda oluşturulmalı.")
        r = await self.runner(repo.host_id)
        await self._version(r, repo.path)
        ref = (base_ref or repo.default_branch).strip()
        base_sha = await git.rev_parse(r, repo.path, ref) if ref and not ref.startswith("-") else None
        if base_sha is None:
            raise ValidationFailed(f"Başlangıç referansı bulunamadı: {ref}", details={"base_ref": ref})
        task_slug = await self._task_slug(task_id)
        label_slug = slugify(label, max_len=32, fallback="agent")
        parent = posixpath.join(await self._root(r), workspace.slug, task_slug)
        host_key = repo.host_id or "local"

        async with self._alloc_lock:
            n = 1
            while True:
                branch = f"aistudio/{task_slug}/{label_slug}-{n}"
                path = posixpath.join(parent, f"{label_slug}-{n}")
                keys = {f"path:{host_key}:{path}", f"branch:{repo.id}:{branch}"}
                if not await self._name_taken(r, repo, branch, path, keys):
                    break
                n += 1
            self._reserved |= keys
        added = False
        try:
            await r.git("worktree", "add", "--no-track", "-b", branch, path, base_sha, cwd=repo.path, timeout=900)
            added = True
            now = utcnow()
            loc = Location.remote(repo.host_id) if repo.host_id else Location.local()
            wt = Worktree(
                id=new_id("wt"),
                repo_id=repo.id,
                workspace_id=repo.workspace_id,
                path=path,
                branch=branch,
                base_ref=ref,
                base_sha=base_sha,
                location=loc,
                run_id=run_id,
                task_id=task_id,
                label=label,
                status="active",
                created_at=now,
            )
            async with self._ctx.db.begin() as conn:
                await conn.execute(
                    wt_t.insert().values(
                        **wt.model_dump(mode="python", exclude={"location"}),
                        location=loc.model_dump(),
                        repo_path=repo.path,
                        host_id=repo.host_id,
                        updated_at=now,
                    )
                )
        except BaseException:
            if added:  # never leave an untracked worktree/branch behind
                await r.git("worktree", "remove", "--force", path, cwd=repo.path, check=False)
                await r.git("branch", "-D", branch, cwd=repo.path, check=False)
            raise
        finally:
            self._reserved -= keys
        rec = _Rec(wt=wt, repo_path=repo.path, host_id=repo.host_id)
        await self._emit(
            EV_WORKTREE_CREATED,
            rec,
            {
                "worktree_id": wt.id,
                "repo_id": wt.repo_id,
                "branch": wt.branch,
                "path": wt.path,
                "base_ref": wt.base_ref,
                "base_sha": wt.base_sha,
                "label": wt.label,
            },
        )
        self.watcher.poke()
        return wt

    async def _name_taken(self, r: GitRunner, repo: Repo, branch: str, path: str, keys: set[str]) -> bool:
        if keys & self._reserved:
            return True
        async with self._ctx.db.connect() as conn:
            row = (
                await conn.execute(
                    sa.select(wt_t.c.id)
                    .where(
                        sa.or_(
                            sa.and_(wt_t.c.repo_id == repo.id, wt_t.c.branch == branch),
                            sa.and_(
                                wt_t.c.path == path,
                                wt_t.c.host_id.is_(None) if repo.host_id is None else wt_t.c.host_id == repo.host_id,
                            ),
                        )
                    )
                    .limit(1)
                )
            ).first()
        if row is not None:
            return True
        if await r.exists(path):
            return True
        return await git.ref_exists(r, repo.path, f"refs/heads/{branch}")

    async def get(self, worktree_id: str) -> Worktree:
        return (await self._load(worktree_id)).wt

    async def query(
        self,
        *,
        run_id: str | None = None,
        task_id: str | None = None,
        repo_id: str | None = None,
        workspace_id: str | None = None,
        statuses: builtins.list[str] | None = None,
        limit: int | None = 500,
    ) -> builtins.list[Worktree]:
        stmt = sa.select(wt_t).order_by(wt_t.c.created_at.desc())
        if limit is not None:
            stmt = stmt.limit(limit)
        for col, value in (
            (wt_t.c.run_id, run_id),
            (wt_t.c.task_id, task_id),
            (wt_t.c.repo_id, repo_id),
            (wt_t.c.workspace_id, workspace_id),
        ):
            if value is not None:
                stmt = stmt.where(col == value)
        if statuses:
            stmt = stmt.where(wt_t.c.status.in_(statuses))
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [_row_to_rec(r).wt for r in rows]

    async def list(self, *, run_id: str | None = None, active_only: bool = True) -> builtins.list[Worktree]:
        return await self.query(run_id=run_id, statuses=["active"] if active_only else None, limit=None)

    # ------------------------------------------------------------------ inspect / commit
    async def changed_files(self, worktree_id: str) -> builtins.list[str]:
        rec = await self._load_live(worktree_id)
        r = await self.runner(rec.host_id)
        return await git.changed_files(r, rec.wt.path, rec.wt.base_sha)

    async def diff(self, worktree_id: str, *, include_patch: bool = True) -> DiffResult:
        """Base = the worktree's base commit. Head = its HEAD commit when the tree is clean,
        otherwise the tree id of a snapshot of the working state (uncommitted + untracked)."""
        rec = await self._load_live(worktree_id)
        r = await self.runner(rec.host_id)
        tree = await git.snapshot_tree(r, rec.wt.path)
        head = await git.rev_parse(r, rec.wt.path, "HEAD")
        head_tree = await git.rev_parse(r, rec.wt.path, "HEAD", kind="tree")
        target = head if head is not None and tree == head_tree else tree
        return await git.tree_diff(
            r, rec.wt.path, rec.wt.base_sha, target, include_patch=include_patch, limits=self.diff_limits
        )

    async def commit_all(self, worktree_id: str, message: str) -> str | None:
        rec = await self._load_live(worktree_id)
        r = await self.runner(rec.host_id)
        cwd = rec.wt.path
        msg = message.strip() or "AI Studio changes"
        async with self._wt_lock(worktree_id):
            await r.git("add", "-A", cwd=cwd, timeout=900)
            staged = await r.git("diff", "--cached", "--quiet", cwd=cwd, check=False)
            if staged.returncode == 0:
                return None
            if staged.returncode != 1:
                raise GitCommandError(
                    "Git komutu başarısız oldu (git diff).",
                    args=["diff", "--cached", "--quiet"],
                    returncode=staged.returncode,
                    stderr=self._ctx.masker.mask(staged.stderr),
                )
            await r.git(
                "commit",
                "-q",
                "--no-verify",
                "-F",
                "-",
                cwd=cwd,
                env=AISTUDIO_IDENTITY,
                input=msg.encode(),
                timeout=600,
            )
            sha = await git.rev_parse(r, cwd, "HEAD")
        assert sha is not None
        await self._emit(EV_WORKTREE_COMMITTED, rec, {"worktree_id": worktree_id, "sha": sha, "message": msg[:200]})
        self.watcher.poke()
        return sha

    # ------------------------------------------------------------------ merge
    async def _resolve_target(self, rec: _Rec, target_ref: str | None) -> tuple[str, str]:
        name = (target_ref or "").strip()
        if not name:
            repo = await self._repo(rec.wt.repo_id)
            name = repo.default_branch if repo is not None else rec.wt.base_ref
        if name.startswith("refs/heads/"):
            short = name.removeprefix("refs/heads/")
        elif name.startswith("refs/") or name.startswith("-"):
            raise ValidationFailed("Birleştirme hedefi yerel bir branch olmalı.", details={"target_ref": name})
        else:
            short = name
        if short == rec.wt.branch:
            raise ValidationFailed("Worktree kendi branch'ine birleştirilemez.")
        return short, f"refs/heads/{short}"

    async def _branch_sha(self, r: GitRunner, rec: _Rec) -> str:
        sha = await git.rev_parse(r, rec.repo_path, f"refs/heads/{rec.wt.branch}")
        if sha is None:
            raise NotFound("Worktree branch'i bulunamadı.", details={"branch": rec.wt.branch})
        return sha

    async def _target_sha(self, r: GitRunner, rec: _Rec, short: str, full: str) -> str:
        sha = await git.rev_parse(r, rec.repo_path, full)
        if sha is None:
            raise NotFound(f"Hedef branch bulunamadı: {short}", details={"target_ref": short})
        return sha

    async def merge_preview(self, worktree_id: str, target_ref: str | None = None) -> MergePreview:
        rec = await self._load_live(worktree_id)
        r = await self.runner(rec.host_id)
        await self._version(r, rec.repo_path)
        short, full = await self._resolve_target(rec, target_ref)
        target_sha = await self._target_sha(r, rec, short, full)
        src = await self._branch_sha(r, rec)
        result = await git.merge_trees(r, rec.repo_path, target_sha, src)
        if result.clean:
            diff = await git.tree_diff(r, rec.repo_path, target_sha, result.tree, limits=self.diff_limits)
        else:
            mb = (await r.git("merge-base", target_sha, src, cwd=rec.repo_path)).stdout.strip()
            diff = await git.tree_diff(r, rec.repo_path, mb, src, limits=self.diff_limits)
        return MergePreview(
            clean=result.clean, conflicts=result.conflicts, target_ref=short, target_sha=target_sha, diff=diff
        )

    async def merge(
        self,
        worktree_id: str,
        *,
        target_ref: str | None = None,
        strategy: MergeStrategy = "merge",
        message: str | None = None,
    ) -> MergeResult:
        """Merge the worktree branch's commits into ``target_ref`` (default: repo default branch).
        Uncommitted changes are not included. For ``cherry_pick`` each commit keeps its own
        message and author; ``message`` applies to ``merge``/``squash``."""
        if strategy not in ("merge", "squash", "cherry_pick"):
            raise ValidationFailed("Geçersiz birleştirme yöntemi.", details={"strategy": strategy})
        rec = await self._load_live(worktree_id)
        r = await self.runner(rec.host_id)
        await self._version(r, rec.repo_path)
        short, full = await self._resolve_target(rec, target_ref)
        mb_flag = await self._merge_base_flag(r, rec.repo_path)
        via = "update-ref"
        async with self._repo_lock(f"{rec.host_id or 'local'}:{rec.repo_path}"), self._wt_lock(worktree_id):
            for _ in range(_CAS_ATTEMPTS):
                old = await self._target_sha(r, rec, short, full)
                src = await self._branch_sha(r, rec)
                new, conflicts, note = await self._compute_merge(
                    r,
                    rec,
                    strategy=strategy,
                    target_sha=old,
                    src_sha=src,
                    short=short,
                    message=message,
                    mb_flag=mb_flag,
                )
                if conflicts:
                    await self._emit(
                        EV_MERGE_CONFLICT,
                        rec,
                        {
                            "worktree_id": worktree_id,
                            "target_ref": short,
                            "strategy": strategy,
                            "conflicts": conflicts[:200],
                        },
                        severity=Severity.normal,
                    )
                    return MergeResult(
                        merged=False,
                        conflicts=conflicts,
                        message=note or f"{len(conflicts)} dosyada çakışma var; birleştirme yapılmadı.",
                    )
                if new is None:  # nothing to merge: the target already contains the changes
                    await self._set_status(worktree_id, "merged", merged_into=short, merged_sha=old)
                    return MergeResult(merged=True, commit_sha=old, message=note)
                advanced, via = await self._advance(r, rec, short=short, full=full, old=old, new=new)
                if advanced:
                    break
            else:
                raise Conflict("Hedef branch birleştirme sırasında sürekli değişti; lütfen tekrar deneyin.")
        await self._set_status(worktree_id, "merged", merged_into=short, merged_sha=new)
        await self._emit(
            EV_WORKTREE_MERGED,
            rec,
            {
                "worktree_id": worktree_id,
                "repo_id": rec.wt.repo_id,
                "branch": rec.wt.branch,
                "target_ref": short,
                "strategy": strategy,
                "commit_sha": new,
                "previous_sha": old,
                "via": via,
            },
        )
        self.watcher.poke()
        result_note = await self._uncommitted_note(r, rec)
        return MergeResult(merged=True, commit_sha=new, message=result_note)

    async def _uncommitted_note(self, r: GitRunner, rec: _Rec) -> str | None:
        try:
            if await r.exists(rec.wt.path) and await git.is_dirty(r, rec.wt.path, untracked=True):
                return "Not: worktree'deki commit edilmemiş değişiklikler birleştirmeye dahil edilmedi."
        except StudioError:
            return None
        return None

    async def _compute_merge(
        self,
        r: GitRunner,
        rec: _Rec,
        *,
        strategy: MergeStrategy,
        target_sha: str,
        src_sha: str,
        short: str,
        message: str | None,
        mb_flag: bool,
    ) -> tuple[str | None, builtins.list[str], str | None]:
        """Returns ``(new_commit | None, conflicts, note)``; ``None`` + no conflicts = no-op."""
        cwd = rec.repo_path
        already = "Değişiklikler zaten hedef branch'te."
        if await git.is_ancestor(r, cwd, src_sha, target_sha):
            return None, [], already
        if strategy in ("merge", "squash"):
            res: MergeTreeResult = await git.merge_trees(r, cwd, target_sha, src_sha)
            if not res.clean:
                return None, res.conflicts, None
            if strategy == "merge":
                msg = message or f"Merge branch '{rec.wt.branch}' into {short}"
                return await git.commit_tree(r, cwd, res.tree, [target_sha, src_sha], msg), [], None
            if res.tree == await git.rev_parse(r, cwd, target_sha, kind="tree"):
                return None, [], already
            log_cp = await r.git("log", "--format=%s", "--max-count=50", f"{target_sha}..{src_sha}", cwd=cwd)
            subjects = [s for s in log_cp.stdout.splitlines() if s.strip()]
            body = "\n".join(f"* {s}" for s in reversed(subjects))
            msg = message or f"Squash merge of {rec.wt.branch}" + (f"\n\n{body}" if body else "")
            return await git.commit_tree(r, cwd, res.tree, [target_sha], msg), [], None

        # cherry_pick: replay each non-merge commit of the branch onto the target.
        commits_cp = await r.git(
            "rev-list", "--reverse", "--topo-order", "--no-merges", f"{target_sha}..{src_sha}", cwd=cwd
        )
        current = target_sha
        for commit in commits_cp.stdout.split():
            parent = await git.rev_parse(r, cwd, f"{commit}^1")
            if parent is None:
                continue
            res = await git.merge_trees(r, cwd, current, commit, base=parent, merge_base_flag=mb_flag)
            if not res.clean:
                return None, res.conflicts, f"{commit[:10]} commit'i uygulanırken çakışma çıktı; birleştirme yapılmadı."
            if res.tree == await git.rev_parse(r, cwd, current, kind="tree"):
                continue  # already applied on the target
            info = await r.git("log", "-1", "--format=%an%x00%ae%x00%aI%x00%B", commit, cwd=cwd)
            name, email, date, body = [*info.stdout.split("\0", 3), "", "", "", ""][:4]
            msg = f"{body.rstrip()}\n\n(cherry picked from commit {commit})"
            author = {"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email, "GIT_AUTHOR_DATE": date}
            current = await git.commit_tree(
                r, cwd, res.tree, [current], msg, env={k: v for k, v in author.items() if v}
            )
        if current == target_sha:
            return None, [], already
        return current, [], None

    async def _advance(self, r: GitRunner, rec: _Rec, *, short: str, full: str, old: str, new: str) -> tuple[bool, str]:
        """Move ``full`` from ``old`` to ``new``. Returns ``(False, _)`` when the target moved
        concurrently (caller recomputes)."""
        entries = await git.worktree_list(r, rec.repo_path)
        holder = next((e for e in entries if e.branch == full and not e.bare and not e.prunable), None)
        if holder is not None:
            if await git.is_dirty(r, holder.path, untracked=False):
                raise Conflict(
                    f"Hedef branch '{short}' şu anda '{holder.path}' klasöründe açık ve commit edilmemiş "
                    "değişiklikler içeriyor. Değişiklikleri commit edin ya da saklayın (stash), sonra tekrar deneyin.",
                    details={"target_ref": short, "checkout_path": holder.path},
                )
            if await git.rev_parse(r, holder.path, "HEAD") != old:
                return False, "ff-only"
            cp = await r.git("merge", "--ff-only", "--quiet", new, cwd=holder.path, check=False, timeout=600)
            if cp.returncode != 0:
                raise Conflict(
                    f"Hedef branch '{short}' '{holder.path}' klasöründe açık; hızlı ileri alma yapılamadı.",
                    details={
                        "target_ref": short,
                        "checkout_path": holder.path,
                        "stderr": self._ctx.masker.mask(cp.stderr),
                    },
                )
            return True, "ff-only"
        cp = await r.git(
            "update-ref", "-m", f"aistudio: merge {rec.wt.branch}", full, new, old, cwd=rec.repo_path, check=False
        )
        if cp.returncode == 0:
            return True, "update-ref"
        if await git.rev_parse(r, rec.repo_path, full) != old:
            return False, "update-ref"
        raise GitCommandError(
            "Git komutu başarısız oldu (git update-ref).",
            args=["update-ref", full, new, old],
            returncode=cp.returncode,
            stderr=self._ctx.masker.mask(cp.stderr),
        )

    # ------------------------------------------------------------------ push / remove / commands
    async def push(self, worktree_id: str, *, remote: str = "origin", remote_branch: str | None = None) -> None:
        rec = await self._load_live(worktree_id)
        r = await self.runner(rec.host_id)
        # Only remotes configured in the repo: never push to an arbitrary URL.
        remotes = (await r.git("remote", cwd=rec.wt.path)).stdout.split()
        if remote not in remotes:
            raise ValidationFailed(f"Uzak repo tanımlı değil: {remote}", details={"remote": remote})
        if remote_branch:
            dst = remote_branch if remote_branch.startswith("refs/heads/") else f"refs/heads/{remote_branch}"
            valid = await r.git("check-ref-format", dst, cwd=rec.wt.path, check=False)
            if remote_branch.startswith("-") or valid.returncode != 0:
                raise ValidationFailed("Geçersiz uzak branch adı.", details={"remote_branch": remote_branch})
            args = ["push", "--porcelain", remote, f"HEAD:{dst}"]
        else:
            dst = f"refs/heads/{rec.wt.branch}"
            args = ["push", "--porcelain", "-u", remote, rec.wt.branch]
        async with self._wt_lock(worktree_id):
            cp = await r.git(*args, cwd=rec.wt.path, check=False, timeout=600)
        if cp.returncode != 0:
            text = f"{cp.stdout}\n{cp.stderr}"
            stderr = self._ctx.masker.mask(cp.stderr.strip())[-4000:]
            if "[rejected]" in text or "non-fast-forward" in text or "fetch first" in text:
                raise Conflict(
                    "Push reddedildi: uzak branch'te yerelde olmayan commit'ler var.",
                    details={"remote": remote, "ref": dst, "stderr": stderr},
                )
            raise GitCommandError("Push başarısız oldu.", args=args, returncode=cp.returncode, stderr=stderr)
        await self._emit(
            EV_WORKTREE_PUSHED, rec, {"worktree_id": worktree_id, "remote": remote, "ref": dst, "branch": rec.wt.branch}
        )

    async def remove(self, worktree_id: str, *, force: bool = False, delete_branch: bool | None = None) -> None:
        """Remove the worktree directory. ``delete_branch`` None = delete only when merged
        (unmerged agent work stays on its branch); ``force`` also discards uncommitted changes."""
        rec = await self._load(worktree_id)
        if rec.wt.status == "removed":
            return
        r = await self.runner(rec.host_id)
        async with self._wt_lock(worktree_id):
            if await r.exists(rec.wt.path):
                if rec.wt.path.rstrip("/") == rec.repo_path.rstrip("/"):
                    raise ValidationFailed("Ana repo klasörü kaldırılamaz.")
                args = ["worktree", "remove", *(["--force"] if force else []), rec.wt.path]
                cp = await r.git(*args, cwd=rec.repo_path, check=False, timeout=600)
                if cp.returncode != 0:
                    if "use --force" in cp.stderr or "modified or untracked" in cp.stderr:
                        raise Conflict(
                            "Worktree'de kaydedilmemiş değişiklikler var. Kaldırmak için zorla kaldırmayı seçin.",
                            details={"worktree_id": worktree_id},
                        )
                    if "is not a working tree" in cp.stderr and await self._owned_path(r, rec.wt.path):
                        await r.remove_tree(rec.wt.path)
                    else:
                        raise GitCommandError(
                            "Worktree kaldırılamadı.",
                            args=args,
                            returncode=cp.returncode,
                            stderr=self._ctx.masker.mask(cp.stderr),
                        )
            await r.git("worktree", "prune", cwd=rec.repo_path, check=False)
            do_delete = delete_branch if delete_branch is not None else rec.wt.status == "merged"
            branch_deleted = False
            if do_delete:
                cp = await r.git("branch", "-D", rec.wt.branch, cwd=rec.repo_path, check=False)
                branch_deleted = cp.returncode == 0
                if not branch_deleted:
                    log.info("branch %s kept: %s", rec.wt.branch, cp.stderr.strip())
                await self._delete_checkpoint_refs(r, rec)
            await self._set_status(worktree_id, "removed")
        await self._emit(
            EV_WORKTREE_REMOVED,
            rec,
            {"worktree_id": worktree_id, "branch": rec.wt.branch, "branch_deleted": branch_deleted, "forced": force},
        )
        self.watcher.poke()

    async def _owned_path(self, r: GitRunner, path: str) -> bool:
        root = (await self._root(r)).rstrip("/") + "/"
        return posixpath.normpath(path).startswith(root)

    async def _delete_checkpoint_refs(self, r: GitRunner, rec: _Rec) -> None:
        cp = await r.git("for-each-ref", "--format=%(refname)", CHECKPOINT_REF_PREFIX, cwd=rec.repo_path, check=False)
        refs = [ref for ref in cp.stdout.splitlines() if ref.endswith(f"/{rec.wt.id}")]
        if refs:
            stdin = "".join(f"delete {ref}\n" for ref in refs).encode()
            await r.git("update-ref", "--stdin", cwd=rec.repo_path, input=stdin, check=False)

    async def abandon(self, worktree_id: str) -> Worktree:
        """Mark a worktree as abandoned; cleanup removes it after the retention period."""
        rec = await self._load_live(worktree_id)
        if rec.wt.status != "abandoned":
            await self._set_status(worktree_id, "abandoned")
            await self._emit(EV_WORKTREE_ABANDONED, rec, {"worktree_id": worktree_id, "branch": rec.wt.branch})
            self.watcher.poke()
        return await self.get(worktree_id)

    async def run_command(self, worktree_id: str, command: str, *, timeout: float = 1800) -> tuple[int, str]:
        rec = await self._load_live(worktree_id)
        r = await self.runner(rec.host_id)
        result = await r.shell(command, cwd=rec.wt.path, timeout=timeout, max_output=self.max_command_output)
        output = result.output
        masked = (
            await asyncio.to_thread(self._ctx.masker.mask, output)
            if len(output) > 50_000
            else self._ctx.masker.mask(output)
        )
        return result.exit_code, masked

    # ------------------------------------------------------------------ checkpoints
    async def checkpoint(
        self,
        *,
        run_id: str | None,
        node_id: str | None,
        label: str,
        worktree_ids: builtins.list[str],
        workspace_id: str | None = None,
    ) -> Checkpoint:
        cp_id = new_id("cp")
        recs = [await self._load_live(wid) for wid in dict.fromkeys(worktree_ids)]

        async def snap(rec: _Rec) -> tuple[str, str]:
            r = await self.runner(rec.host_id)
            async with self._wt_lock(rec.wt.id):
                sha = await git.snapshot_commit(r, rec.wt.path, f"aistudio checkpoint {cp_id}: {label}")
                await r.git("update-ref", f"{CHECKPOINT_REF_PREFIX}/{cp_id}/{rec.wt.id}", sha, cwd=rec.repo_path)
            return rec.wt.id, sha

        refs = dict(await asyncio.gather(*(snap(rec) for rec in recs)))
        ws_ids = {rec.wt.workspace_id for rec in recs}
        ws_id = workspace_id or (next(iter(ws_ids)) if len(ws_ids) == 1 else None)
        memory_commit: str | None = None
        memory = self._ctx.services.maybe(MemoryService)  # type: ignore[type-abstract]
        if memory is not None and ws_id is not None:
            try:
                memory_commit = await memory.head(ws_id)
            except Exception:
                log.warning("memory head unavailable for checkpoint %s", cp_id, exc_info=True)
        checkpoint = Checkpoint(
            id=cp_id,
            run_id=run_id,
            node_id=node_id,
            label=label,
            refs=refs,
            memory_commit=memory_commit,
            created_at=utcnow(),
        )
        async with self._ctx.db.begin() as conn:
            await conn.execute(cp_t.insert().values(**checkpoint.model_dump(mode="python"), workspace_id=ws_id))
        await self._ctx.events.append(
            ET.CHECKPOINT_CREATED,
            {
                "checkpoint_id": cp_id,
                "label": label,
                "node_id": node_id,
                "refs": refs,
                "memory_commit": memory_commit,
            },
            workspace_id=ws_id,
            run_id=run_id,
        )
        return checkpoint

    async def get_checkpoint(self, checkpoint_id: str) -> Checkpoint:
        async with self._ctx.db.connect() as conn:
            row = (await conn.execute(sa.select(cp_t).where(cp_t.c.id == checkpoint_id))).mappings().first()
        if row is None:
            raise NotFound("Checkpoint bulunamadı.", details={"checkpoint_id": checkpoint_id})
        return _row_to_checkpoint(row)

    async def list_checkpoints(
        self, *, run_id: str | None = None, workspace_id: str | None = None, limit: int = 200
    ) -> builtins.list[Checkpoint]:
        stmt = sa.select(cp_t).order_by(cp_t.c.created_at.desc()).limit(limit)
        if run_id is not None:
            stmt = stmt.where(cp_t.c.run_id == run_id)
        if workspace_id is not None:
            stmt = stmt.where(cp_t.c.workspace_id == workspace_id)
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [_row_to_checkpoint(r) for r in rows]

    async def restore(self, checkpoint_id: str) -> Checkpoint:
        """Reset every worktree of the checkpoint: branch back to the snapshot's parent, files to
        the snapshot (unstaged), files created later removed; ignored files are kept."""
        async with self._ctx.db.connect() as conn:
            row = (await conn.execute(sa.select(cp_t).where(cp_t.c.id == checkpoint_id))).mappings().first()
        if row is None:
            raise NotFound("Checkpoint bulunamadı.", details={"checkpoint_id": checkpoint_id})
        checkpoint = _row_to_checkpoint(row)
        ws_id: str | None = row["workspace_id"]

        # Validate everything first so a restore never stops half-way for a predictable reason.
        plan: builtins.list[tuple[_Rec, GitRunner, str, str]] = []
        for wid, snap in checkpoint.refs.items():
            rec = await self._load(wid)
            if rec.wt.status == "removed":
                raise Conflict(
                    "Checkpoint'teki bir worktree kaldırılmış; geri yüklenemez.", details={"worktree_id": wid}
                )
            r = await self.runner(rec.host_id)
            if not await r.exists(rec.wt.path):
                raise Conflict("Worktree klasörü bulunamadı; geri yüklenemez.", details={"worktree_id": wid})
            if await git.rev_parse(r, rec.wt.path, snap) is None:
                raise Conflict("Checkpoint verisi repoda bulunamadı.", details={"worktree_id": wid})
            parent = await git.rev_parse(r, rec.wt.path, f"{snap}^1")
            if parent is None:
                raise Conflict("Checkpoint verisi bozuk.", details={"worktree_id": wid})
            plan.append((rec, r, snap, parent))

        for rec, r, snap, parent in plan:
            cwd = rec.wt.path
            async with self._wt_lock(rec.wt.id):
                await r.git("read-tree", "-u", "--reset", snap, cwd=cwd, timeout=900)
                await r.git("clean", "-f", "-d", "-q", cwd=cwd, timeout=600)
                await r.git("reset", "-q", "--mixed", parent, cwd=cwd, timeout=600)
            if rec.wt.status != "active":
                await self._set_status(rec.wt.id, "active", merged_into=None, merged_sha=None)

        memory = self._ctx.services.maybe(MemoryService)  # type: ignore[type-abstract]
        if checkpoint.memory_commit and ws_id and memory is not None:
            await memory.restore(ws_id, checkpoint.memory_commit)

        async with self._ctx.db.begin() as conn:
            await conn.execute(cp_t.update().where(cp_t.c.id == checkpoint_id).values(restored_at=utcnow()))
        await self._ctx.events.append(
            EV_CHECKPOINT_RESTORED,
            {
                "checkpoint_id": checkpoint_id,
                "label": checkpoint.label,
                "node_id": checkpoint.node_id,
                "worktree_ids": list(checkpoint.refs),
                "memory_commit": checkpoint.memory_commit,
            },
            workspace_id=ws_id,
            run_id=checkpoint.run_id,
            actor="system",
        )
        self.watcher.poke()
        return checkpoint

    # ------------------------------------------------------------------ conflicts
    async def overlaps(self) -> builtins.list[FileOverlap]:
        return await self.watcher.overlaps()

    async def check_pair(self, worktree_a: str, worktree_b: str) -> PairCheck:
        """Cheap merge-tree check: would the two worktrees' current states (incl. uncommitted
        work) conflict with each other?"""
        a = await self._load_live(worktree_a)
        b = await self._load_live(worktree_b)
        if a.wt.repo_id != b.wt.repo_id or a.host_id != b.host_id:
            raise ValidationFailed("Worktree'ler aynı repoya ait olmalı.")
        r = await self.runner(a.host_id)
        snap_a = await git.snapshot_commit(r, a.wt.path, "aistudio: pair check")
        snap_b = await git.snapshot_commit(r, b.wt.path, "aistudio: pair check")
        res = await git.merge_trees(r, a.repo_path, snap_a, snap_b)
        return PairCheck(
            repo_id=a.wt.repo_id, worktree_ids=[worktree_a, worktree_b], clean=res.clean, conflicts=res.conflicts
        )

    async def session_map(self) -> dict[str, builtins.list[str]]:
        """worktree_id -> active session ids (empty when the agents module is unavailable)."""
        manager = self._ctx.services.maybe(AgentManager)  # type: ignore[type-abstract]
        if manager is None:
            return {}
        try:
            sessions = await manager.list(active_only=True)
        except Exception:
            log.debug("agent sessions unavailable", exc_info=True)
            return {}
        out: dict[str, builtins.list[str]] = {}
        for s in sessions:
            if s.worktree_id:
                out.setdefault(s.worktree_id, []).append(s.id)
        return out

    # ------------------------------------------------------------------ branches
    async def branches(self, repo_id: str, *, include_aistudio: bool = False) -> RepoBranches:
        ws_svc = self._ctx.services.get(WorkspaceService)  # type: ignore[type-abstract]
        repo = await ws_svc.get_repo(repo_id)
        r = await self.runner(repo.host_id)
        checked_out = {e.branch for e in await git.worktree_list(r, repo.path) if e.branch and not e.prunable}
        result = RepoBranches(repo_id=repo_id, default_branch=repo.default_branch)
        for ref in await git.list_refs(r, repo.path, "refs/heads", "refs/remotes"):
            if ref.ref.startswith("refs/heads/"):
                name = ref.ref.removeprefix("refs/heads/")
                if name.startswith("aistudio/") and not include_aistudio:
                    continue
                result.local.append(
                    BranchInfo(
                        name=name,
                        ref=ref.ref,
                        sha=ref.sha,
                        upstream=ref.upstream,
                        subject=ref.subject,
                        committed_at=ref.committed_at,
                        checked_out=ref.ref in checked_out,
                        is_default=name == repo.default_branch,
                    )
                )
            else:
                name = ref.ref.removeprefix("refs/remotes/")
                remote_name, _, branch_name = name.partition("/")
                if branch_name.startswith("aistudio/") and not include_aistudio:
                    continue
                result.remote.append(
                    BranchInfo(
                        name=name,
                        ref=ref.ref,
                        sha=ref.sha,
                        remote=remote_name,
                        subject=ref.subject,
                        committed_at=ref.committed_at,
                        is_default=branch_name == repo.default_branch,
                    )
                )
        return result

    # ------------------------------------------------------------------ cleanup
    async def cleanup(self) -> CleanupReport:
        """Remove merged/abandoned worktrees older than ``gitops.retention_hours``; mark active
        worktrees whose directory disappeared as abandoned; prune stale git worktree records."""
        report = CleanupReport()
        hours = max(0.0, await float_setting(self._ctx.store, settings.RETENTION_HOURS))
        cutoff = utcnow() - timedelta(hours=hours)
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(sa.select(wt_t).where(wt_t.c.status != "removed"))).mappings().all()
        recs = [_row_to_rec(row) for row in rows]
        updated = {row["id"]: row["updated_at"] for row in rows}
        repos: dict[tuple[str | None, str], GitRunner] = {}
        for rec in recs:
            try:
                r = await self.runner(rec.host_id)
                repos[(rec.host_id, rec.repo_path)] = r
                if rec.wt.status == "active" and not await r.exists(rec.wt.path):
                    await r.git("worktree", "prune", cwd=rec.repo_path, check=False)
                    await self._set_status(rec.wt.id, "abandoned")
                    await self._emit(
                        EV_WORKTREE_ABANDONED,
                        rec,
                        {"worktree_id": rec.wt.id, "branch": rec.wt.branch, "reason": "missing_directory"},
                    )
                    report.abandoned.append(rec.wt.id)
                    continue
                if rec.wt.status in ("merged", "abandoned") and updated[rec.wt.id] <= cutoff:
                    delete_branch = rec.wt.status == "merged" or await self._branch_has_no_work(r, rec)
                    await self.remove(rec.wt.id, force=True, delete_branch=delete_branch)
                    report.removed.append(rec.wt.id)
            except Exception as exc:  # one broken repo/host must not stop the sweep
                log.warning("cleanup failed for worktree %s", rec.wt.id, exc_info=True)
                report.errors[rec.wt.id] = str(getattr(exc, "message", exc))
        for (host_id, repo_path), r in repos.items():
            try:
                if await r.exists(repo_path):
                    await r.git("worktree", "prune", cwd=repo_path, check=False)
                    report.pruned_repos += 1
            except Exception:
                log.debug("prune failed for %s:%s", host_id, repo_path, exc_info=True)
        if report.removed or report.abandoned:
            await self._ctx.events.append(EV_CLEANUP, report.model_dump())
        return report

    async def _branch_has_no_work(self, r: GitRunner, rec: _Rec) -> bool:
        """Abandoned branches are deleted only when they hold no commits beyond their base."""
        sha = await git.rev_parse(r, rec.repo_path, f"refs/heads/{rec.wt.branch}")
        return sha is None or sha == rec.wt.base_sha

    async def _cleanup_loop(self) -> None:
        delay = 60.0
        while not self._stop.is_set():
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
                return
            except TimeoutError:
                pass
            try:
                await self.cleanup()
            except Exception:
                log.exception("worktree cleanup failed")
            delay = max(60.0, await float_setting(self._ctx.store, settings.CLEANUP_INTERVAL_MINUTES) * 60)
