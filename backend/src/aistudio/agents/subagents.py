"""Per-session index of CLI-native subagents (spec §25 "Yerel alt ajanlar").

Built from the payloads the sink already persists: ``SubagentStarted`` / ``SubagentCompleted``
and every payload tagged with ``subagent_id``. Kept in memory for live sessions (the permission
gate looks names up) and in ``agents_subagents`` (``GET /api/agents/sessions/{id}/subagents``).

Payload semantics the index relies on:

* ``SubagentStarted`` is an upsert: adapters may repeat it for the same ``subagent_id`` when they
  learn the name/model later or when a finished subagent is resumed (status back to running);
  non-null fields win.
* ``Usage`` with ``subagent_id`` carries the subagent's cumulative totals so far (not a delta).
* ``ToolCall`` with ``subagent_id`` counts one tool call; an assistant ``Message`` updates
  ``last_text``; ``SubagentCompleted.result_text`` becomes the final ``last_text``.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, fields
from datetime import datetime
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel

from aistudio.agents.tables import agents_subagents
from aistudio.contracts.agents import (
    AgentEventPayload,
    Message,
    SubagentCompleted,
    SubagentStarted,
    ToolCall,
    Usage,
)
from aistudio.core.clock import utcnow
from aistudio.core.text import truncate
from aistudio.storage.db import Database

log = logging.getLogger(__name__)

SubagentStatus = Literal["running", "success", "error", "interrupted"]
LAST_TEXT_LIMIT = 4000
PROMPT_LIMIT = 4000
_MAX_DEPTH = 32


class SubagentView(BaseModel):
    """One subagent of a session (flat list; build the tree with ``parent_subagent_id``)."""

    session_id: str
    subagent_id: str
    parent_subagent_id: str | None = None  # None = spawned by the session's main agent
    parent_call_id: str | None = None  # ToolCall.call_id that spawned it, when known
    depth: int = 0  # 0 = direct child of the main agent
    name: str | None = None  # agent type / role
    description: str | None = None
    prompt: str | None = None
    status: SubagentStatus = "running"
    model: str | None = None
    started_at: datetime
    finished_at: datetime | None = None
    updated_at: datetime
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: int = 0
    last_text: str | None = None


@dataclass
class SubagentCounts:
    total: int = 0
    active: int = 0


@dataclass
class _Entry:
    session_id: str
    subagent_id: str
    started_at: datetime
    updated_at: datetime
    parent_subagent_id: str | None = None
    parent_call_id: str | None = None
    name: str | None = None
    description: str | None = None
    prompt: str | None = None
    status: str = "running"
    model: str | None = None
    finished_at: datetime | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: int = 0
    last_text: str | None = None

    def values(self) -> dict[str, Any]:
        return {f.name: getattr(self, f.name) for f in fields(self)}

    @classmethod
    def from_row(cls, row: Mapping[Any, Any]) -> _Entry:
        names = {f.name for f in fields(cls)}
        return cls(**{str(k): v for k, v in row.items() if str(k) in names})


def subagent_of(payload: BaseModel) -> str | None:
    value = getattr(payload, "subagent_id", None)
    return value if isinstance(value, str) and value else None


class SubagentIndex:
    def __init__(self, db: Database) -> None:
        self._db = db
        self._live: dict[str, dict[str, _Entry]] = {}  # session id -> subagent id -> entry
        self._locks: dict[str, asyncio.Lock] = {}

    # ------------------------------------------------------------------ updates

    async def apply(self, session_id: str, payload: AgentEventPayload) -> None:
        """Fold one persisted payload into the index (no-op for main-thread payloads).
        Serialized per session: adapters may emit from more than one task."""
        subagent_id = subagent_of(payload)
        if subagent_id is None:
            return
        async with self._locks.setdefault(session_id, asyncio.Lock()):
            entries = await self._entries(session_id)
            now = utcnow()
            entry = entries.get(subagent_id)
            created = entry is None
            if entry is None:
                entry = _Entry(session_id=session_id, subagent_id=subagent_id, started_at=now, updated_at=now)
                entries[subagent_id] = entry
            if not self._fold(entry, payload, now) and not created:
                return
            entry.updated_at = now
            await self._save(entry, insert=created)

    @staticmethod
    def _fold(entry: _Entry, payload: AgentEventPayload, now: datetime) -> bool:
        """Apply ``payload`` to ``entry``; False when nothing worth storing changed."""
        if isinstance(payload, SubagentStarted):
            for key in ("parent_subagent_id", "parent_call_id", "name", "description", "model"):
                value = getattr(payload, key)
                if value:
                    setattr(entry, key, value)
            if payload.prompt:
                entry.prompt = truncate(payload.prompt, PROMPT_LIMIT)
            if entry.status != "running":  # resumed
                entry.status = "running"
                entry.finished_at = None
            return True
        if isinstance(payload, SubagentCompleted):
            entry.status = payload.status
            entry.finished_at = now
            if payload.result_text:
                entry.last_text = truncate(payload.result_text, LAST_TEXT_LIMIT)
            if payload.usage is not None:
                entry.input_tokens = max(entry.input_tokens, payload.usage.input_tokens)
                entry.output_tokens = max(entry.output_tokens, payload.usage.output_tokens)
            return True
        if isinstance(payload, ToolCall):
            entry.tool_calls += 1
            return True
        if isinstance(payload, Message):
            if payload.role != "assistant" or not payload.text.strip():
                return False
            entry.last_text = truncate(payload.text, LAST_TEXT_LIMIT)
            return True
        if isinstance(payload, Usage):
            entry.input_tokens = payload.input_tokens
            entry.output_tokens = payload.output_tokens
            return True
        return False

    async def end_session(self, session_id: str, status: SubagentStatus = "interrupted") -> int:
        """The session's process is gone: subagents still running cannot continue."""
        now = utcnow()
        for entry in (self._live.get(session_id) or {}).values():
            if entry.status == "running":
                entry.status = status
                entry.finished_at = now
                entry.updated_at = now
        t = agents_subagents
        async with self._db.begin() as conn:
            result = await conn.execute(
                t.update()
                .where(t.c.session_id == session_id, t.c.status == "running")
                .values(status=status, finished_at=now, updated_at=now)
            )
        return int(result.rowcount or 0)

    def forget(self, session_id: str) -> None:
        self._live.pop(session_id, None)
        lock = self._locks.get(session_id)
        if lock is not None and not lock.locked():
            self._locks.pop(session_id, None)

    async def recover_after_restart(self) -> int:
        """Subagents left running by a previous studiod process are marked interrupted."""
        t = agents_subagents
        now = utcnow()
        async with self._db.begin() as conn:
            result = await conn.execute(
                t.update().where(t.c.status == "running").values(status="interrupted", finished_at=now, updated_at=now)
            )
        self._live.clear()
        return int(result.rowcount or 0)

    # ------------------------------------------------------------------ queries

    def name_of(self, session_id: str, subagent_id: str) -> tuple[str | None, str | None] | None:
        """(name, description) of a known live subagent."""
        entry = (self._live.get(session_id) or {}).get(subagent_id)
        return (entry.name, entry.description) if entry is not None else None

    async def list(self, session_id: str) -> list[SubagentView]:
        t = agents_subagents
        async with self._db.connect() as conn:
            rows = (
                (await conn.execute(sa.select(t).where(t.c.session_id == session_id).order_by(t.c.started_at)))
                .mappings()
                .all()
            )
        entries = [_Entry.from_row(r) for r in rows]
        by_id = {e.subagent_id: e for e in entries}

        def depth(e: _Entry) -> int:
            d, parent = 0, e.parent_subagent_id
            while parent and parent in by_id and d < _MAX_DEPTH:
                d += 1
                parent = by_id[parent].parent_subagent_id
            return d

        return [SubagentView(**e.values(), depth=depth(e)) for e in _tree_order(entries)]

    async def counts(self, session_ids: Iterable[str]) -> dict[str, SubagentCounts]:
        ids = list(dict.fromkeys(session_ids))
        if not ids:
            return {}
        t = agents_subagents
        active = sa.func.sum(sa.case((t.c.status == "running", 1), else_=0))
        async with self._db.connect() as conn:
            rows = (
                await conn.execute(
                    sa.select(t.c.session_id, sa.func.count(), active)
                    .where(t.c.session_id.in_(ids))
                    .group_by(t.c.session_id)
                )
            ).all()
        return {str(sid): SubagentCounts(total=int(n or 0), active=int(a or 0)) for sid, n, a in rows}

    # ------------------------------------------------------------------ storage

    async def _entries(self, session_id: str) -> dict[str, _Entry]:
        entries = self._live.get(session_id)
        if entries is not None:
            return entries
        t = agents_subagents
        async with self._db.connect() as conn:
            rows = (await conn.execute(sa.select(t).where(t.c.session_id == session_id))).mappings().all()
        entries = {str(r["subagent_id"]): _Entry.from_row(r) for r in rows}
        self._live[session_id] = entries
        return entries

    async def _save(self, entry: _Entry, *, insert: bool) -> None:
        t = agents_subagents
        values = entry.values()
        async with self._db.begin() as conn:
            if insert:
                await conn.execute(t.insert().values(**values))
            else:
                await conn.execute(
                    t.update()
                    .where(t.c.session_id == entry.session_id, t.c.subagent_id == entry.subagent_id)
                    .values(**values)
                )


def _tree_order(entries: list[_Entry]) -> list[_Entry]:
    """Start order, but every subagent after its parent (depth-first), so a client can build
    the tree in one pass."""
    ids = {e.subagent_id for e in entries}
    children: dict[str | None, list[_Entry]] = {}
    for e in entries:
        parent = e.parent_subagent_id if e.parent_subagent_id in ids and e.parent_subagent_id != e.subagent_id else None
        children.setdefault(parent, []).append(e)
    out: list[_Entry] = []
    seen: set[str] = set()

    def visit(parent: str | None) -> None:
        for e in children.get(parent, []):
            if e.subagent_id in seen:
                continue
            seen.add(e.subagent_id)
            out.append(e)
            visit(e.subagent_id)

    visit(None)
    out += [e for e in entries if e.subagent_id not in seen]  # cycles (should not happen)
    return out
