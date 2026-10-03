"""Helpers for git hosting tests: a workspace repo with a remote, fake engine, fake clock.

Tokens are assembled at runtime so no credential-looking literal is ever committed.
"""

from __future__ import annotations

import subprocess
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from aistudio.contracts.engine import Run, Task, TaskCreate
from aistudio.contracts.flows import FlowGraph, FlowMode
from aistudio.contracts.git_hosting import CheckRun, PullRequestRef, PullRequestStatus, ReviewComment
from aistudio.contracts.workspaces import Repo, WorkspaceService
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound
from aistudio.git_hosting.client import HostingClient
from aistudio.git_hosting.models import (
    HostingUser,
    Issue,
    PrSnapshot,
    PullRequestInfo,
    PullRequestSummary,
    RemoteRepo,
)
from aistudio.workspaces.service import RepoCreate, WorkspaceCreate, WorkspaceServiceImpl

GH_TOKEN = "-".join(["gh", "test", "token", "alpha", "0001"])
GL_TOKEN = "-".join(["gl", "test", "token", "bravo", "0002"])


class FakeClock:
    def __init__(self, start: datetime | None = None) -> None:
        self.now = start or datetime(2026, 10, 3, 9, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@dataclass
class FakeEngine:
    """Records TaskCreate requests; tests flip task statuses by hand."""

    clock: Callable[[], datetime]
    created: list[TaskCreate] = field(default_factory=list)
    tasks: dict[str, Task] = field(default_factory=dict)

    async def create_task(self, req: TaskCreate) -> Task:
        self.created.append(req)
        now = self.clock()
        task = Task(
            id=f"task_{len(self.created)}",
            workspace_id=req.workspace_id,
            title=req.title,
            prompt=req.prompt,
            mode=req.mode,
            repo_ids=req.repo_ids,
            base_ref=req.base_ref,
            inputs=req.inputs,
            status="queued",
            source=req.source,
            source_ref=req.source_ref,
            created_at=now,
            updated_at=now,
        )
        self.tasks[task.id] = task
        return task

    def set_status(self, task_id: str, status: Any) -> None:
        self.tasks[task_id] = self.tasks[task_id].model_copy(update={"status": status})

    async def get_task(self, task_id: str) -> Task:
        try:
            return self.tasks[task_id]
        except KeyError:
            raise NotFound("Görev bulunamadı.") from None

    async def start(self, task_id: str) -> Run:
        raise NotImplementedError

    async def cancel(self, run_id: str) -> None:
        raise NotImplementedError

    async def retry_node(self, run_id: str, node_id: str) -> None:
        raise NotImplementedError

    async def get_run(self, run_id: str) -> Run:
        raise NotImplementedError

    async def graph_for_mode(self, mode: FlowMode, *, workspace_id: str) -> FlowGraph:
        return FlowGraph()


def set_remote(repo: Path, url: str) -> None:
    subprocess.run(["git", "remote", "add", "origin", url], cwd=repo, check=True, capture_output=True)


async def make_repo(ctx: AppContext, path: Path, remote: str) -> Repo:
    set_remote(path, remote)
    ws_svc = ctx.services.maybe(WorkspaceServiceImpl)
    if ws_svc is None:
        ws_svc = WorkspaceServiceImpl(ctx.db, ctx.events)
        ctx.services.register(WorkspaceService, ws_svc)  # type: ignore[type-abstract]
        ctx.services.register(WorkspaceServiceImpl, ws_svc)
    ws = await ws_svc.create(WorkspaceCreate(name="Test"))
    return await ws_svc.add_repo(ws.id, RepoCreate(path=str(path)))


class FakeHostingClient(HostingClient):
    """In-memory hosting client: tests mutate ``snapshot`` between polls."""

    kind = "github"
    label = "GitHub"

    def __init__(self, clock: Callable[[], datetime]) -> None:
        self.clock = clock
        self.snapshot: PrSnapshot | None = None
        self.logs: dict[str, str] = {}
        self.replies: list[tuple[str, str, str | None]] = []
        self.resolved: list[str] = []
        self.raise_on_snapshot: Exception | None = None
        self.snapshot_calls = 0
        self._next_comment = 7000

    def set_pr(
        self,
        *,
        sha: str = "sha1",
        state: Any = "open",
        checks: list[CheckRun] | None = None,
        comments: list[ReviewComment] | None = None,
        conflicts: bool = False,
        is_fork: bool = False,
        updated_at: datetime | None = None,
    ) -> None:
        ref = PullRequestRef(
            repo_id="",
            number=7,
            url="https://github.com/acme/widgets/pull/7",
            title="Ödeme",
            head="feature",
            base="main",
        )
        self.snapshot = PrSnapshot(
            status=PullRequestStatus(
                ref=ref,
                state=state,
                has_conflicts=conflicts,
                checks=checks or [],
                unresolved_comments=comments or [],
                head_sha=sha,
                updated_at=updated_at,
            ),
            web_url="https://github.com/acme/widgets/pull/7",
            is_fork=is_fork,
        )

    @property
    def blocked_until(self) -> datetime | None:
        return None

    async def current_user(self) -> HostingUser:
        return HostingUser(username="octo")

    async def list_repos(self, *, limit: int = 200) -> list[RemoteRepo]:
        return []

    async def open_pr(self, path: str, *, head: str, base: str, title: str, body: str, draft: bool) -> PullRequestInfo:
        return PullRequestInfo(number=7, url="u", title=title, head=head, base=base, draft=draft)

    async def list_prs(self, path: str, *, limit: int = 50) -> list[PullRequestSummary]:
        return []

    async def pr_snapshot(self, path: str, number: int, *, repo_id: str) -> PrSnapshot:
        self.snapshot_calls += 1
        if self.raise_on_snapshot is not None:
            raise self.raise_on_snapshot
        assert self.snapshot is not None
        snap = self.snapshot.model_copy(deep=True)
        snap.status.ref.repo_id = repo_id
        return snap

    async def job_log(self, path: str, job_id: str) -> str:
        return self.logs.get(job_id, "")

    async def reply_to_comment(
        self, path: str, number: int, comment_id: str, body: str, *, thread_id: str | None = None
    ) -> str:
        self.replies.append((comment_id, body, thread_id))
        self._next_comment += 1
        return str(self._next_comment)

    async def resolve_thread(self, path: str, number: int, thread_id: str) -> None:
        self.resolved.append(thread_id)

    async def trigger_pipeline(
        self, path: str, *, ref: str, workflow: str | None, variables: dict[str, str] | None
    ) -> str:
        return "1"

    async def pipeline_status(self, path: str, run_id: str) -> CheckRun:
        return CheckRun(name="p", status="queued")

    async def list_issues(self, path: str, *, limit: int = 50) -> list[Issue]:
        return []

    async def get_issue(self, path: str, number: int) -> Issue:
        raise NotFound("yok")

    async def aclose(self) -> None:
        return None


def failing(name: str = "test", job_id: str | None = "11") -> CheckRun:
    return CheckRun(name=name, status="completed", conclusion="failure", job_id=job_id, url=f"https://ci/{name}")


def passing(name: str = "test") -> CheckRun:
    return CheckRun(name=name, status="completed", conclusion="success")


def comment(cid: str, thread: str | None, created: datetime, body: str = "Lütfen düzelt.") -> ReviewComment:
    return ReviewComment(id=cid, author="rev", body=body, path="pay.py", line=3, created_at=created, thread_id=thread)
