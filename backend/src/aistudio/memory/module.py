"""Shared memory module: per-workspace git repos, proposals, agent context, session summaries."""

from __future__ import annotations

from fastapi import APIRouter

from aistudio.contracts.memory import MemoryService
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.memory.api import build_router
from aistudio.memory.service import SETTING_AUTO_SUMMARIES, MemoryServiceImpl
from aistudio.memory.tools import MemoryProposeTool, MemoryReadTool


class MemoryModule(Module):
    name = "memory"

    def __init__(self) -> None:
        self.svc: MemoryServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        from aistudio.memory import tables  # noqa: F401  (registers memory tables)

        ctx.store.declare(SETTING_AUTO_SUMMARIES, True)
        self.svc = MemoryServiceImpl(ctx)
        ctx.services.register(MemoryService, self.svc)  # type: ignore[type-abstract]
        registry = ctx.services.maybe(ToolRegistry)  # type: ignore[type-abstract]
        if registry is not None:
            registry.register(MemoryReadTool(self.svc))
            registry.register(MemoryProposeTool(self.svc))

    def router(self) -> APIRouter:
        def svc() -> MemoryServiceImpl:
            assert self.svc is not None
            return self.svc

        return build_router(svc)

    async def start(self, ctx: AppContext) -> None:
        assert self.svc is not None
        self.svc.start()

    async def stop(self) -> None:
        if self.svc is not None:
            await self.svc.stop()


module = MemoryModule()
