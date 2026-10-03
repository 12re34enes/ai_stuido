"""Persistence for agent sessions (``agents_sessions``)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

import sqlalchemy as sa

from aistudio.agents.tables import agents_sessions
from aistudio.contracts.agents import AgentState, SessionRecord, Usage
from aistudio.contracts.common import Location
from aistudio.core.clock import utcnow
from aistudio.core.errors import NotFound
from aistudio.storage.db import Database

# States in which a CLI process is (supposed to be) doing or awaiting something.
RUNNING_STATES: frozenset[AgentState] = frozenset(
    {AgentState.starting, AgentState.thinking, AgentState.responding, AgentState.running_tool}
)
WAITING_STATES: frozenset[AgentState] = frozenset({AgentState.waiting_permission, AgentState.waiting_user})
TERMINAL_STATES: frozenset[AgentState] = frozenset({AgentState.done, AgentState.error})


def _record(row: Mapping[Any, Any]) -> SessionRecord:
    data = {str(k): v for k, v in row.items() if k != "request"}
    # Effort lives in the request JSON: the resolved value (profile included), else the spec's.
    request = row.get("request")
    spec = request.get("spec") if isinstance(request, dict) else None
    resolved = request.get("effort") if isinstance(request, dict) else None
    data["effort"] = resolved or (spec.get("effort") if isinstance(spec, dict) else None)
    data["location"] = Location.model_validate(data.get("location") or {})
    usage = data.get("last_usage")
    data["last_usage"] = Usage.model_validate(usage) if usage else None
    return SessionRecord(**data)


def _values(rec: SessionRecord) -> dict[str, Any]:
    data = rec.model_dump(mode="python", exclude={"effort"})  # effort lives in the request JSON
    data["location"] = rec.location.model_dump(mode="json")
    data["last_usage"] = rec.last_usage.model_dump(mode="json") if rec.last_usage else None
    data["state"] = rec.state.value
    return data


class SessionRepo:
    def __init__(self, db: Database) -> None:
        self._db = db

    async def insert(self, rec: SessionRecord, *, request: dict[str, Any] | None = None) -> None:
        async with self._db.begin() as conn:
            await conn.execute(agents_sessions.insert().values(**_values(rec), request=request))

    async def get(self, session_id: str) -> SessionRecord:
        async with self._db.connect() as conn:
            row = (
                (await conn.execute(sa.select(agents_sessions).where(agents_sessions.c.id == session_id)))
                .mappings()
                .first()
            )
        if row is None:
            raise NotFound("Ajan oturumu bulunamadı.", details={"session_id": session_id})
        return _record(row)

    async def get_request(self, session_id: str) -> dict[str, Any] | None:
        async with self._db.connect() as conn:
            value = (
                await conn.execute(sa.select(agents_sessions.c.request).where(agents_sessions.c.id == session_id))
            ).scalar()
        return value if isinstance(value, dict) else None

    async def list(
        self,
        *,
        workspace_id: str | None = None,
        run_id: str | None = None,
        task_id: str | None = None,
        ids: Iterable[str] | None = None,
        limit: int = 1000,
    ) -> list[SessionRecord]:
        t = agents_sessions
        stmt = sa.select(t).order_by(t.c.created_at.desc()).limit(limit)
        if workspace_id is not None:
            stmt = stmt.where(t.c.workspace_id == workspace_id)
        if run_id is not None:
            stmt = stmt.where(t.c.run_id == run_id)
        if task_id is not None:
            stmt = stmt.where(t.c.task_id == task_id)
        if ids is not None:
            id_list = list(ids)
            if not id_list:
                return []
            stmt = stmt.where(t.c.id.in_(id_list))
        async with self._db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [_record(r) for r in rows]

    async def update(self, session_id: str, **values: Any) -> None:
        if not values:
            return
        if isinstance(values.get("state"), AgentState):
            values["state"] = values["state"].value
        if isinstance(values.get("last_usage"), Usage):
            values["last_usage"] = values["last_usage"].model_dump(mode="json")
        values["updated_at"] = utcnow()
        async with self._db.begin() as conn:
            await conn.execute(agents_sessions.update().where(agents_sessions.c.id == session_id).values(**values))

    async def find_native(
        self, workspace_id: str, provider: str, native_id: str, location: Location
    ) -> SessionRecord | None:
        t = agents_sessions
        async with self._db.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        sa.select(t).where(
                            t.c.workspace_id == workspace_id, t.c.provider == provider, t.c.native_id == native_id
                        )
                    )
                )
                .mappings()
                .all()
            )
        for row in rows:
            rec = _record(row)
            if rec.location == location:
                return rec
        return None

    async def native_index(self, provider_native: Iterable[tuple[str, str]]) -> dict[tuple[str, str], str]:
        """(provider, native_id) -> session id for sessions already known to the studio."""
        wanted = {(p, n) for p, n in provider_native}
        if not wanted:
            return {}
        t = agents_sessions
        natives = sorted({n for _, n in wanted})
        async with self._db.connect() as conn:
            rows = (
                await conn.execute(sa.select(t.c.id, t.c.provider, t.c.native_id).where(t.c.native_id.in_(natives)))
            ).all()
        return {(str(p), str(n)): str(i) for i, p, n in rows if (p, n) in wanted}

    async def recover_after_restart(self) -> int:
        """Sessions left mid-turn by a previous studiod process are marked interrupted."""
        stale = [s.value for s in (*RUNNING_STATES, *WAITING_STATES)]
        async with self._db.begin() as conn:
            result = await conn.execute(
                agents_sessions.update()
                .where(agents_sessions.c.state.in_(stale))
                .values(state=AgentState.interrupted.value, updated_at=utcnow())
            )
        return int(result.rowcount or 0)
