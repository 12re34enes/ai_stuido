"""Limits module: subscription limit tracking, task budgets and usage attribution (spec §17).

Service: ``LimitService`` (:class:`aistudio.limits.service.LimitServiceImpl`).

Settings:
    limits.refresh_minutes   how often adapters' free limit probes run (default 5, 0 = off)
    limits.warning_percent   ``limit.warning`` threshold (default 80)

API (``/api/limits``):
    GET  /limits                   current windows + availability per provider
    GET  /limits/history           stored snapshots (?provider=&window=&limit=)
    GET  /limits/tasks/{task_id}   UsageTotals for a task
    POST /limits/refresh           probe adapters now, then return the overview
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel

from aistudio.contracts.common import PROVIDERS, Provider
from aistudio.contracts.limits import BudgetCheck, LimitService, LimitWindow, UsageTotals
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.limits import tables as _tables  # noqa: F401  (registers tables)
from aistudio.limits.service import (
    DEFAULT_REFRESH_MINUTES,
    DEFAULT_WARNING_PERCENT,
    SETTING_REFRESH_MINUTES,
    SETTING_WARNING_PERCENT,
    LimitServiceImpl,
)


class LimitsOverview(BaseModel):
    windows: list[LimitWindow]
    availability: dict[str, BudgetCheck]
    generated_at: datetime


class LimitsModule(Module):
    name = "limits"

    def __init__(self) -> None:
        self.svc: LimitServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        ctx.store.declare(SETTING_REFRESH_MINUTES, DEFAULT_REFRESH_MINUTES)
        ctx.store.declare(SETTING_WARNING_PERCENT, DEFAULT_WARNING_PERCENT)
        self.svc = LimitServiceImpl(ctx)
        ctx.services.register(LimitService, self.svc)  # type: ignore[type-abstract]

    async def start(self, ctx: AppContext) -> None:
        assert self.svc is not None
        self.svc.start()

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/limits", tags=["limits"])

        def svc() -> LimitServiceImpl:
            assert self.svc is not None
            return self.svc

        async def overview(provider: Provider | None) -> LimitsOverview:
            s = svc()
            providers: list[Provider] = [provider] if provider else list(PROVIDERS)
            return LimitsOverview(
                windows=await s.current(provider),
                availability={p: await s.is_available(p) for p in providers},
                generated_at=utcnow(),
            )

        @r.get("", response_model=LimitsOverview)
        async def get_limits(provider: Provider | None = None) -> LimitsOverview:
            return await overview(provider)

        @r.get("/history", response_model=list[LimitWindow])
        async def get_history(
            provider: Provider | None = None, window: str | None = None, limit: int = 500
        ) -> list[LimitWindow]:
            return await svc().history(provider=provider, window=window, limit=limit)

        @r.get("/tasks/{task_id}", response_model=UsageTotals)
        async def get_task_usage(task_id: str) -> UsageTotals:
            return await svc().task_usage(task_id)

        @r.post("/refresh", response_model=LimitsOverview)
        async def refresh() -> LimitsOverview:
            await svc().refresh()
            return await overview(None)

        return r


module = LimitsModule()
