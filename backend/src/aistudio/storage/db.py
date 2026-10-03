"""SQLite access (SQLAlchemy Core, async via aiosqlite).

Every module declares its tables against the shared :data:`metadata` in its own
``tables.py``; :func:`Database.create_all` creates whatever has been imported.
Timestamps are stored as ISO-8601 UTC text so they sort correctly and stay readable.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

metadata = sa.MetaData(
    naming_convention={
        "ix": "ix_%(column_0_label)s",
        "uq": "uq_%(table_name)s_%(column_0_name)s",
        "ck": "ck_%(table_name)s_%(constraint_name)s",
        "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
        "pk": "pk_%(table_name)s",
    }
)


class UTCDateTime(sa.TypeDecorator[datetime]):
    """Timezone-aware datetime persisted as ISO-8601 UTC text."""

    impl = sa.String(32)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: sa.Dialect) -> str | None:
        if value is None:
            return None
        if value.tzinfo is None:
            raise ValueError("naive datetimes are not allowed; use aistudio.core.clock.utcnow()")
        return value.astimezone(UTC).isoformat(timespec="microseconds")

    def process_result_value(self, value: str | None, dialect: sa.Dialect) -> datetime | None:
        if value is None:
            return None
        return datetime.fromisoformat(value)


def json_col(name: str, *, nullable: bool = False, default: Any = None) -> sa.Column[Any]:
    """A JSON column with a Python-side default (dict/list factories are copied per row)."""
    if default is None:
        return sa.Column(name, sa.JSON, nullable=nullable)
    factory = (
        (lambda: dict(default))
        if isinstance(default, dict)
        else ((lambda: list(default)) if isinstance(default, list) else (lambda: default))
    )
    return sa.Column(name, sa.JSON, nullable=nullable, default=factory)


class Database:
    def __init__(self, engine: AsyncEngine) -> None:
        self.engine = engine

    @classmethod
    def open(cls, path: Path | str) -> Database:
        url = "sqlite+aiosqlite:///:memory:" if str(path) == ":memory:" else f"sqlite+aiosqlite:///{path}"
        engine = create_async_engine(url, future=True)

        @event.listens_for(engine.sync_engine, "connect")
        def _pragmas(dbapi_conn: Any, _record: Any) -> None:
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.execute("PRAGMA foreign_keys=ON")
            cur.execute("PRAGMA busy_timeout=5000")
            cur.close()

        return cls(engine)

    async def create_all(self) -> None:
        async with self.engine.begin() as conn:
            await conn.run_sync(metadata.create_all)

    @asynccontextmanager
    async def begin(self) -> AsyncIterator[AsyncConnection]:
        """A transaction; commits on success, rolls back on error."""
        async with self.engine.begin() as conn:
            yield conn

    @asynccontextmanager
    async def connect(self) -> AsyncIterator[AsyncConnection]:
        """A read connection (no implicit commit)."""
        async with self.engine.connect() as conn:
            yield conn

    async def close(self) -> None:
        await self.engine.dispose()
