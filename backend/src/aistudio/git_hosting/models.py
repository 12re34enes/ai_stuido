"""API / internal models of the git hosting module (the cross-module ones live in contracts)."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from aistudio.contracts.flows import FlowMode
from aistudio.contracts.git_hosting import HostingKind, PullRequestStatus


class GitAccount(BaseModel):
    id: str
    kind: HostingKind
    name: str
    api_url: str
    web_url: str
    username: str
    scopes: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class GitAccountCreate(BaseModel):
    kind: HostingKind
    token: str
    # Server address or API URL; empty = github.com / gitlab.com.
    api_url: str | None = None
    name: str | None = None


class HostingUser(BaseModel):
    username: str
    name: str | None = None
    web_url: str | None = None
    scopes: list[str] = Field(default_factory=list)


class RepoHostingInfo(BaseModel):
    repo_id: str
    account_id: str
    account_name: str
    kind: HostingKind
    host: str
    slug: str  # owner/repo or group/sub/project
    web_url: str
    pinned: bool = False


class RemoteRepo(BaseModel):
    full_name: str
    name: str
    web_url: str
    clone_url: str | None = None
    ssh_url: str | None = None
    default_branch: str | None = None
    private: bool = False
    description: str | None = None
    updated_at: datetime | None = None


class Issue(BaseModel):
    number: int
    title: str
    body: str = ""
    state: str = "open"
    url: str
    author: str | None = None
    labels: list[str] = Field(default_factory=list)
    comments: int = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PullRequestSummary(BaseModel):
    number: int
    title: str
    url: str
    head: str
    base: str
    draft: bool = False
    author: str | None = None
    state: Literal["open", "closed", "merged"] = "open"
    updated_at: datetime | None = None


class PullRequestInfo(BaseModel):
    """What a hosting client returns after opening a PR/MR."""

    number: int
    url: str
    title: str
    head: str
    base: str
    draft: bool = False


class PrSnapshot(BaseModel):
    """Contract status plus the extras the watcher needs."""

    status: PullRequestStatus
    web_url: str
    is_fork: bool = False


class WatchInfo(BaseModel):
    id: str
    repo_id: str
    number: int
    workspace_id: str
    task_id: str | None = None
    autofix: bool = True
    status: Literal["active", "stopped"]
    stop_reason: str | None = None
    last_error: str | None = None
    last_polled_at: datetime | None = None
    next_poll_at: datetime | None = None
    active_task_id: str | None = None
    fix_task_ids: list[str] = Field(default_factory=list)
    title: str | None = None
    url: str | None = None
    created_at: datetime


# --------------------------------------------------------------------------- API bodies


class OpenPullRequestBody(BaseModel):
    head: str
    base: str | None = None  # default: repo default branch
    title: str
    body: str = ""
    draft: bool = False


class WatchBody(BaseModel):
    autofix: bool = True
    task_id: str | None = None


class ReplyBody(BaseModel):
    body: str


class PinAccountBody(BaseModel):
    account_id: str | None = None


class IssueTaskBody(BaseModel):
    mode: FlowMode | None = None
    studio_id: str | None = None
    start: bool = True
    base_ref: str | None = None


class TriggerPipelineBody(BaseModel):
    ref: str
    workflow: str | None = None
    variables: dict[str, str] | None = None


class PipelineRunRef(BaseModel):
    run_id: str


class JobLog(BaseModel):
    job_id: str
    log: str
