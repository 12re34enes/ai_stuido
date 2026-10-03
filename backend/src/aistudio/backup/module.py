"""Backup module: scheduled backups of the database and memory repos, and restore (spec §18)."""

from __future__ import annotations

from fastapi import APIRouter

from aistudio.backup.api import build_router
from aistudio.backup.service import BackupServiceImpl
from aistudio.core.context import AppContext
from aistudio.core.module import Module


class BackupModule(Module):
    name = "backup"

    def __init__(self) -> None:
        self.svc: BackupServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        BackupServiceImpl.declare_settings(ctx)
        self.svc = BackupServiceImpl(ctx)
        ctx.services.register(BackupServiceImpl, self.svc)

    def router(self) -> APIRouter:
        def svc() -> BackupServiceImpl:
            assert self.svc is not None
            return self.svc

        return build_router(svc)

    async def start(self, ctx: AppContext) -> None:
        assert self.svc is not None
        self.svc.start()

    async def stop(self) -> None:
        if self.svc is not None:
            await self.svc.stop()


module = BackupModule()
