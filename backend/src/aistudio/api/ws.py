"""Live event stream over WebSocket.

``GET /ws/events?token=..&after=<id>&workspace_id=..&run_id=..&session_id=..&types=agent.*,approval.*``

Server -> client messages (JSON):
    {"kind": "event", "event": {...Event...}}       persisted (id > 0) or ephemeral (id == 0)
    {"kind": "ready", "last_id": <int>}             backlog replay finished
    {"kind": "lagged"}                              client fell behind; reconnect with after=<last id>

Replay-then-live without gaps: subscribe first, replay the backlog from the DB, then forward
live events skipping any id already replayed.
"""

from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import WebSocket, WebSocketDisconnect

from aistudio.core.eventlog import EventLog, SubscriberLagged
from aistudio.core.events import Event, EventFilter

_BACKLOG_LIMIT = 2000


def _dump(ev: Event) -> str:
    return json.dumps({"kind": "event", "event": ev.model_dump(mode="json")}, ensure_ascii=False)


async def stream_events(ws: WebSocket, log: EventLog) -> None:
    q = ws.query_params
    types = [t for t in (q.get("types") or "").split(",") if t] or None
    flt = EventFilter(
        types=types,
        workspace_id=q.get("workspace_id"),
        task_id=q.get("task_id"),
        run_id=q.get("run_id"),
        session_id=q.get("session_id"),
        include_ephemeral=q.get("ephemeral", "1") != "0",
    )
    after = int(q["after"]) if q.get("after", "").isdigit() else None

    async with log.subscribe(flt) as live:
        last_id = after or 0
        if after is not None:
            while True:
                backlog = await log.query(flt, after_id=last_id, limit=_BACKLOG_LIMIT)
                for ev in backlog:
                    await ws.send_text(_dump(ev))
                    last_id = ev.id
                if len(backlog) < _BACKLOG_LIMIT:
                    break
        else:
            last_id = await log.last_id()
        await ws.send_text(json.dumps({"kind": "ready", "last_id": last_id}))

        async def pump() -> None:
            async for ev in live:
                if ev.id and ev.id <= last_id:
                    continue
                await ws.send_text(_dump(ev))

        async def watch_close() -> None:
            # We never expect client messages; this returns when the client disconnects.
            with contextlib.suppress(WebSocketDisconnect):
                while True:
                    await ws.receive_text()

        pump_task = asyncio.create_task(pump())
        close_task = asyncio.create_task(watch_close())
        done, pending = await asyncio.wait({pump_task, close_task}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        for t in done:
            exc = t.exception()
            if isinstance(exc, SubscriberLagged):
                with contextlib.suppress(Exception):
                    await ws.send_text(json.dumps({"kind": "lagged"}))
                    await ws.close(code=4001)
            elif exc is not None and not isinstance(exc, WebSocketDisconnect):
                raise exc
