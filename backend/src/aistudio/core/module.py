"""Feature module contract.

Each feature package exposes ``module: Module`` in ``aistudio/<pkg>/module.py``. The app
loads the packages listed in ``aistudio/modules.py`` in order and calls, for each:

1. ``setup(ctx)``  - import tables, register services/tools. No I/O beyond the DB.
2. ``router()``    - optional FastAPI router, mounted under ``/api``.
3. ``start(ctx)``  - after all modules are set up: start background work via ``ctx.spawn``.
4. ``stop()``      - on shutdown, reverse order.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import APIRouter

    from aistudio.core.context import AppContext


class Module:
    name: str = "unnamed"

    async def setup(self, ctx: AppContext) -> None:
        return None

    def router(self) -> APIRouter | None:
        return None

    async def start(self, ctx: AppContext) -> None:
        return None

    async def stop(self) -> None:
        return None
