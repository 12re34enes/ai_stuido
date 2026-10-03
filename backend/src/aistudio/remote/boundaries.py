"""Resolve an agent's effective ``Boundaries.remote_access`` through the contracts only.

Effective boundaries = the session profile's boundaries merged (most restrictive) with the
workspace ``boundaries.md`` (MemoryService), exactly like the agent manager builds
``SessionSpec.boundaries``. Anything that cannot be resolved fails closed to ``none``.
"""

from __future__ import annotations

import logging
from typing import Protocol

from aistudio.contracts.agents import AgentManager, Boundaries
from aistudio.contracts.memory import MemoryService
from aistudio.core.errors import StudioError
from aistudio.core.services import ServiceRegistry
from aistudio.remote.policy import RemoteAccess

log = logging.getLogger(__name__)


class BoundaryResolver(Protocol):
    async def remote_access(self, *, session_id: str | None, workspace_id: str | None) -> RemoteAccess: ...


class ServicesBoundaryResolver:
    def __init__(self, services: ServiceRegistry) -> None:
        self._services = services

    async def remote_access(self, *, session_id: str | None, workspace_id: str | None) -> RemoteAccess:
        manager = self._services.maybe(AgentManager)  # type: ignore[type-abstract]
        if manager is None or not session_id:
            return "none"
        try:
            record = await manager.get(session_id)
            boundaries = Boundaries()
            if record.profile_id:
                boundaries = (await manager.resolve_profile(record.profile_id)).boundaries
            memory = self._services.maybe(MemoryService)  # type: ignore[type-abstract]
            ws = workspace_id or record.workspace_id
            if memory is not None and ws:
                boundaries = boundaries.merged(await memory.boundaries(ws))
        except StudioError as e:
            log.warning("could not resolve boundaries for session %s: %s", session_id, e.message)
            return "none"
        except Exception:
            log.exception("boundary resolution failed for session %s", session_id)
            return "none"
        return boundaries.remote_access
