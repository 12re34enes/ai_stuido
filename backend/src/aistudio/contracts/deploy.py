"""Deploy profiles (spec §14). Implemented in ``aistudio.deploy``."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from aistudio.contracts.common import Environment


class DeployProfile(BaseModel):
    id: str
    workspace_id: str
    name: str
    kind: Literal["ci", "ssh", "command"]
    environment: Environment
    # ci: {"repo_id", "workflow" (GitHub file/name) | None, "variables": {...}}
    # ssh: {"host_ids": [...], "script": "...", "strategy": "sequential"|"rolling", "cwd": "..."}
    # command: {"command": "...", "cwd": "..."}
    config: dict[str, Any] = Field(default_factory=dict)
    health_check: dict[str, Any] | None = None  # {"url": "..."} or {"command": "...", "host_id": ...}
    rollback: dict[str, Any] | None = None  # same shape as config for the rollback action
    created_at: datetime


class DeployResult(BaseModel):
    id: str
    profile_id: str
    environment: Environment
    status: Literal["succeeded", "failed", "rejected", "cancelled"]
    ref: str | None = None
    log: str = ""
    health_ok: bool | None = None
    approved_by: str | None = None
    started_at: datetime
    finished_at: datetime | None = None


class DeployService(Protocol):
    async def get_profile(self, profile_id: str) -> DeployProfile: ...
    async def deploy(
        self,
        profile_id: str,
        *,
        ref: str | None,
        actor: str,
        task_id: str | None = None,
        run_id: str | None = None,
        summary: str | None = None,
    ) -> DeployResult:
        """Production always requires an explicit (locked) approval first."""
        ...

    async def rollback(self, deploy_id: str, *, actor: str) -> DeployResult: ...
