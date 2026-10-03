"""Helpers shared by the backup tests (imported by name; the test dir is on sys.path)."""

from __future__ import annotations

from dataclasses import dataclass

from aistudio.approvals.service import ApprovalServiceImpl
from aistudio.backup.service import BackupServiceImpl
from aistudio.contracts.approvals import ApprovalService
from aistudio.contracts.workspaces import Workspace, WorkspaceService
from aistudio.core.context import AppContext
from aistudio.memory import tables as _memory_tables  # noqa: F401  (registers tables)
from aistudio.memory.service import MemoryServiceImpl
from aistudio.workspaces.service import WorkspaceCreate, WorkspaceServiceImpl


@dataclass
class BackupEnv:
    ctx: AppContext
    svc: BackupServiceImpl
    memory: MemoryServiceImpl
    workspaces: WorkspaceServiceImpl
    ws: Workspace


async def make_backup_env(ctx: AppContext) -> BackupEnv:
    await ctx.db.create_all()
    workspaces = WorkspaceServiceImpl(ctx.db, ctx.events)
    ctx.services.register(WorkspaceService, workspaces)  # type: ignore[type-abstract]
    ctx.services.register(ApprovalService, ApprovalServiceImpl(ctx.db, ctx.events, ctx.store))  # type: ignore[type-abstract]
    memory = MemoryServiceImpl(ctx)
    BackupServiceImpl.declare_settings(ctx)
    svc = BackupServiceImpl(ctx)
    ws = await workspaces.create(WorkspaceCreate(name="Yedek Testi"))
    await memory.write(ws.id, "facts.md", "# Proje gerçekleri\n\n## Amaç\nİlk hal.\n", message="ilk")
    return BackupEnv(ctx=ctx, svc=svc, memory=memory, workspaces=workspaces, ws=ws)
