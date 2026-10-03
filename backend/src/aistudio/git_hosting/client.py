"""The internal interface both hosting clients implement (GitHub REST/GraphQL, GitLab REST v4).

``path`` is the repo slug: ``owner/repo`` on GitHub, ``group/sub/project`` on GitLab.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime

from aistudio.contracts.git_hosting import CheckRun, HostingKind
from aistudio.git_hosting.models import (
    HostingUser,
    Issue,
    PrSnapshot,
    PullRequestInfo,
    PullRequestSummary,
    RemoteRepo,
)

# Conclusions that count as a CI failure the watcher should try to fix.
FAILING_CONCLUSIONS = frozenset({"failure", "timed_out"})


class HostingClient(ABC):
    kind: HostingKind
    label: str

    @abstractmethod
    async def current_user(self) -> HostingUser: ...

    @abstractmethod
    async def list_repos(self, *, limit: int = 200) -> list[RemoteRepo]: ...

    @abstractmethod
    async def open_pr(
        self, path: str, *, head: str, base: str, title: str, body: str, draft: bool
    ) -> PullRequestInfo: ...

    @abstractmethod
    async def list_prs(self, path: str, *, limit: int = 50) -> list[PullRequestSummary]: ...

    @abstractmethod
    async def pr_snapshot(self, path: str, number: int, *, repo_id: str) -> PrSnapshot: ...

    @abstractmethod
    async def job_log(self, path: str, job_id: str) -> str:
        """Raw job log text (the service cleans, truncates and masks it)."""
        ...

    @abstractmethod
    async def reply_to_comment(
        self, path: str, number: int, comment_id: str, body: str, *, thread_id: str | None = None
    ) -> str:
        """Reply in the comment's thread; returns the id of the created comment."""
        ...

    @abstractmethod
    async def resolve_thread(self, path: str, number: int, thread_id: str) -> None: ...

    @abstractmethod
    async def trigger_pipeline(
        self, path: str, *, ref: str, workflow: str | None, variables: dict[str, str] | None
    ) -> str: ...

    @abstractmethod
    async def pipeline_status(self, path: str, run_id: str) -> CheckRun: ...

    @abstractmethod
    async def list_issues(self, path: str, *, limit: int = 50) -> list[Issue]: ...

    @abstractmethod
    async def get_issue(self, path: str, number: int) -> Issue: ...

    @abstractmethod
    async def aclose(self) -> None: ...

    @property
    @abstractmethod
    def blocked_until(self) -> datetime | None: ...


def parse_dt(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
