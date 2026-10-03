"""Gitops module: worktrees, diffs, merges, checkpoints and live conflict detection."""

from __future__ import annotations

from fastapi import APIRouter

from aistudio.contracts.gitops import WorktreeManager
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.gitops.service import WorktreeManagerImpl
from aistudio.gitops.settings import DEFAULTS


class GitopsModule(Module):
    name = "gitops"

    def __init__(self) -> None:
        self.mgr: WorktreeManagerImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        from aistudio.gitops import tables as _tables  # noqa: F401  (registers tables)

        for key, value in DEFAULTS.items():
            ctx.store.declare(key, value)
        self.mgr = WorktreeManagerImpl(ctx)
        manager: WorktreeManager = self.mgr  # static check: the impl satisfies the contract
        ctx.services.register(WorktreeManager, manager)  # type: ignore[type-abstract]
        ctx.services.register(WorktreeManagerImpl, self.mgr)

    def router(self) -> APIRouter:
        from aistudio.gitops.api import build_router

        return build_router(lambda: self.mgr)

    async def start(self, ctx: AppContext) -> None:
        if self.mgr is not None:
            self.mgr.start()

    async def stop(self) -> None:
        if self.mgr is not None:
            await self.mgr.stop()


module = GitopsModule()
