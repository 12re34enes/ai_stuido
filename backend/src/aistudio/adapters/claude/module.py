"""Claude Code adapter module: registers :class:`ClaudeAdapter` with the adapter registry
(created by the agents module, which is set up earlier)."""

from __future__ import annotations

from aistudio.adapters.claude.adapter import ClaudeAdapter
from aistudio.contracts.agents import AdapterRegistry
from aistudio.core.context import AppContext
from aistudio.core.module import Module


class ClaudeAdapterModule(Module):
    name = "claude"

    def __init__(self) -> None:
        self.adapter: ClaudeAdapter | None = None

    async def setup(self, ctx: AppContext) -> None:
        self.adapter = ClaudeAdapter()
        ctx.services.get(AdapterRegistry).register(self.adapter)  # type: ignore[type-abstract]


module = ClaudeAdapterModule()
