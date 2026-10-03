"""Application context: the handful of objects every module needs."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Coroutine
from dataclasses import dataclass, field
from typing import Any

from aistudio.core.config import Settings
from aistudio.core.eventlog import EventLog
from aistudio.core.services import ServiceRegistry
from aistudio.core.settings_store import SettingsStore
from aistudio.security.masking import Masker
from aistudio.security.secrets import SecretStore
from aistudio.storage.db import Database

log = logging.getLogger("aistudio")


@dataclass
class AppContext:
    settings: Settings
    db: Database
    events: EventLog
    masker: Masker
    secrets: SecretStore
    store: SettingsStore
    services: ServiceRegistry = field(default_factory=ServiceRegistry)
    _tasks: set[asyncio.Task[Any]] = field(default_factory=set)

    def spawn(self, coro: Coroutine[Any, Any, Any], *, name: str) -> asyncio.Task[Any]:
        """Run a background task owned by the app; it is cancelled on shutdown and errors are logged."""
        task = asyncio.create_task(coro, name=name)
        self._tasks.add(task)

        def _done(t: asyncio.Task[Any]) -> None:
            self._tasks.discard(t)
            if not t.cancelled() and t.exception() is not None:
                log.error("background task %s failed", name, exc_info=t.exception())

        task.add_done_callback(_done)
        return task

    async def shutdown_tasks(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        for t in list(self._tasks):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
