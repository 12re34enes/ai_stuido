"""Agents module. Foundation part: the adapter registry. The agent manager, profiles, sessions,
permission policy, local transport and discovery are implemented by the agents workstream."""

from __future__ import annotations

from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.contracts.agents import AdapterRegistry
from aistudio.core.context import AppContext
from aistudio.core.module import Module


class AgentsModule(Module):
    name = "agents"

    async def setup(self, ctx: AppContext) -> None:
        ctx.services.register(AdapterRegistry, AdapterRegistryImpl())  # type: ignore[type-abstract]


module = AgentsModule()
