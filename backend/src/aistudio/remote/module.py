"""Remote hosts and databases (spec §12): SSH transport, classification, permission levels,
approvals and the immutable audit log."""

from __future__ import annotations

from fastapi import APIRouter

from aistudio.contracts.remote import RemoteService
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.remote import tables as _tables  # noqa: F401  (registers the module's tables)
from aistudio.remote.api import build_router
from aistudio.remote.knownhosts import KnownHostsStore
from aistudio.remote.service import RemoteServiceImpl
from aistudio.remote.ssh import SSHPool
from aistudio.remote.store import RemoteStore
from aistudio.remote.tools import DbQueryTool, RemoteExecTool


class RemoteModule(Module):
    name = "remote"

    def __init__(self) -> None:
        self.svc: RemoteServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        store = RemoteStore(ctx.db, ctx.events, ctx.secrets)
        known_hosts = KnownHostsStore(ctx.settings.paths.home / "known_hosts")
        pool = SSHPool(store.get_host, store.host_secret, known_hosts)
        self.svc = RemoteServiceImpl(ctx, store, pool)
        ctx.services.register(RemoteService, self.svc)  # type: ignore[type-abstract]
        ctx.services.register(RemoteServiceImpl, self.svc)
        tools = ctx.services.maybe(ToolRegistry)  # type: ignore[type-abstract]
        if tools is not None:
            tools.register(RemoteExecTool(self.svc))
            tools.register(DbQueryTool(self.svc))

    def router(self) -> APIRouter:
        def get_svc() -> RemoteServiceImpl:
            assert self.svc is not None, "remote module not set up"
            return self.svc

        return build_router(get_svc)

    async def stop(self) -> None:
        if self.svc is not None:
            await self.svc.pool.close()


module = RemoteModule()
