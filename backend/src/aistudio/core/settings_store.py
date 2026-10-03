"""Global key/value settings with typed defaults.

Keys are dotted and owned by a module prefix (``alerts.``, ``limits.``, ``appearance.``).
Foundation-owned keys are declared in ``DEFAULTS``; modules may add their own defaults with
``SettingsStore.declare``.
"""

from __future__ import annotations

from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from aistudio.core.clock import utcnow
from aistudio.storage.db import Database
from aistudio.storage.tables import kv_settings

DEFAULTS: dict[str, Any] = {
    # Production approvals only from the app unless explicitly enabled (spec §15).
    "safety.remote_production_approvals": False,
    "appearance.theme": "system",  # system | light | dark
    "appearance.reduce_motion": "system",  # system | on | off
    "shortcuts.global_palette": "Control+Alt+Space",
}


class SettingsStore:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._defaults: dict[str, Any] = dict(DEFAULTS)

    def declare(self, key: str, default: Any) -> None:
        self._defaults.setdefault(key, default)

    def defaults(self) -> dict[str, Any]:
        return dict(self._defaults)

    async def get(self, key: str) -> Any:
        async with self._db.connect() as conn:
            row = (await conn.execute(sa.select(kv_settings.c.value).where(kv_settings.c.key == key))).first()
        if row is not None:
            return row[0]
        return self._defaults.get(key)

    async def all(self) -> dict[str, Any]:
        async with self._db.connect() as conn:
            rows = (await conn.execute(sa.select(kv_settings.c.key, kv_settings.c.value))).all()
        merged = dict(self._defaults)
        merged.update({k: v for k, v in rows})
        return merged

    async def set(self, key: str, value: Any) -> None:
        stmt = sqlite_insert(kv_settings).values(key=key, value=value, updated_at=utcnow())
        stmt = stmt.on_conflict_do_update(
            index_elements=[kv_settings.c.key], set_={"value": value, "updated_at": utcnow()}
        )
        async with self._db.begin() as conn:
            await conn.execute(stmt)
