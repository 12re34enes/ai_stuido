"""GitHub / GitLab integration (spec §13). Implemented in ``aistudio.git_hosting``."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Protocol

from pydantic import BaseModel, Field

HostingKind = Literal["github", "gitlab"]


class PullRequestRef(BaseModel):
    repo_id: str
    number: int
    url: str
    title: str
    head: str
    base: str
    draft: bool = False


class CheckRun(BaseModel):
    name: str
    status: Literal["queued", "in_progress", "completed"]
    conclusion: (
        Literal["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"] | None
    ) = None
    url: str | None = None
    job_id: str | None = None


class ReviewComment(BaseModel):
    id: str
    author: str
    body: str
    path: str | None = None
    line: int | None = None
    created_at: datetime
    resolved: bool = False
    thread_id: str | None = None


class PullRequestStatus(BaseModel):
    ref: PullRequestRef
    state: Literal["open", "closed", "merged"]
    mergeable: bool | None = None
    has_conflicts: bool = False
    checks: list[CheckRun] = Field(default_factory=list)
    review_decision: Literal["approved", "changes_requested", "review_required", "none"] = "none"
    unresolved_comments: list[ReviewComment] = Field(default_factory=list)
    head_sha: str | None = None
    updated_at: datetime | None = None


class GitHostingService(Protocol):
    async def open_pull_request(
        self, repo_id: str, *, head: str, base: str, title: str, body: str, draft: bool = False
    ) -> PullRequestRef: ...
    async def pr_status(self, repo_id: str, number: int) -> PullRequestStatus: ...
    async def watch(self, repo_id: str, number: int, *, task_id: str | None, autofix: bool = True) -> None:
        """PR takibi: on CI failure / review comment / conflict, create fix tasks via FlowEngine."""
        ...

    async def unwatch(self, repo_id: str, number: int) -> None: ...
    async def job_log(self, repo_id: str, job_id: str) -> str: ...
    async def reply_to_comment(self, repo_id: str, number: int, comment_id: str, body: str) -> None: ...
    async def trigger_pipeline(
        self, repo_id: str, *, ref: str, workflow: str | None = None, variables: dict[str, str] | None = None
    ) -> str:
        """GitHub workflow_dispatch / GitLab pipeline; returns a run/pipeline id."""
        ...

    async def pipeline_status(self, repo_id: str, run_id: str) -> CheckRun: ...
