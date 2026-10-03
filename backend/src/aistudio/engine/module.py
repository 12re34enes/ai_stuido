"""Engine module: flows, tasks, runs, gates, queue, scheduler, replay/export, quality."""

from __future__ import annotations

from fastapi import APIRouter

from aistudio.contracts.engine import FlowEngine
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.engine import tables as _tables  # noqa: F401  (registers engine tables)
from aistudio.engine.api import build_router
from aistudio.engine.runtime import SETTINGS_DEFAULTS
from aistudio.engine.service import FlowEngineImpl
from aistudio.engine.team.tools import team_tools
from aistudio.engine.tools import engine_tools


class EngineModule(Module):
    name = "engine"

    def __init__(self) -> None:
        self.engine: FlowEngineImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        for key, default in SETTINGS_DEFAULTS.items():
            ctx.store.declare(key, default)
        self.engine = FlowEngineImpl(ctx)
        ctx.services.register(FlowEngine, self.engine)  # type: ignore[type-abstract]
        ctx.services.register(FlowEngineImpl, self.engine)
        registry = ctx.services.maybe(ToolRegistry)  # type: ignore[type-abstract]
        if registry is not None:
            for tool in engine_tools(self.engine):
                registry.register(tool)
            for team_tool in team_tools(self.engine):
                registry.register(team_tool)

    def router(self) -> APIRouter:
        def get_engine() -> FlowEngineImpl:
            assert self.engine is not None, "engine module not set up"
            return self.engine

        return build_router(get_engine)

    async def start(self, ctx: AppContext) -> None:
        assert self.engine is not None
        await self.engine.startup()

    async def stop(self) -> None:
        if self.engine is not None:
            await self.engine.shutdown()


module = EngineModule()
