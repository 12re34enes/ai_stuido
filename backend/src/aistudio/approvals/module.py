from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from aistudio.approvals.service import ApprovalServiceImpl
from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalService, ApprovalStatus
from aistudio.core.context import AppContext
from aistudio.core.module import Module


class DecisionBody(BaseModel):
    approve: bool
    note: str | None = None
    channel: str = "app"
    decision_payload: dict[str, Any] | None = None


class ApprovalsModule(Module):
    name = "approvals"

    def __init__(self) -> None:
        self.svc: ApprovalServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        self.svc = ApprovalServiceImpl(ctx.db, ctx.events, ctx.store)
        ctx.services.register(ApprovalService, self.svc)  # type: ignore[type-abstract]

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/approvals", tags=["approvals"])

        def svc() -> ApprovalServiceImpl:
            assert self.svc is not None
            return self.svc

        @r.get("", response_model=list[Approval])
        async def list_approvals(
            status: ApprovalStatus | None = ApprovalStatus.pending,
            workspace_id: str | None = None,
            limit: int = 200,
            task_id: str | None = None,
            run_id: str | None = None,
            kind: ApprovalKind | None = None,
        ) -> list[Approval]:
            return await svc().list(
                status=status, workspace_id=workspace_id, limit=limit, task_id=task_id, run_id=run_id, kind=kind
            )

        @r.get("/{approval_id}", response_model=Approval)
        async def get_approval(approval_id: str) -> Approval:
            return await svc().get(approval_id)

        @r.post("/{approval_id}/decision", response_model=Approval)
        async def decide(approval_id: str, body: DecisionBody) -> Approval:
            return await svc().decide(
                approval_id,
                approve=body.approve,
                decided_by="user",
                channel=body.channel,
                note=body.note,
                decision_payload=body.decision_payload,
            )

        return r


module = ApprovalsModule()
