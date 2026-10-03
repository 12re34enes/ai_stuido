"""Deploy profiles, runs, health checks and rollback (spec §14)."""

from __future__ import annotations

import contextlib

import sqlalchemy as sa
from fastapi import APIRouter

from aistudio.contracts.approvals import ApprovalService
from aistudio.contracts.deploy import DeployService
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import StudioError
from aistudio.core.module import Module
from aistudio.deploy import tables
from aistudio.deploy.api import build_router
from aistudio.deploy.service import DeployServiceImpl
from aistudio.deploy.tools import DeployRequestTool


class DeployModule(Module):
    name = "deploy"

    def __init__(self) -> None:
        self.svc: DeployServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        self.svc = DeployServiceImpl(ctx)
        ctx.services.register(DeployService, self.svc)  # type: ignore[type-abstract]
        ctx.services.register(DeployServiceImpl, self.svc)
        registry = ctx.services.maybe(ToolRegistry)  # type: ignore[type-abstract]
        if registry is not None:
            registry.register(DeployRequestTool(self.svc))

    async def start(self, ctx: AppContext) -> None:
        # Runs interrupted by a restart can never finish: mark them failed (never resume a deploy silently).
        runs = tables.deploy_runs
        approvals = ctx.services.maybe(ApprovalService)  # type: ignore[type-abstract]
        with contextlib.suppress(Exception):
            async with ctx.db.connect() as conn:
                pending = (
                    await conn.execute(
                        sa.select(runs.c.approval_id).where(
                            runs.c.status.in_(("pending_approval", "running")), runs.c.approval_id.is_not(None)
                        )
                    )
                ).all()
            for (approval_id,) in pending:
                if approvals is not None:
                    with contextlib.suppress(StudioError):
                        await approvals.cancel(approval_id, "Deploy yarıda kaldı (uygulama yeniden başladı).")
            async with ctx.db.begin() as conn:
                await conn.execute(
                    runs.update()
                    .where(runs.c.status.in_(("pending_approval", "running")))
                    .values(
                        status="failed", error="Uygulama yeniden başladığı için yarıda kaldı.", finished_at=utcnow()
                    )
                )

    def router(self) -> APIRouter:
        def get_svc() -> DeployServiceImpl:
            assert self.svc is not None, "deploy module not set up"
            return self.svc

        return build_router(get_svc)

    async def stop(self) -> None:
        if self.svc is not None:
            await self.svc.shutdown()


module = DeployModule()
