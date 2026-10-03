"""Typed service registry used for cross-module wiring.

Modules register implementations of the Protocols in ``aistudio.contracts`` during
``setup``; other modules look them up lazily (at call time, not import time) so that
setup order only matters for things used during setup itself.

    ctx.services.register(WorktreeManager, impl)
    wt = ctx.services.get(WorktreeManager)
"""

from __future__ import annotations

from typing import Any, cast

from aistudio.core.errors import Unavailable


class ServiceRegistry:
    def __init__(self) -> None:
        self._items: dict[type, Any] = {}

    def register[T](self, key: type[T], impl: T) -> None:
        if key in self._items:
            raise RuntimeError(f"service {key.__name__} registered twice")
        self._items[key] = impl

    def get[T](self, key: type[T]) -> T:
        try:
            return cast(T, self._items[key])
        except KeyError:
            raise Unavailable(f"Servis hazır değil: {key.__name__}") from None

    def maybe[T](self, key: type[T]) -> T | None:
        return cast(T | None, self._items.get(key))

    def has(self, key: type) -> bool:
        return key in self._items
