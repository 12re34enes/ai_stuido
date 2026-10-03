"""Deploy profile configuration (validated per kind) and run records."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from aistudio.contracts.common import Environment

DeployKind = Literal["ci", "ssh", "command"]
RunStatus = Literal["pending_approval", "running", "succeeded", "failed", "rejected", "cancelled"]
FINAL_STATUSES: frozenset[str] = frozenset({"succeeded", "failed", "rejected", "cancelled"})


class CiConfig(BaseModel):
    repo_id: str = Field(min_length=1)
    workflow: str | None = None  # GitHub workflow file/name; None for GitLab pipelines
    variables: dict[str, str] = Field(default_factory=dict)
    poll_interval_s: float = Field(default=10.0, gt=0, le=600)
    timeout_s: float = Field(default=3600.0, gt=0, le=6 * 3600)


class SshConfig(BaseModel):
    host_ids: list[str] = Field(min_length=1)
    script: str = Field(min_length=1, max_length=100_000)
    strategy: Literal["sequential", "rolling"] = "sequential"
    batch_size: int = Field(default=1, ge=1, le=100)  # rolling: hosts deployed in parallel per batch
    cwd: str | None = None
    timeout_s: float = Field(default=1800.0, gt=0, le=6 * 3600)


class CommandConfig(BaseModel):
    command: str = Field(min_length=1, max_length=100_000)
    cwd: str | None = None
    env: dict[str, str] = Field(default_factory=dict)
    timeout_s: float = Field(default=1800.0, gt=0, le=6 * 3600)


class HealthCheck(BaseModel):
    url: str | None = None  # HTTP GET must answer 2xx (or one of expect_status) within timeout_s
    command: str | None = None  # exit code 0; locally, or on host_id over SSH
    host_id: str | None = None
    expect_status: list[int] | None = None
    timeout_s: float = Field(default=60.0, gt=0, le=3600)
    interval_s: float = Field(default=3.0, gt=0, le=300)

    @model_validator(mode="after")
    def _one_target(self) -> HealthCheck:
        if bool(self.url) == bool(self.command):
            raise ValueError("Sağlık kontrolü için yalnız birini belirtin: url veya command.")
        if self.url and not self.url.startswith(("http://", "https://")):
            raise ValueError("Sağlık kontrolü adresi http:// veya https:// ile başlamalı.")
        return self


CONFIG_MODELS: dict[str, type[BaseModel]] = {"ci": CiConfig, "ssh": SshConfig, "command": CommandConfig}


class DeployProfileCreate(BaseModel):
    workspace_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=120)
    kind: DeployKind
    environment: Environment
    config: dict[str, Any] = Field(default_factory=dict)
    health_check: dict[str, Any] | None = None
    rollback: dict[str, Any] | None = None


class DeployProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    environment: Environment | None = None
    config: dict[str, Any] | None = None
    health_check: dict[str, Any] | None = None
    rollback: dict[str, Any] | None = None


class DeployRun(BaseModel):
    id: str
    profile_id: str
    workspace_id: str
    profile_name: str
    kind: DeployKind
    environment: Environment
    status: RunStatus
    ref: str | None = None
    summary: str | None = None
    actor: str
    task_id: str | None = None
    run_id: str | None = None
    approval_id: str | None = None
    approved_by: str | None = None
    health_ok: bool | None = None
    external_id: str | None = None
    rollback_of: str | None = None
    rollback_available: bool = False
    error: str | None = None
    log: str = ""
    started_at: datetime
    finished_at: datetime | None = None


class RunDeployRequest(BaseModel):
    ref: str | None = Field(default=None, max_length=255)
    summary: str | None = Field(default=None, max_length=20_000)
