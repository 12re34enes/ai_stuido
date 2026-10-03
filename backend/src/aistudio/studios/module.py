"""Studios module: built-in and user-defined, versioned studio templates (spec §16)."""

from __future__ import annotations

from fastapi import APIRouter

from aistudio.contracts.studios import StudioService
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.studios.api import build_router
from aistudio.studios.service import StudioServiceImpl


class StudiosModule(Module):
    name = "studios"

    def __init__(self) -> None:
        self.svc: StudioServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        from aistudio.studios import tables  # noqa: F401  (registers studio tables)

        self.svc = StudioServiceImpl(ctx)
        ctx.services.register(StudioService, self.svc)  # type: ignore[type-abstract]

    def router(self) -> APIRouter:
        def svc() -> StudioServiceImpl:
            assert self.svc is not None
            return self.svc

        return build_router(svc)


module = StudiosModule()
