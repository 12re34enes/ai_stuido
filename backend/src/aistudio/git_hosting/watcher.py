"""PR takibi (spec §13): poll watched PRs/MRs and start fix tasks.

Per poll of a watched PR:

1. merged / closed -> ``pr.merged`` / ``pr.closed`` and stop watching.
2. Follow the running fix task (only one at a time per PR, so pushes never race). When a
   review-fix task finished and pushed, reply to and resolve the threads it addressed.
3. Merge conflict with the base -> a task to merge the base and resolve (once per head sha).
4. CI failure on the head sha -> a task with the failing checks and their log tails (once per
   head sha; at most ``git.autofix_max_attempts`` consecutive attempts, then ``pr.autofix_failed``).
5. New unresolved review comments -> a task to address them (each comment handled once).

Deduplication keys are persisted in ``git_watches.state`` *before* the task is created, so a
crash can never lead to a duplicate task. Polling is adaptive: ``git.poll_active_seconds`` while
CI is pending, a fix task runs or the PR changed recently, ``git.poll_idle_seconds`` otherwise.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field

from aistudio.contracts.engine import FlowEngine, Task, TaskCreate
from aistudio.contracts.git_hosting import CheckRun, ReviewComment
from aistudio.contracts.workspaces import WorkspaceService
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound, StudioError
from aistudio.core.events import Severity
from aistudio.core.ids import new_id
from aistudio.git_hosting.client import FAILING_CONCLUSIONS
from aistudio.git_hosting.fixflow import (
    FixKind,
    build_fix_graph,
    ci_prompt,
    ci_title,
    conflict_prompt,
    conflict_title,
    review_prompt,
    review_title,
)
from aistudio.git_hosting.http import RateLimited
from aistudio.git_hosting.models import PrSnapshot, WatchInfo
from aistudio.git_hosting.tables import git_watches

if TYPE_CHECKING:
    from aistudio.git_hosting.service import GitHostingServiceImpl

log = logging.getLogger(__name__)

_MAX_KEYS = 500
_RECENT_ACTIVITY = timedelta(minutes=30)


class ActiveTask(BaseModel):
    id: str
    kind: FixKind
    head_sha: str | None = None
    comment_ids: list[str] = Field(default_factory=list)
    created_at: datetime


class WatchState(BaseModel):
    title: str | None = None
    url: str | None = None
    head_branch: str | None = None
    base_branch: str | None = None
    head_sha: str | None = None
    ci: Literal["none", "pending", "passed", "failed"] = "none"
    first_failure_sha: str | None = None
    first_failure_at: datetime | None = None
    ci_fix_attempts: int = 0
    had_failure: bool = False  # CI failed since it was last green (for pr.ci_passed "recovered")
    notified: list[str] = Field(default_factory=list)  # events already emitted ("ci_failed:<sha>")
    handled: list[str] = Field(default_factory=list)  # fix tasks already created ("ci:<sha>", "comment:<id>")
    own_comment_ids: list[str] = Field(default_factory=list)  # our replies; never treated as review input
    agent_replied: list[str] = Field(default_factory=list)  # comments the agent answered via pr_comment_reply
    review_decision: str = "none"
    active_task: ActiveTask | None = None
    fix_tasks: list[dict[str, Any]] = Field(default_factory=list)

    def add(self, field: Literal["notified", "handled", "own_comment_ids", "agent_replied"], key: str) -> None:
        values: list[str] = getattr(self, field)
        if key not in values:
            values.append(key)
            del values[:-_MAX_KEYS]


@dataclass
class _Row:
    id: str
    repo_id: str
    number: int
    workspace_id: str
    task_id: str | None
    autofix: bool
    status: str
    stop_reason: str | None
    state: WatchState
    last_error: str | None
    last_polled_at: datetime | None
    next_poll_at: datetime | None
    created_at: datetime

    @classmethod
    def from_mapping(cls, m: Any) -> _Row:
        data = dict(m)
        data.pop("updated_at", None)
        data["state"] = WatchState.model_validate(data.get("state") or {})
        return cls(**data)

    def info(self) -> WatchInfo:
        st = self.state
        return WatchInfo(
            id=self.id,
            repo_id=self.repo_id,
            number=self.number,
            workspace_id=self.workspace_id,
            task_id=self.task_id,
            autofix=self.autofix,
            status="active" if self.status == "active" else "stopped",
            stop_reason=self.stop_reason,
            last_error=self.last_error,
            last_polled_at=self.last_polled_at,
            next_poll_at=self.next_poll_at,
            active_task_id=st.active_task.id if st.active_task else None,
            fix_task_ids=[str(t["id"]) for t in st.fix_tasks],
            title=st.title,
            url=st.url,
            created_at=self.created_at,
        )


@dataclass
class _Tunables:
    active: float
    idle: float
    max_attempts: int
    ci_settle: float
    review_settle: float
    log_chars: int
    log_jobs: int
    reply_template: str


class PrWatcher:
    def __init__(self, svc: GitHostingServiceImpl, ctx: AppContext, *, clock: Callable[[], datetime]) -> None:
        self._svc = svc
        self._ctx = ctx
        self._clock = clock
        self._locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._wake = asyncio.Event()
        self._sem = asyncio.Semaphore(4)
        self.tick_seconds = 5.0

    # ------------------------------------------------------------------ persistence
    async def _load(self, watch_id: str) -> _Row | None:
        async with self._ctx.db.connect() as conn:
            m = (await conn.execute(sa.select(git_watches).where(git_watches.c.id == watch_id))).mappings().first()
        return _Row.from_mapping(m) if m else None

    async def _find(self, repo_id: str, number: int) -> _Row | None:
        async with self._ctx.db.connect() as conn:
            m = (
                (
                    await conn.execute(
                        sa.select(git_watches).where(git_watches.c.repo_id == repo_id, git_watches.c.number == number)
                    )
                )
                .mappings()
                .first()
            )
        return _Row.from_mapping(m) if m else None

    async def _save(self, row: _Row, **cols: Any) -> None:
        values: dict[str, Any] = {"state": row.state.model_dump(mode="json"), "updated_at": self._clock(), **cols}
        async with self._ctx.db.begin() as conn:
            await conn.execute(git_watches.update().where(git_watches.c.id == row.id).values(**values))
        for k, v in cols.items():
            if hasattr(row, k):
                setattr(row, k, v)

    async def list(self, *, active_only: bool = False) -> list[WatchInfo]:
        stmt = sa.select(git_watches).order_by(git_watches.c.created_at.desc())
        if active_only:
            stmt = stmt.where(git_watches.c.status == "active")
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [_Row.from_mapping(r).info() for r in rows]

    async def get(self, repo_id: str, number: int) -> WatchInfo:
        row = await self._find(repo_id, number)
        if row is None:
            raise NotFound("Bu PR takip edilmiyor.")
        return row.info()

    async def _tunables(self) -> _Tunables:
        s = self._svc.setting
        return _Tunables(
            active=float(await s("git.poll_active_seconds")),
            idle=float(await s("git.poll_idle_seconds")),
            max_attempts=int(await s("git.autofix_max_attempts")),
            ci_settle=float(await s("git.ci_settle_seconds")),
            review_settle=float(await s("git.review_settle_seconds")),
            log_chars=int(await s("git.fix_log_chars")),
            log_jobs=int(await s("git.fix_log_jobs")),
            reply_template=str(await s("git.autofix_reply")),
        )

    async def _emit(
        self,
        row: _Row,
        type_: str,
        payload: dict[str, Any] | None = None,
        *,
        severity: Severity = Severity.info,
        task_id: str | None = None,
    ) -> None:
        st = row.state
        body = {"repo_id": row.repo_id, "number": row.number, "url": st.url, "title": st.title, "watch_id": row.id}
        body.update(payload or {})
        await self._ctx.events.append(
            type_, body, severity=severity, workspace_id=row.workspace_id, task_id=task_id or row.task_id
        )

    # ------------------------------------------------------------------ public API
    async def watch(self, repo_id: str, number: int, *, task_id: str | None, autofix: bool) -> WatchInfo:
        repo = await self._ctx.services.get(WorkspaceService).get_repo(repo_id)  # type: ignore[type-abstract]
        await self._svc.resolve(repo_id)  # fail early when no account matches the repo
        now = self._clock()
        row = await self._find(repo_id, number)
        if row is None:
            row = _Row(
                id=new_id("watch"),
                repo_id=repo_id,
                number=number,
                workspace_id=repo.workspace_id,
                task_id=task_id,
                autofix=autofix,
                status="active",
                stop_reason=None,
                state=WatchState(),
                last_error=None,
                last_polled_at=None,
                next_poll_at=now,
                created_at=now,
            )
            async with self._ctx.db.begin() as conn:
                await conn.execute(
                    git_watches.insert().values(
                        id=row.id,
                        repo_id=repo_id,
                        number=number,
                        workspace_id=repo.workspace_id,
                        task_id=task_id,
                        autofix=autofix,
                        status="active",
                        state=row.state.model_dump(mode="json"),
                        next_poll_at=now,
                        created_at=now,
                        updated_at=now,
                    )
                )
        else:
            async with self._locks[row.id]:
                row = await self._load(row.id) or row
                await self._save(
                    row,
                    status="active",
                    stop_reason=None,
                    autofix=autofix,
                    task_id=task_id or row.task_id,
                    next_poll_at=now,
                    last_error=None,
                )
        await self._emit(row, "pr.watch_started", {"autofix": autofix})
        self._wake.set()
        return row.info()

    async def unwatch(self, repo_id: str, number: int) -> None:
        row = await self._find(repo_id, number)
        if row is None:
            raise NotFound("Bu PR takip edilmiyor.")
        if row.status != "active":
            return
        async with self._locks[row.id]:
            await self._save(row, status="stopped", stop_reason="user")
        await self._emit(row, "pr.watch_stopped", {"reason": "user"})

    async def note_reply(
        self, repo_id: str, number: int, *, replied_to: str, own_comment_id: str, by_agent: bool
    ) -> None:
        row = await self._find(repo_id, number)
        if row is None:
            return
        async with self._locks[row.id]:
            row = await self._load(row.id)
            if row is None:
                return
            if own_comment_id:
                row.state.add("own_comment_ids", own_comment_id)
            if by_agent:
                row.state.add("agent_replied", replied_to)
            await self._save(row)

    def wake(self) -> None:
        self._wake.set()

    # ------------------------------------------------------------------ loop
    async def run(self) -> None:
        while True:
            self._wake.clear()
            try:
                due = await self._due(self._clock())
                if due:
                    await asyncio.gather(*(self._guarded(w) for w in due))
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("PR watcher loop failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=self.tick_seconds)

    async def _due(self, now: datetime) -> list[str]:
        t = git_watches
        stmt = sa.select(t.c.id).where(
            t.c.status == "active", sa.or_(t.c.next_poll_at.is_(None), t.c.next_poll_at <= now)
        )
        async with self._ctx.db.connect() as conn:
            return [str(r[0]) for r in (await conn.execute(stmt)).all()]

    async def _guarded(self, watch_id: str) -> None:
        async with self._sem:
            try:
                await self.poll(watch_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("polling watch %s failed", watch_id)

    # ------------------------------------------------------------------ one poll
    async def poll(self, watch_id: str) -> None:
        async with self._locks[watch_id]:
            row = await self._load(watch_id)
            if row is None or row.status != "active":
                return
            tun = await self._tunables()
            now = self._clock()
            try:
                snap = await self._svc.snapshot(row.repo_id, row.number)
            except RateLimited as e:
                await self._save(row, last_polled_at=now, next_poll_at=max(e.retry_at, now + timedelta(seconds=5)))
                return
            except StudioError as e:
                await self._record_error(row, e.message, now, tun)
                return
            status = snap.status
            st = row.state
            st.title, st.url = status.ref.title, snap.web_url or status.ref.url
            st.head_branch, st.base_branch, st.head_sha = status.ref.head, status.ref.base, status.head_sha
            if status.state in ("merged", "closed"):
                await self._finish(row, status.state)
                return
            error: str | None = None
            try:
                await self._follow_active_task(row, snap, tun)
                await self._handle_conflict(row, snap)
                await self._handle_ci(row, snap, tun, now)
                await self._handle_reviews(row, snap, tun, now)
            except StudioError as e:
                error = e.message
            pending = any(c.status != "completed" for c in status.checks)
            recent = status.updated_at is not None and now - status.updated_at < _RECENT_ACTIVITY
            interval = tun.active if (st.active_task is not None or pending or recent) else tun.idle
            st.review_decision = status.review_decision
            if error is not None:
                await self._record_error(row, error, now, tun)
                return
            await self._save(row, last_polled_at=now, next_poll_at=now + timedelta(seconds=interval), last_error=None)

    async def _record_error(self, row: _Row, message: str, now: datetime, tun: _Tunables) -> None:
        changed = message != row.last_error
        await self._save(row, last_polled_at=now, next_poll_at=now + timedelta(seconds=tun.idle), last_error=message)
        if changed:
            await self._emit(row, "pr.watch_error", {"error": message}, severity=Severity.normal)

    async def _finish(self, row: _Row, state: str) -> None:
        if state == "merged":
            await self._emit(row, "pr.merged", {"head_sha": row.state.head_sha}, severity=Severity.normal)
        else:
            await self._emit(row, "pr.closed", {"head_sha": row.state.head_sha})
        await self._save(row, status="stopped", stop_reason=state, last_polled_at=self._clock(), last_error=None)

    # ------------------------------------------------------------------ fix task bookkeeping
    async def _follow_active_task(self, row: _Row, snap: PrSnapshot, tun: _Tunables) -> None:
        st = row.state
        active = st.active_task
        if active is None:
            return
        engine = self._ctx.services.maybe(FlowEngine)  # type: ignore[type-abstract]
        if engine is None:
            return
        try:
            task = await engine.get_task(active.id)
        except NotFound:
            st.active_task = None
            return
        if task.status == "completed":
            st.active_task = None
            pushed = bool(snap.status.head_sha) and snap.status.head_sha != active.head_sha
            if active.kind == "review" and pushed:
                await self._reply_and_resolve(row, snap, active, tun)
            elif active.kind == "ci" and not pushed:
                await self._emit(
                    row,
                    "pr.autofix_failed",
                    {"kind": "ci", "reason": "no_change", "fix_task_id": active.id, "attempts": st.ci_fix_attempts},
                    severity=Severity.high,
                    task_id=active.id,
                )
        elif task.status == "failed":
            st.active_task = None
            await self._emit(
                row,
                "pr.autofix_failed",
                {
                    "kind": active.kind,
                    "reason": "task_failed",
                    "fix_task_id": active.id,
                    "attempts": st.ci_fix_attempts,
                },
                severity=Severity.high,
                task_id=active.id,
            )
        elif task.status == "cancelled":
            st.active_task = None

    async def _reply_and_resolve(self, row: _Row, snap: PrSnapshot, active: ActiveTask, tun: _Tunables) -> None:
        st = row.state
        sha = (snap.status.head_sha or "")[:7]
        text = tun.reply_template.replace("{sha}", sha)
        wanted = set(active.comment_ids)
        threads: dict[str, list[ReviewComment]] = {}
        for c in snap.status.unresolved_comments:
            if c.id in wanted:
                threads.setdefault(c.thread_id or c.id, []).append(c)
        if not threads:
            return
        resolved = await self._svc.resolve(row.repo_id)
        for key, comments in threads.items():
            if any(c.id in st.agent_replied for c in comments):
                continue  # the agent answered with reasoning; the reviewer decides
            root = min(comments, key=lambda c: c.created_at)
            try:
                created = await self._svc.post_reply(resolved, row.number, root.id, text, root.thread_id)
                if created:
                    st.add("own_comment_ids", created)
                if root.thread_id:
                    await resolved.client.resolve_thread(resolved.slug, row.number, root.thread_id)
            except StudioError as e:
                log.warning("could not reply/resolve %s on PR %s: %s", key, row.number, e.message)

    async def _create_fix(
        self,
        row: _Row,
        snap: PrSnapshot,
        kind: FixKind,
        *,
        keys: list[str],
        title: str,
        prompt: str,
        inputs: dict[str, Any],
        comment_ids: list[str] | None = None,
    ) -> Task:
        engine = self._ctx.services.get(FlowEngine)  # type: ignore[type-abstract]
        st = row.state
        status = snap.status
        for k in keys:
            st.add("handled", k)
        await self._save(row)  # mark first: a crash after create_task must not lead to a duplicate
        mask = self._ctx.masker.mask
        req = TaskCreate(
            workspace_id=row.workspace_id,
            title=mask(title),
            prompt=mask(prompt),
            graph=build_fix_graph(kind),
            repo_ids=[row.repo_id],
            base_ref=status.ref.head,
            inputs={
                "push_branch": status.ref.head,
                "pr_number": row.number,
                "pr_url": snap.web_url or status.ref.url,
                "head_sha": status.head_sha,
                "base_branch": status.ref.base,
                **self._ctx.masker.mask_obj(inputs),
            },
            source="pr_watch",
            source_ref={
                "repo_id": row.repo_id,
                "pr": row.number,
                "watch_id": row.id,
                "kind": kind,
                "head_sha": status.head_sha,
            },
        )
        try:
            task = await engine.create_task(req)
        except Exception:
            st.handled = [k for k in st.handled if k not in keys]
            await self._save(row)
            raise
        now = self._clock()
        st.active_task = ActiveTask(
            id=task.id, kind=kind, head_sha=status.head_sha, comment_ids=comment_ids or [], created_at=now
        )
        st.fix_tasks.append({"id": task.id, "kind": kind, "head_sha": status.head_sha, "created_at": now.isoformat()})
        del st.fix_tasks[:-50]
        await self._save(row)
        return task

    def _can_fix(self, row: _Row, snap: PrSnapshot) -> bool:
        return row.autofix and not snap.is_fork and row.state.active_task is None

    # ------------------------------------------------------------------ conflicts
    async def _handle_conflict(self, row: _Row, snap: PrSnapshot) -> None:
        status, st = snap.status, row.state
        sha = status.head_sha
        if not status.has_conflicts or not sha:
            return
        key = f"conflict:{sha}"
        task: Task | None = None
        if key not in st.handled and self._can_fix(row, snap):
            task = await self._create_fix(
                row,
                snap,
                "conflict",
                keys=[key],
                title=conflict_title(row.number, status.ref.base),
                prompt=conflict_prompt(
                    number=row.number, title=status.ref.title, head=status.ref.head, base=status.ref.base
                ),
                inputs={},
            )
        if key not in st.notified:
            st.add("notified", key)
            await self._emit(
                row,
                "pr.conflict",
                {"head_sha": sha, "base": status.ref.base, "fix_task_id": task.id if task else None},
                severity=Severity.normal,
            )

    # ------------------------------------------------------------------ CI
    async def _collect_logs(self, row: _Row, failing: list[CheckRun], tun: _Tunables) -> dict[str, str]:
        logs: dict[str, str] = {}
        for check in [c for c in failing if c.job_id][: max(0, tun.log_jobs)]:
            assert check.job_id is not None
            try:
                logs[check.name] = await self._svc.job_log(row.repo_id, check.job_id, max_chars=tun.log_chars)
            except StudioError as e:
                logs[check.name] = f"(log alınamadı: {e.message})"
        return logs

    async def _handle_ci(self, row: _Row, snap: PrSnapshot, tun: _Tunables, now: datetime) -> None:
        status, st = snap.status, row.state
        sha = status.head_sha
        checks = status.checks
        if not sha or not checks:
            st.ci = "none"
            return
        pending = [c for c in checks if c.status != "completed"]
        failing = [c for c in checks if c.status == "completed" and c.conclusion in FAILING_CONCLUSIONS]
        if failing:
            if st.first_failure_sha != sha or st.first_failure_at is None:
                st.first_failure_sha, st.first_failure_at = sha, now
            settled = not pending or (now - st.first_failure_at).total_seconds() >= tun.ci_settle
            if not settled:
                st.ci = "pending"
                return
            st.ci = "failed"
            st.had_failure = True
            task: Task | None = None
            key = f"ci:{sha}"
            if key not in st.handled and self._can_fix(row, snap):
                if st.ci_fix_attempts >= tun.max_attempts:
                    if f"exhausted:{sha}" not in st.notified:
                        st.add("notified", f"exhausted:{sha}")
                        await self._emit(
                            row,
                            "pr.autofix_failed",
                            {"kind": "ci", "reason": "max_attempts", "attempts": st.ci_fix_attempts, "head_sha": sha},
                            severity=Severity.high,
                        )
                else:
                    logs = await self._collect_logs(row, failing, tun)
                    task = await self._create_fix(
                        row,
                        snap,
                        "ci",
                        keys=[key],
                        title=ci_title(row.number, failing),
                        prompt=ci_prompt(
                            number=row.number,
                            title=status.ref.title,
                            head=status.ref.head,
                            sha=sha,
                            failing=failing,
                            logs=logs,
                        ),
                        inputs={
                            "failing_checks": [c.model_dump(mode="json") for c in failing],
                            "logs": logs,
                        },
                    )
                    st.ci_fix_attempts += 1
            if f"ci_failed:{sha}" not in st.notified:
                st.add("notified", f"ci_failed:{sha}")
                await self._emit(
                    row,
                    "pr.ci_failed",
                    {
                        "head_sha": sha,
                        "failing_checks": [c.name for c in failing],
                        "fix_task_id": task.id if task else None,
                        "autofix": row.autofix,
                    },
                    severity=Severity.high,
                )
            return
        if pending:
            st.ci = "pending"
            return
        recovered = st.had_failure
        st.ci = "passed"
        st.had_failure = False
        st.ci_fix_attempts = 0
        st.first_failure_sha = st.first_failure_at = None
        if f"ci_passed:{sha}" not in st.notified:
            st.add("notified", f"ci_passed:{sha}")
            await self._emit(
                row,
                "pr.ci_passed",
                {"head_sha": sha, "recovered": recovered},
                severity=Severity.normal if recovered else Severity.info,
            )

    # ------------------------------------------------------------------ reviews
    async def _handle_reviews(self, row: _Row, snap: PrSnapshot, tun: _Tunables, now: datetime) -> None:
        status, st = snap.status, row.state
        comments = [c for c in status.unresolved_comments if c.id not in st.own_comment_ids]
        fresh = [c for c in comments if f"comment:{c.id}" not in st.notified]
        todo = [c for c in comments if f"comment:{c.id}" not in st.handled]
        task: Task | None = None
        newest = max((c.created_at for c in todo), default=None)
        settled = newest is None or (now - newest).total_seconds() >= tun.review_settle
        if todo and settled and self._can_fix(row, snap):
            task = await self._create_fix(
                row,
                snap,
                "review",
                keys=[f"comment:{c.id}" for c in todo],
                title=review_title(row.number, len(todo)),
                prompt=review_prompt(number=row.number, title=status.ref.title, head=status.ref.head, comments=todo),
                inputs={"comments": [c.model_dump(mode="json") for c in todo]},
                comment_ids=[c.id for c in todo],
            )
        decision_changed = status.review_decision != st.review_decision and status.review_decision in (
            "changes_requested",
            "approved",
        )
        if fresh or decision_changed:
            for c in fresh:
                st.add("notified", f"comment:{c.id}")
            await self._emit(
                row,
                "pr.review",
                {
                    "comments": len(fresh),
                    "authors": sorted({c.author for c in fresh}),
                    "review_decision": status.review_decision,
                    "fix_task_id": task.id if task else None,
                },
                severity=Severity.normal,
            )
