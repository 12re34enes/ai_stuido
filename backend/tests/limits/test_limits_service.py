"""LimitServiceImpl: snapshots, events, availability, attribution, budgets, refresh."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import pytest
from limits_helpers import LimitsAdapter, win

from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.agents.transport_local import LocalTransport
from aistudio.contracts.agents import AdapterRegistry, Usage
from aistudio.contracts.limits import Budget
from aistudio.contracts.transport import Transport
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.events import Event, EventFilter, Severity
from aistudio.limits.service import LimitServiceImpl, human_duration, window_class


@pytest.fixture
async def svc(ctx: AppContext) -> LimitServiceImpl:
    await ctx.db.create_all()
    return LimitServiceImpl(ctx)


async def limit_events(ctx: AppContext, *types: str) -> list[Event]:
    return await ctx.events.query(EventFilter(types=list(types) or ["limit.*"]))


async def feed(
    ctx: AppContext, svc: LimitServiceImpl, type: str, session_id: str, task_id: str | None, **data: Any
) -> None:
    ev = await ctx.events.append(type, data, session_id=session_id, task_id=task_id)
    await svc.handle_event(ev)


async def test_only_meaningful_changes_are_persisted(ctx: AppContext, svc: LimitServiceImpl) -> None:
    for used in (10, 10.4, 10.9, 11.2):
        await svc.record([win(used)])
    assert [h.used_percent for h in await svc.history(provider="claude")] == [10, 11.2]
    (cur,) = await svc.current("claude")
    assert cur.used_percent == 11.2
    updated = await limit_events(ctx, "limit.updated")
    assert [e.payload["previous_percent"] for e in updated] == [None, 10]
    assert updated[0].payload["label"] == "5 saat" and updated[0].severity == Severity.info

    soon = utcnow() + timedelta(hours=2)
    await svc.record([win(11.3, resets_at=soon)])  # reset time appeared -> meaningful
    await svc.record([win(11.4, resets_at=soon + timedelta(minutes=1))])  # small shift -> not
    assert len(await svc.history()) == 3
    await svc.record([win(-5), win(130, provider="codex")])  # clamped
    assert [w.used_percent for w in await svc.current()] == [0.0, 100.0]


async def test_warning_and_exhausted_fire_once(ctx: AppContext, svc: LimitServiceImpl) -> None:
    for used in (70, 85, 90):
        await svc.record([win(used)])
    (warning,) = await limit_events(ctx, "limit.warning")
    assert warning.severity == Severity.normal and warning.payload["used_percent"] == 85
    assert (await svc.current())[0].status == "warning"

    for _ in range(2):
        await svc.record([win(100, resets_in=timedelta(hours=2, minutes=10))])
    (exhausted,) = await limit_events(ctx, "limit.exhausted")
    assert exhausted.severity == Severity.critical
    check = await svc.is_available("claude")
    assert not check.ok and check.resets_at is not None
    assert (
        check.reason is not None and "Claude limiti doldu (5 saat)" in check.reason and "sıfırlanacak" in check.reason
    )
    assert (await svc.is_available("codex")).ok

    await svc.record([win(50, provider="codex", status="exhausted")])  # CLI says rejected
    codex = await svc.is_available("codex")
    assert not codex.ok and codex.reason is not None and "bilinmiyor" in codex.reason


async def test_custom_warning_threshold(ctx: AppContext, svc: LimitServiceImpl) -> None:
    await ctx.store.set("limits.warning_percent", 60)
    await svc.record([win(50)])
    await svc.record([win(65)])
    assert len(await limit_events(ctx, "limit.warning")) == 1


async def test_reset_by_sharp_drop_rearms_warning(ctx: AppContext, svc: LimitServiceImpl) -> None:
    await svc.record([win(90)])
    await svc.record([win(3)])
    (reset,) = await limit_events(ctx, "limit.reset")
    assert reset.payload["previous_percent"] == 90 and reset.payload["used_percent"] == 3
    assert reset.severity == Severity.info
    await svc.record([win(85)])
    assert len(await limit_events(ctx, "limit.warning")) == 2


async def test_reset_when_reset_time_passes(ctx: AppContext, svc: LimitServiceImpl) -> None:
    past = utcnow() - timedelta(minutes=1)
    await svc.record([win(100, resets_at=past, observed_at=past - timedelta(hours=1))])
    assert (await svc.is_available("claude")).ok  # stale exhaustion is not blocking
    assert await svc.check_resets() == 1
    (reset,) = await limit_events(ctx, "limit.reset")
    assert reset.payload["previous_percent"] == 100
    (cur,) = await svc.current()
    assert (cur.used_percent, cur.status, cur.source, cur.resets_at) == (0.0, "ok", "estimate", None)
    assert await svc.check_resets() == 0
    await svc.record([win(2, resets_in=timedelta(hours=5))])
    assert len(await limit_events(ctx, "limit.reset")) == 1


async def test_reset_by_window_rollover(ctx: AppContext, svc: LimitServiceImpl) -> None:
    t0 = utcnow()
    await svc.record([win(40, resets_at=t0, observed_at=t0 - timedelta(hours=1))])
    await svc.record([win(41, resets_at=t0 + timedelta(hours=5), observed_at=t0 + timedelta(minutes=1))])
    assert len(await limit_events(ctx, "limit.reset")) == 1


async def test_model_specific_windows_do_not_block(ctx: AppContext, svc: LimitServiceImpl) -> None:
    await svc.record([win(100, window="seven_day_opus", minutes=10080)])
    assert (await svc.is_available("claude")).ok
    await svc.record([win(100, window="seven_day", minutes=10080, resets_in=timedelta(days=3, hours=4, minutes=30))])
    check = await svc.is_available("claude")
    assert not check.ok and check.reason is not None and "Haftalık" in check.reason and "3 gün 4 sa" in check.reason


async def test_attribution_splits_across_active_tasks(ctx: AppContext, svc: LimitServiceImpl) -> None:
    for sid, task in (("s1", "t1"), ("s2", "t2")):
        await feed(ctx, svc, "agent.session.created", sid, task, provider="claude")
        await feed(ctx, svc, "agent.turn.started", sid, task, turn_id="x", input="go")
    await feed(ctx, svc, "agent.session.created", "s3", "t3", provider="codex")
    await feed(ctx, svc, "agent.turn.started", "s3", "t3", turn_id="y", input="go")

    await svc.record([win(10)])  # first observation: no baseline
    await svc.record([win(20)])  # +10 -> 5 / 5
    await feed(ctx, svc, "agent.turn.completed", "s2", "t2", turn_id="x", status="success")
    await svc.record([win(26)])  # t2 was active since the last observation -> 3 / 3
    await svc.record([win(30)])  # only t1 still running -> +4
    await svc.record([win(28)])  # decrease: nothing attributed
    await svc.record([win(50, window="seven_day", minutes=10080)])
    await svc.record([win(52, window="seven_day", minutes=10080)])  # t1 only

    for _ in range(2):
        await ctx.events.append(
            "agent.usage",
            Usage(input_tokens=100, output_tokens=40, duration_ms=1500).model_dump(mode="json"),
            session_id="s1",
            task_id="t1",
        )
    u1 = await svc.task_usage("t1")
    assert u1.five_hour_percent_spent == pytest.approx(12)
    assert u1.weekly_percent_spent == pytest.approx(2)
    assert (u1.input_tokens, u1.output_tokens, u1.turns, u1.duration_ms) == (200, 80, 2, 3000)
    claude = u1.by_provider["claude"]
    assert claude["input_tokens"] == 200 and claude["five_hour"] == pytest.approx(12)
    assert claude["window:seven_day"] == pytest.approx(2) and claude["window:five_hour"] == pytest.approx(12)
    u2 = await svc.task_usage("t2")
    assert u2.five_hour_percent_spent == pytest.approx(8) and u2.turns == 0
    assert (await svc.task_usage("t3")).five_hour_percent_spent == 0  # codex task, claude window
    assert (await svc.task_usage("nope")).by_provider == {}


async def test_check_budget(ctx: AppContext, svc: LimitServiceImpl) -> None:
    await feed(ctx, svc, "agent.session.created", "s1", "t1", provider="claude")
    await feed(ctx, svc, "agent.turn.started", "s1", "t1", turn_id="x", input="go")
    await svc.record([win(10, resets_in=timedelta(hours=3))])
    await svc.record([win(16, resets_in=timedelta(hours=3))])
    for _ in range(2):
        await ctx.events.append(
            "agent.usage", Usage(duration_ms=30_000).model_dump(mode="json"), session_id="s1", task_id="t1"
        )

    assert (await svc.check_budget("claude", Budget(), task_id="t1")).ok
    over = await svc.check_budget("claude", Budget(max_five_hour_percent=5), task_id="t1")
    assert not over.ok and over.reason is not None and "Görev bütçesi doldu" in over.reason
    assert "%6,0" in over.reason and over.resets_at is not None
    assert (await svc.check_budget("claude", Budget(max_five_hour_percent=50, max_weekly_percent=10), task_id="t1")).ok
    turns = await svc.check_budget("claude", Budget(max_turns=2), task_id="t1")
    assert not turns.ok and turns.reason is not None and "tur sınırına" in turns.reason
    assert (await svc.check_budget("claude", Budget(max_duration_minutes=2), task_id="t1")).ok
    assert not (await svc.check_budget("claude", Budget(max_duration_minutes=1), task_id="t1")).ok
    assert (await svc.check_budget("codex", Budget(max_five_hour_percent=5), task_id="t1")).ok

    await svc.record([win(100, resets_in=timedelta(hours=1))])
    blocked = await svc.check_budget("claude", Budget(), task_id="t1")
    assert not blocked.ok and blocked.reason is not None and "limiti doldu" in blocked.reason


async def test_refresh_reads_adapter_limits(ctx: AppContext, svc: LimitServiceImpl) -> None:
    await svc.refresh()  # no registry/transport yet: no-op
    registry = AdapterRegistryImpl()
    codex = LimitsAdapter("codex", [win(33, provider="codex", window="primary", minutes=300, source="probe")])
    broken = LimitsAdapter("claude", [], error=RuntimeError("app-server down"))
    registry.register(codex)
    registry.register(broken)
    ctx.services.register(AdapterRegistry, registry)  # type: ignore[type-abstract]
    ctx.services.register(Transport, LocalTransport())  # type: ignore[type-abstract]
    await svc.refresh()
    (w,) = await svc.current()
    assert (w.provider, w.used_percent, w.source) == ("codex", 33, "probe")
    assert window_class(w) == "five_hour"
    assert codex.calls == 1 and broken.calls == 1


async def test_state_survives_restart(ctx: AppContext, svc: LimitServiceImpl) -> None:
    await svc.record([win(85)])
    fresh = LimitServiceImpl(ctx)
    (w,) = await fresh.current()
    assert w.used_percent == 85 and w.status == "warning"
    await fresh.record([win(86.5)])
    assert len(await limit_events(ctx, "limit.warning")) == 1


async def test_activity_tracking_from_event_stream(ctx: AppContext, svc: LimitServiceImpl) -> None:
    svc.start()
    await asyncio.sleep(0.05)  # let the subscription attach
    await ctx.events.append("agent.session.created", {"provider": "claude"}, session_id="s9", task_id="t9")
    await ctx.events.append("agent.status", {"state": "thinking"}, session_id="s9", task_id="t9")
    for _ in range(100):
        if svc.is_tracking("s9"):
            break
        await asyncio.sleep(0.01)
    assert svc.is_tracking("s9")
    await ctx.events.append("agent.status", {"state": "idle"}, session_id="s9", task_id="t9")
    for _ in range(100):
        if not svc.is_tracking("s9"):
            break
        await asyncio.sleep(0.01)
    assert not svc.is_tracking("s9")


def test_window_classes_and_durations() -> None:
    assert window_class(win(1, window="five_hour")) == "five_hour"
    assert window_class(win(1, window="seven_day")) == "weekly"
    assert window_class(win(1, window="seven_day_sonnet")) == "model"
    assert window_class(win(1, window="primary", minutes=10080)) == "weekly"
    assert window_class(win(1, window="secondary")) == "weekly"
    assert window_class(win(1, window="custom", minutes=60)) == "other"
    assert human_duration(timedelta(seconds=20)) == "1 dakikadan az"
    assert human_duration(timedelta(minutes=45)) == "45 dk"
    assert human_duration(timedelta(hours=2)) == "2 sa"
    assert human_duration(timedelta(hours=2, minutes=15)) == "2 sa 15 dk"
    assert human_duration(timedelta(days=1)) == "1 gün"
