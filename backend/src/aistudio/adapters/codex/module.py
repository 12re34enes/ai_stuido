"""Codex adapter module: registers :class:`CodexAdapter` with the agents module's registry."""

from __future__ import annotations

from aistudio.adapters.codex.adapter import CodexAdapter
from aistudio.contracts.agents import AdapterRegistry
from aistudio.core.context import AppContext
from aistudio.core.module import Module


class CodexAdapterModule(Module):
    name = "codex"

    async def setup(self, ctx: AppContext) -> None:
        # The registry is registered by aistudio.agents, which is set up before adapters.
        ctx.services.get(AdapterRegistry).register(CodexAdapter())  # type: ignore[type-abstract]


module = CodexAdapterModule()
