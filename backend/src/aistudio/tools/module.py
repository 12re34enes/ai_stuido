from __future__ import annotations

from fastapi import APIRouter

from aistudio.contracts.tools import ToolRegistry, ToolSpec
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.tools.registry import ToolRegistryImpl


class ToolsModule(Module):
    name = "tools"

    def __init__(self) -> None:
        self.registry: ToolRegistryImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        self.registry = ToolRegistryImpl(ctx.events)
        ctx.services.register(ToolRegistry, self.registry)  # type: ignore[type-abstract]

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/tools", tags=["tools"])

        @r.get("", response_model=list[ToolSpec])
        async def list_tools() -> list[ToolSpec]:
            assert self.registry is not None
            return self.registry.all_specs()

        return r


module = ToolsModule()
