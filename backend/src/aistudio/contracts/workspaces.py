"""Workspaces and repos. Implemented in ``aistudio.workspaces`` (foundation)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol

from pydantic import BaseModel, Field


class RepoCommands(BaseModel):
    """Commands studiod runs for the build/test gate. Empty = not defined (gate skips it)."""

    install: str | None = None
    lint: str | None = None
    typecheck: str | None = None
    test: str | None = None
    build: str | None = None

    def defined(self) -> dict[str, str]:
        return {k: v for k, v in self.model_dump().items() if v}


class Repo(BaseModel):
    id: str
    workspace_id: str
    name: str
    path: str
    host_id: str | None = None
    remote_url: str | None = None
    provider: str | None = None  # github | gitlab
    default_branch: str = "main"
    commands: RepoCommands = Field(default_factory=RepoCommands)
    created_at: datetime


class Workspace(BaseModel):
    id: str
    name: str
    slug: str
    color: str = "#C96442"
    archived: bool = False
    settings: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime


class WorkspaceService(Protocol):
    async def get(self, workspace_id: str) -> Workspace: ...
    async def list(self, *, include_archived: bool = False) -> list[Workspace]: ...
    async def repos(self, workspace_id: str) -> list[Repo]: ...
    async def get_repo(self, repo_id: str) -> Repo: ...
