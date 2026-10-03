"""Agents module: adapter registry, agent manager (profiles, sessions, permission policy, stall
watchdog, discovery/import) and the local transport.

Services registered:
    AdapterRegistry  - provider -> adapter (adapter modules register themselves in ``setup``)
    AgentManager     - :class:`aistudio.agents.manager.AgentManagerImpl`
    Transport        - the LOCAL transport (``LocalTransport``, scrubbed environment). Remote
                       transports come from ``RemoteService.transport(host_id)``.

Settings (``ctx.store``):
    agents.stall_minutes               no-output minutes before ``agent.stalled`` (default 10)
    agents.safe_commands               auto-allowed command prefixes (default: policy safe list)
    agents.auto_allow_web              auto-allow web tools when network is on (default False)
    agents.permission_timeout_minutes  deny an unanswered permission after N minutes (0 = wait)
"""

from __future__ import annotations

from fastapi import APIRouter

from aistudio.agents import tables as _tables  # noqa: F401  (registers tables)
from aistudio.agents.api import build_router
from aistudio.agents.manager import DEFAULT_STALL_MINUTES, SETTING_STALL_MINUTES, AgentManagerImpl
from aistudio.agents.permissions import SETTING_AUTO_ALLOW_WEB, SETTING_PERMISSION_TIMEOUT, SETTING_SAFE_COMMANDS
from aistudio.agents.policy import DEFAULT_SAFE_COMMANDS
from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.agents.transport_local import LocalTransport
from aistudio.contracts.agents import AdapterRegistry, AgentManager
from aistudio.contracts.transport import Transport
from aistudio.core.context import AppContext
from aistudio.core.module import Module


class AgentsModule(Module):
    name = "agents"

    def __init__(self) -> None:
        self.registry: AdapterRegistryImpl | None = None
        self.local: LocalTransport | None = None
        self.manager: AgentManagerImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        ctx.store.declare(SETTING_STALL_MINUTES, DEFAULT_STALL_MINUTES)
        ctx.store.declare(SETTING_SAFE_COMMANDS, list(DEFAULT_SAFE_COMMANDS))
        ctx.store.declare(SETTING_AUTO_ALLOW_WEB, False)
        ctx.store.declare(SETTING_PERMISSION_TIMEOUT, 0)
        self.registry = AdapterRegistryImpl()
        self.local = LocalTransport()
        self.manager = AgentManagerImpl(ctx, self.registry, self.local)
        ctx.services.register(AdapterRegistry, self.registry)  # type: ignore[type-abstract]
        ctx.services.register(Transport, self.local)  # type: ignore[type-abstract]
        ctx.services.register(AgentManager, self.manager)  # type: ignore[type-abstract]

    def router(self) -> APIRouter:
        def manager() -> AgentManagerImpl:
            assert self.manager is not None
            return self.manager

        return build_router(manager)

    async def start(self, ctx: AppContext) -> None:
        assert self.manager is not None
        await self.manager.start()

    async def stop(self) -> None:
        if self.manager is not None:
            await self.manager.stop()


module = AgentsModule()
