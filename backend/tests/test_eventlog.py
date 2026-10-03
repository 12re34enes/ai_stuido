from __future__ import annotations

import asyncio

import pytest
import sqlalchemy as sa

from aistudio.core.context import AppContext
from aistudio.core.eventlog import SubscriberLagged
from aistudio.core.events import EventFilter, Severity
from aistudio.storage.tables import events as events_t


async def test_append_chains_hashes(ctx: AppContext) -> None:
    a = await ctx.events.append("x.one", {"n": 1})
    b = await ctx.events.append("x.two", {"n": 2}, severity=Severity.high, workspace_id="ws_1")
    assert b.prev_hash == a.hash
    assert b.id == a.id + 1
    assert await ctx.events.verify_chain() == (True, None)


async def test_tampering_is_detected(ctx: AppContext) -> None:
    await ctx.events.append("x.one", {"n": 1})
    bad = await ctx.events.append("x.two", {"n": 2})
    await ctx.events.append("x.three", {"n": 3})
    async with ctx.db.begin() as conn:
        await conn.execute(events_t.update().where(events_t.c.id == bad.id).values(payload={"n": 999}))
    ok, first_bad = await ctx.events.verify_chain()
    assert not ok
    assert first_bad == bad.id


async def test_chain_survives_restart(ctx: AppContext) -> None:
    from aistudio.core.eventlog import EventLog

    await ctx.events.append("x.one")
    fresh = EventLog(ctx.db, ctx.masker)  # simulates a new process reading the tail hash
    ev = await fresh.append("x.two")
    assert ev.prev_hash != "0" * 64
    assert await fresh.verify_chain() == (True, None)


async def test_payload_is_masked_before_persisting(ctx: AppContext) -> None:
    ctx.masker.add_secret("hunter2-super-secret")
    ev = await ctx.events.append("x.secret", {"out": "password is hunter2-super-secret ok"})
    assert "hunter2" not in str(ev.payload)
    async with ctx.db.connect() as conn:
        stored = (await conn.execute(sa.select(events_t.c.payload).where(events_t.c.id == ev.id))).scalar()
    assert "hunter2" not in str(stored)


async def test_query_filters_and_prefix_types(ctx: AppContext) -> None:
    await ctx.events.append("agent.message", {}, workspace_id="ws_a", run_id="run_1")
    await ctx.events.append("agent.tool.call", {}, workspace_id="ws_a", run_id="run_2")
    await ctx.events.append("approval.requested", {}, workspace_id="ws_b")
    got = await ctx.events.query(EventFilter(types=["agent.*"]))
    assert [e.type for e in got] == ["agent.message", "agent.tool.call"]
    got = await ctx.events.query(EventFilter(workspace_id="ws_a", run_id="run_2"))
    assert [e.type for e in got] == ["agent.tool.call"]
    latest = await ctx.events.query(limit=1, descending=True)
    assert latest[0].type == "approval.requested"


async def test_subscribe_receives_persisted_and_ephemeral(ctx: AppContext) -> None:
    received = []

    async with ctx.events.subscribe(EventFilter(session_id="s1")) as stream:

        async def consume() -> None:
            async for ev in stream:
                received.append(ev)
                if len(received) == 2:
                    return

        task = asyncio.create_task(consume())
        await asyncio.sleep(0)
        await ctx.events.append("agent.message", {"t": "x"}, session_id="other")
        ctx.events.publish_ephemeral("agent.message.delta", {"t": "he"}, session_id="s1")
        await ctx.events.append("agent.message", {"t": "hello"}, session_id="s1")
        await asyncio.wait_for(task, 2)
    assert [e.type for e in received] == ["agent.message.delta", "agent.message"]
    assert received[0].ephemeral and received[0].id == 0
    assert not received[1].ephemeral and received[1].id > 0


async def test_slow_subscriber_is_marked_lagged(ctx: AppContext, monkeypatch: pytest.MonkeyPatch) -> None:
    from aistudio.core import eventlog

    monkeypatch.setattr(eventlog, "_SUBSCRIBER_QUEUE_SIZE", 3)
    async with ctx.events.subscribe() as stream:
        for i in range(10):
            ctx.events.publish_ephemeral("tick", {"i": i})
        with pytest.raises(SubscriberLagged):
            async for _ in stream:
                pass
