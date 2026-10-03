"""Central approval inbox (spec §9, §15). Implemented in ``aistudio.approvals``."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any, Protocol

from pydantic import BaseModel, Field

from aistudio.core.events import Severity


class ApprovalKind(StrEnum):
    plan = "plan"
    memory = "memory"
    remote_command = "remote_command"
    db_write = "db_write"
    deploy = "deploy"
    merge = "merge"
    final = "final"  # Kullanıcı son onayı
    tool_permission = "tool_permission"
    question = "question"  # ask_user tool: payload.answer comes back in decision_payload
    budget = "budget"  # e.g. allow same-provider review when the other provider is exhausted
    custom = "custom"


class ApprovalStatus(StrEnum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"
    expired = "expired"
    cancelled = "cancelled"


class Approval(BaseModel):
    id: str
    kind: ApprovalKind
    title: str
    summary: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    severity: Severity = Severity.high
    production: bool = False
    status: ApprovalStatus = ApprovalStatus.pending
    workspace_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    session_id: str | None = None
    requested_by: str
    decided_by: str | None = None
    decision_note: str | None = None
    decision_payload: dict[str, Any] | None = None
    channel: str | None = None  # "app" | "menubar" | "notification" | "telegram" | "slack" | ...
    created_at: datetime
    decided_at: datetime | None = None
    expires_at: datetime | None = None


class ApprovalRequest(BaseModel):
    kind: ApprovalKind
    title: str
    summary: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    severity: Severity = Severity.high
    production: bool = False
    workspace_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    session_id: str | None = None
    requested_by: str = "system"
    expires_at: datetime | None = None


class ApprovalService(Protocol):
    async def request(self, req: ApprovalRequest) -> Approval: ...
    async def wait(self, approval_id: str, timeout: float | None = None) -> Approval:
        """Block until decided (or expired/cancelled). Raises TimeoutError on timeout."""
        ...

    async def request_and_wait(self, req: ApprovalRequest, timeout: float | None = None) -> Approval: ...
    async def decide(
        self,
        approval_id: str,
        *,
        approve: bool,
        decided_by: str = "user",
        channel: str = "app",
        note: str | None = None,
        decision_payload: dict[str, Any] | None = None,
    ) -> Approval:
        """Production approvals from a non-app channel raise PermissionDenied unless the
        ``safety.remote_production_approvals`` setting is enabled."""
        ...

    async def cancel(self, approval_id: str, reason: str | None = None) -> Approval: ...
    async def get(self, approval_id: str) -> Approval: ...
    async def list(
        self,
        *,
        status: ApprovalStatus | None = ApprovalStatus.pending,
        workspace_id: str | None = None,
        limit: int = 200,
    ) -> list[Approval]: ...
