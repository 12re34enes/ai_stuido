"""Task queue (priority, concurrency, scheduled_at, limit holds) and cron schedules."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from engine_support import EngineEnv, wait_for

from aistudio.contracts.approvals import ApprovalKind
from aistudio.contracts.flows import AgentNodeConfig, FlowGraph, FlowMode, FlowNode, HumanNodeConfig
from aistudio.contracts.limits import LimitWindow
from aistudio.core.clock import utcnow
from aistudio.core.errors import ValidationFailed
from aistudio.engine.models import ScheduleCreate, ScheduleTemplate, ScheduleUpdate
from aistudio.engine.scheduler import next_fire


def one_agent(node_id: str = "work") -> FlowGraph:
    return FlowGraph(nodes=[FlowNode(id=node_id, label="İş", config=AgentNodeConfig(provider="claude", writes=False))])


async def _status(env: EngineEnv, task_id: str) -> str:
    return (await env.engine.get_task(task_id)).status


async def test_max_concurrent_runs_and_priority(env: EngineEnv) -> None:
    await env.ctx.store.set("engine.max_concurrent_runs", 1)
    release = asyncio.Event()

    async def hold(session: Any, _m: str) -> str:
        if session.req.task_id == first.id:
            await release.wait()
        return "ok"

    env.agents.on(hold)
    first = await env.create(FlowMode.custom, graph=one_agent(), title="Birinci")
    await env.run_of(first.id)
    low = await env.create(FlowMode.custom, graph=one_agent(), title="Düşük", priority=0)
    high = await env.create(FlowMode.custom, graph=one_agent(), title="Yüksek", priority=5)
    assert await _status(env, low.id) == "queued" and await _status(env, high.id) == "queued"
    queue = await env.engine.queue()
    assert [q.task.id for q in queue] == [high.id, low.id]
    assert [q.position for q in queue] == [1, 2]

    release.set()
    await env.wait_run((await env.engine.get_task(first.id)).current_run_id or "")
    started = await env.engine.scheduler.dispatch()
    assert started == [high.id]
    assert await _status(env, low.id) == "queued"
    await env.wait_run(await env.run_of(high.id))
    assert await env.engine.scheduler.dispatch() == [low.id]


async def test_waiting_runs_do_not_hold_a_slot(env: EngineEnv) -> None:
    await env.ctx.store.set("engine.max_concurrent_runs", 1)
    waiting_graph = FlowGraph(nodes=[FlowNode(id="h", label="Onay", config=HumanNodeConfig(instructions="Kontrol et"))])
    first = await env.create(FlowMode.custom, graph=waiting_graph)
    run_id = await env.run_of(first.id)
    await env.next_approval(ApprovalKind.custom)
    await env.wait_run(run_id, ("waiting",))
    second = await env.create(FlowMode.custom, graph=one_agent())
    await env.wait_run(await env.run_of(second.id))


async def test_scheduled_at_delays_start(env: EngineEnv) -> None:
    later = utcnow() + timedelta(hours=1)
    task = await env.create(FlowMode.custom, graph=one_agent(), scheduled_at=later)
    assert await _status(env, task.id) == "queued"
    assert await env.engine.scheduler.dispatch() == []
    assert await env.engine.scheduler.dispatch(later + timedelta(seconds=1)) == [task.id]


async def test_exhausted_limits_hold_queued_task_until_reset(env: EngineEnv) -> None:
    resets = utcnow() + timedelta(minutes=10)
    env.limits.exhaust("claude", resets_at=resets)
    task = await env.create(FlowMode.custom, graph=one_agent())
    detail = await env.engine.task_detail(task.id)
    assert detail.task.status == "queued" and detail.task.current_run_id is None
    assert detail.hold_until == resets
    assert detail.hold_reason is not None and "Claude" in detail.hold_reason
    holds = await env.events(types=["task.limit_hold"])
    assert len(holds) == 1 and holds[0].severity == "critical"
    assert await env.engine.scheduler.dispatch(resets - timedelta(minutes=1)) == []
    env.limits.restore("claude")
    assert await env.engine.scheduler.dispatch(resets + timedelta(seconds=1)) == [task.id]


async def test_start_on_reset_holds_until_window_resets(env: EngineEnv) -> None:
    resets = utcnow() + timedelta(minutes=30)
    env.limits.windows["claude"] = [
        LimitWindow(
            provider="claude",
            window="five_hour",
            label="5 saat",
            used_percent=85,
            resets_at=resets,
            observed_at=utcnow(),
        )
    ]
    task = await env.engine.create_task(
        env_task(env, one_agent()),
        start_on_reset=True,
    )
    detail = await env.engine.task_detail(task.id)
    assert detail.start_on_reset and detail.hold_until == resets
    assert detail.task.current_run_id is None
    assert await env.engine.scheduler.dispatch(resets + timedelta(seconds=1)) == [task.id]


def env_task(env: EngineEnv, graph: FlowGraph) -> Any:
    from aistudio.contracts.engine import TaskCreate

    return TaskCreate(workspace_id=env.workspace.id, title="Gece işi", prompt="Bağımlılıkları güncelle", graph=graph)


def test_next_fire_respects_timezone() -> None:
    after = datetime(2026, 10, 2, 7, 0, tzinfo=UTC)  # Friday 10:00 in Istanbul
    nxt = next_fire("0 9 * * 1-5", "Europe/Istanbul", after)
    assert nxt == datetime(2026, 10, 5, 6, 0, tzinfo=UTC)  # Monday 09:00 Istanbul


async def test_cron_schedule_fires_task(env: EngineEnv) -> None:
    sched = await env.engine.create_schedule(
        ScheduleCreate(
            workspace_id=env.workspace.id,
            name="Gece bağımlılık güncellemesi",
            cron="30 2 * * *",
            timezone="Europe/Istanbul",
            template=ScheduleTemplate(title="Bağımlılıklar", prompt="Bağımlılıkları güncelle", mode=FlowMode.single),
        )
    )
    assert sched.next_run_at is not None and sched.next_run_at > utcnow()
    assert sched.next_run_at.astimezone(UTC).hour == 23 and sched.next_run_at.minute == 30

    env.agents.on("güncellendi", node_id="dev")
    created = await env.engine.scheduler.fire_due(sched.next_run_at + timedelta(seconds=1))
    assert len(created) == 1
    task = await env.engine.get_task(created[0])
    assert task.source == "schedule" and task.source_ref == {"schedule_id": sched.id, "manual": False}
    assert task.status == "queued" and task.mode == FlowMode.single
    after = await env.engine.get_schedule(sched.id)
    assert after.last_task_id == task.id
    assert after.next_run_at is not None and after.next_run_at > sched.next_run_at
    fired = await env.events(types=["schedule.fired"])
    assert fired[0].payload["schedule_id"] == sched.id and fired[0].severity == "normal"
    # nothing else is due right after
    assert await env.engine.scheduler.fire_due(sched.next_run_at + timedelta(seconds=2)) == []


async def test_scheduled_team_task_uses_the_chosen_team(env: EngineEnv) -> None:
    sched = await env.engine.create_schedule(
        ScheduleCreate(
            workspace_id=env.workspace.id,
            name="Gece ekibi",
            cron="0 3 * * *",
            template=ScheduleTemplate(
                title="Ekip işi", prompt="Bağımlılıkları güncelle", mode=FlowMode.team, team_id="derin-ekip"
            ),
            enabled=False,
        )
    )
    task = await env.engine.fire_schedule(sched.id)
    assert task.mode == FlowMode.team
    graph = await env.engine.resolve_graph(task)
    (team_node,) = [n for n in graph.nodes if n.config.kind == "team"]
    assert team_node.config.team_id == "derin-ekip"  # type: ignore[union-attr]


async def test_disabled_schedule_and_manual_fire(env: EngineEnv) -> None:
    sched = await env.engine.create_schedule(
        ScheduleCreate(
            workspace_id=env.workspace.id,
            name="Haftalık rapor",
            cron="0 8 * * 1",
            template=ScheduleTemplate(title="Rapor", prompt="Haftalık rapor", mode=FlowMode.council),
            enabled=False,
        )
    )
    assert sched.next_run_at is None
    assert await env.engine.scheduler.fire_due(utcnow() + timedelta(days=30)) == []
    env.agents.on("görüş")
    task = await env.engine.fire_schedule(sched.id)
    assert task.source_ref == {"schedule_id": sched.id, "manual": True}
    updated = await env.engine.update_schedule(sched.id, ScheduleUpdate(enabled=True, cron="0 8 * * 2"))
    assert updated.next_run_at is not None and updated.next_run_at.weekday() in (1, 2)


async def test_schedule_validation(env: EngineEnv) -> None:
    tpl = ScheduleTemplate(title="x", prompt="y")
    with pytest.raises(ValidationFailed, match="Cron"):
        await env.engine.create_schedule(
            ScheduleCreate(workspace_id=env.workspace.id, name="a", cron="bad", template=tpl)
        )
    with pytest.raises(ValidationFailed, match="Saat dilimi"):
        await env.engine.create_schedule(
            ScheduleCreate(
                workspace_id=env.workspace.id, name="a", cron="* * * * *", timezone="Mars/Olympus", template=tpl
            )
        )
    with pytest.raises(ValidationFailed, match="Özel mod"):
        await env.engine.create_schedule(
            ScheduleCreate(
                workspace_id=env.workspace.id,
                name="a",
                cron="* * * * *",
                template=ScheduleTemplate(title="x", prompt="y", mode=FlowMode.custom),
            )
        )


async def test_scheduler_loop_fires_due_schedule(env: EngineEnv) -> None:
    await env.ctx.store.set("engine.scheduler_interval_seconds", 0.05)
    sched = await env.engine.create_schedule(
        ScheduleCreate(
            workspace_id=env.workspace.id,
            name="Sık",
            cron="* * * * *",
            template=ScheduleTemplate(title="x", prompt="y", mode=FlowMode.single),
        )
    )
    await env.engine.store.update_schedule(sched.id, next_run_at=utcnow() - timedelta(seconds=1))
    loop_task = asyncio.create_task(env.engine.scheduler.run_forever())
    try:

        async def fired() -> str | None:
            return (await env.engine.get_schedule(sched.id)).last_task_id

        task_id = await wait_for(fired, 3)
        # the dispatcher picked the new task up as well
        await env.run_of(task_id)
    finally:
        loop_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await loop_task
