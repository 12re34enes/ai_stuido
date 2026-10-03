"""Helpers shared by the memory tests (imported by name; the test dir is on sys.path)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from aistudio.approvals.service import ApprovalServiceImpl
from aistudio.contracts.approvals import ApprovalService
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.workspaces import Workspace, WorkspaceService
from aistudio.core.context import AppContext
from aistudio.memory import tables as _memory_tables  # noqa: F401  (registers tables)
from aistudio.memory.service import SETTING_AUTO_SUMMARIES, MemoryServiceImpl
from aistudio.workspaces.service import WorkspaceCreate, WorkspaceServiceImpl


@dataclass
class MemEnv:
    ctx: AppContext
    svc: MemoryServiceImpl
    approvals: ApprovalServiceImpl
    workspaces: WorkspaceServiceImpl
    ws: Workspace


async def make_mem_env(ctx: AppContext) -> MemEnv:
    await ctx.db.create_all()
    workspaces = WorkspaceServiceImpl(ctx.db, ctx.events)
    approvals = ApprovalServiceImpl(ctx.db, ctx.events, ctx.store)
    ctx.services.register(WorkspaceService, workspaces)  # type: ignore[type-abstract]
    ctx.services.register(ApprovalService, approvals)  # type: ignore[type-abstract]
    ctx.store.declare(SETTING_AUTO_SUMMARIES, True)
    svc = MemoryServiceImpl(ctx)
    ctx.services.register(MemoryService, svc)  # type: ignore[type-abstract]
    ws = await workspaces.create(WorkspaceCreate(name="Ödeme Servisi"))
    return MemEnv(ctx=ctx, svc=svc, approvals=approvals, workspaces=workspaces, ws=ws)


async def eventually[T](fn: Callable[[], Awaitable[T]], *, timeout: float = 5.0) -> T:
    """Poll ``fn`` until it returns a truthy value."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        value = await fn()
        if value:
            return value
        if loop.time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)
