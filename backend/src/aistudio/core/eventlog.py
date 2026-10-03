"""Append-only, hash-chained event log with live subscriptions.

* ``append`` persists an event (payload masked), chains it to the previous event's hash
  and fans it out to subscribers.
* ``publish_ephemeral`` fans out without persisting (token deltas, progress ticks).
* ``subscribe`` yields matching events; a subscriber that cannot keep up is closed with
  :class:`SubscriberLagged` so the client can re-sync via ``query(after_id=...)``.
* ``verify_chain`` recomputes hashes to detect tampering.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import sqlalchemy as sa

from aistudio.core.clock import utcnow
from aistudio.core.events import Event, EventFilter, Severity
from aistudio.security.masking import Masker
from aistudio.storage.db import Database
from aistudio.storage.tables import events as events_table

GENESIS_HASH = "0" * 64
_SUBSCRIBER_QUEUE_SIZE = 5000


class SubscriberLagged(Exception):
    """Raised inside a subscription when its buffer overflowed; events were dropped."""


def _canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def compute_hash(
    prev_hash: str,
    *,
    ts: datetime,
    type: str,
    severity: str,
    actor: str,
    workspace_id: str | None,
    task_id: str | None,
    run_id: str | None,
    session_id: str | None,
    payload: dict[str, Any],
) -> str:
    body = _canonical(
        {
            "ts": ts.isoformat(timespec="microseconds"),
            "type": type,
            "severity": severity,
            "actor": actor,
            "workspace_id": workspace_id,
            "task_id": task_id,
            "run_id": run_id,
            "session_id": session_id,
            "payload": payload,
        }
    )
    return hashlib.sha256((prev_hash + body).encode()).hexdigest()


class _Subscriber:
    def __init__(self, flt: EventFilter) -> None:
        self.filter = flt
        self.queue: asyncio.Queue[Event | None] = asyncio.Queue(maxsize=_SUBSCRIBER_QUEUE_SIZE)
        self.lagged = False

    def offer(self, ev: Event) -> None:
        if self.lagged or not self.filter.matches(ev):
            return
        try:
            self.queue.put_nowait(ev)
        except asyncio.QueueFull:
            self.lagged = True
            # Make room for the sentinel so the consumer wakes up and sees the lag.
            with contextlib.suppress(asyncio.QueueEmpty):
                self.queue.get_nowait()
            self.queue.put_nowait(None)


class EventLog:
    def __init__(self, db: Database, masker: Masker) -> None:
        self._db = db
        self._masker = masker
        self._lock = asyncio.Lock()
        self._last_hash: str | None = None
        self._subscribers: set[_Subscriber] = set()

    async def _tail_hash(self) -> str:
        if self._last_hash is None:
            async with self._db.connect() as conn:
                row = (
                    await conn.execute(sa.select(events_table.c.hash).order_by(events_table.c.id.desc()).limit(1))
                ).first()
            self._last_hash = str(row[0]) if row else GENESIS_HASH
            return self._last_hash
        return self._last_hash

    async def append(
        self,
        type: str,
        payload: dict[str, Any] | None = None,
        *,
        severity: Severity = Severity.info,
        actor: str = "system",
        workspace_id: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        session_id: str | None = None,
    ) -> Event:
        masked: dict[str, Any] = self._masker.mask_obj(payload or {})
        # Round-trip through JSON so the stored form (and hash input) is exactly what we persist.
        masked = json.loads(_canonical(masked))
        async with self._lock:
            prev = await self._tail_hash()
            ts = utcnow()
            digest = compute_hash(
                prev,
                ts=ts,
                type=type,
                severity=severity.value,
                actor=actor,
                workspace_id=workspace_id,
                task_id=task_id,
                run_id=run_id,
                session_id=session_id,
                payload=masked,
            )
            async with self._db.begin() as conn:
                result = await conn.execute(
                    events_table.insert().values(
                        ts=ts,
                        type=type,
                        severity=severity.value,
                        actor=actor,
                        workspace_id=workspace_id,
                        task_id=task_id,
                        run_id=run_id,
                        session_id=session_id,
                        payload=masked,
                        prev_hash=prev,
                        hash=digest,
                    )
                )
                event_id = result.inserted_primary_key[0] if result.inserted_primary_key else None
            assert event_id is not None
            self._last_hash = digest
            ev = Event(
                id=event_id,
                ts=ts,
                type=type,
                severity=severity,
                actor=actor,
                workspace_id=workspace_id,
                task_id=task_id,
                run_id=run_id,
                session_id=session_id,
                payload=masked,
                prev_hash=prev,
                hash=digest,
            )
        self._fanout(ev)
        return ev

    def publish_ephemeral(
        self,
        type: str,
        payload: dict[str, Any] | None = None,
        *,
        actor: str = "system",
        workspace_id: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        session_id: str | None = None,
    ) -> Event:
        ev = Event(
            id=0,
            ts=utcnow(),
            type=type,
            actor=actor,
            workspace_id=workspace_id,
            task_id=task_id,
            run_id=run_id,
            session_id=session_id,
            payload=self._masker.mask_obj(payload or {}),
            ephemeral=True,
        )
        self._fanout(ev)
        return ev

    def _fanout(self, ev: Event) -> None:
        for sub in list(self._subscribers):
            sub.offer(ev)

    @contextlib.asynccontextmanager
    async def subscribe(self, flt: EventFilter | None = None) -> AsyncIterator[AsyncIterator[Event]]:
        """``async with log.subscribe(f) as stream: async for ev in stream: ...``"""
        sub = _Subscriber(flt or EventFilter())
        self._subscribers.add(sub)

        async def stream() -> AsyncIterator[Event]:
            while True:
                item = await sub.queue.get()
                if item is None:
                    raise SubscriberLagged()
                yield item

        try:
            yield stream()
        finally:
            self._subscribers.discard(sub)

    async def query(
        self,
        flt: EventFilter | None = None,
        *,
        after_id: int | None = None,
        before_id: int | None = None,
        limit: int = 500,
        descending: bool = False,
    ) -> list[Event]:
        flt = flt or EventFilter()
        t = events_table
        stmt = sa.select(t)
        for field in ("workspace_id", "task_id", "run_id", "session_id"):
            want = getattr(flt, field)
            if want is not None:
                stmt = stmt.where(t.c[field] == want)
        if flt.types:
            conds = [t.c.type.startswith(x[:-1]) if x.endswith(".*") else t.c.type == x for x in flt.types]
            stmt = stmt.where(sa.or_(*conds))
        if after_id is not None:
            stmt = stmt.where(t.c.id > after_id)
        if before_id is not None:
            stmt = stmt.where(t.c.id < before_id)
        stmt = stmt.order_by(t.c.id.desc() if descending else t.c.id.asc()).limit(limit)
        async with self._db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [Event(**{**row, "severity": Severity(row["severity"])}) for row in rows]

    @contextlib.asynccontextmanager
    async def exclusive(self) -> AsyncIterator[None]:
        """Hold off appends while the database is replaced underneath (backup restore).

        Appends wait until the block exits; the tail hash is then re-read from the database so
        the chain continues from the restored history. Do not append inside the block.
        """
        async with self._lock:
            try:
                yield
            finally:
                self._last_hash = None

    async def last_id(self) -> int:
        async with self._db.connect() as conn:
            value = (await conn.execute(sa.select(sa.func.max(events_table.c.id)))).scalar()
        return int(value or 0)

    async def verify_chain(self, batch: int = 2000) -> tuple[bool, int | None]:
        """Return ``(ok, first_bad_id)``."""
        prev = GENESIS_HASH
        after = 0
        while True:
            chunk = await self.query(after_id=after, limit=batch)
            if not chunk:
                return True, None
            for ev in chunk:
                expected = compute_hash(
                    prev,
                    ts=ev.ts,
                    type=ev.type,
                    severity=ev.severity.value,
                    actor=ev.actor,
                    workspace_id=ev.workspace_id,
                    task_id=ev.task_id,
                    run_id=ev.run_id,
                    session_id=ev.session_id,
                    payload=ev.payload,
                )
                if ev.prev_hash != prev or ev.hash != expected:
                    return False, ev.id
                prev = ev.hash
            after = chunk[-1].id
