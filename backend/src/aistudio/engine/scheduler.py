"""Task queue dispatcher and cron schedules (spec §18: öncelikli kuyruk, cron, limit sıfırlanınca başlat).

* Queued tasks start in priority order (higher first, then oldest) while fewer than
  ``engine.max_concurrent_runs`` runs are actively running. Runs that only wait for an approval
  or a limit reset do not hold a slot.
* ``scheduled_at`` and ``hold_until`` (limit reset) delay a queued task.
* Cron schedules create tasks from their template and emit ``schedule.fired``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

from aistudio.contracts.engine import TaskCreate
from aistudio.core.clock import utcnow
from aistudio.core.errors import StudioError, ValidationFailed
from aistudio.core.events import ET, Severity
from aistudio.engine.models import Schedule
from aistudio.engine.store import task_from_row

if TYPE_CHECKING:
    from aistudio.engine.service import FlowEngineImpl

log = logging.getLogger(__name__)


def validate_cron(cron: str, timezone: str) -> None:
    if not croniter.is_valid(cron):
        raise ValidationFailed("Cron ifadesi geçersiz.", details={"cron": cron})
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValidationFailed("Saat dilimi tanınmadı.", details={"timezone": timezone}) from None


def next_fire(cron: str, timezone: str, after: datetime) -> datetime:
    tz = ZoneInfo(timezone)
    nxt = croniter(cron, after.astimezone(tz)).get_next(datetime)
    if nxt.tzinfo is None:
        nxt = nxt.replace(tzinfo=tz)
    return nxt.astimezone(UTC)


class Scheduler:
    def __init__(self, engine: FlowEngineImpl) -> None:
        self.engine = engine
        self._wake = asyncio.Event()
        self._lock = asyncio.Lock()

    def wake(self) -> None:
        self._wake.set()

    async def run_forever(self) -> None:
        while True:
            try:
                delay = await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("engine scheduler tick failed")
                delay = 30.0
            self._wake.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), timeout=delay)

    async def tick(self, now: datetime | None = None) -> float:
        """Fire due schedules, start queued tasks; return seconds until the next useful tick."""
        now = now or utcnow()
        await self.fire_due(now)
        await self.dispatch(now)
        interval = max(0.05, await self.engine.rt.float_setting("engine.scheduler_interval_seconds"))
        upcoming = [t for t in await self._next_times() if t is not None]
        if upcoming:
            soonest = (min(upcoming) - utcnow()).total_seconds()
            return max(0.05, min(interval, soonest))
        return interval

    async def _next_times(self) -> list[datetime | None]:
        store = self.engine.rt.store
        times: list[datetime | None] = [await store.next_schedule_time()]
        for row in await store.list_task_rows(statuses=["queued"], order="queue", limit=500):
            times.append(row["scheduled_at"])
            times.append(row["hold_until"])
        return times

    # ------------------------------------------------------------------ cron
    async def fire_due(self, now: datetime) -> list[str]:
        created: list[str] = []
        for sched in await self.engine.rt.store.due_schedules(now):
            task_id = await self.fire(sched, now=now)
            if task_id:
                created.append(task_id)
        return created

    async def fire(self, sched: Schedule, *, now: datetime | None = None, manual: bool = False) -> str | None:
        now = now or utcnow()
        store = self.engine.rt.store
        tpl = sched.template
        next_at = next_fire(sched.cron, sched.timezone, now) if sched.enabled else None
        # Advance first so a failing template cannot fire in a tight loop.
        await store.update_schedule(sched.id, next_run_at=next_at, last_run_at=now)
        try:
            task = await self.engine.create_task(
                TaskCreate(
                    workspace_id=sched.workspace_id,
                    title=tpl.title,
                    prompt=tpl.prompt,
                    mode=tpl.mode,
                    flow_id=tpl.flow_id,
                    studio_id=tpl.studio_id,
                    team_id=tpl.team_id,
                    repo_ids=tpl.repo_ids,
                    base_ref=tpl.base_ref,
                    inputs=dict(tpl.inputs),
                    budget=tpl.budget,
                    priority=tpl.priority,
                    source="schedule",
                    source_ref={"schedule_id": sched.id, "manual": manual},
                    start=True,
                ),
                dispatch=False,
            )
        except StudioError as e:
            await self.engine.rt.emit(
                "schedule.failed",
                {"schedule_id": sched.id, "name": sched.name, "error": e.message},
                severity=Severity.high,
                workspace_id=sched.workspace_id,
            )
            return None
        await store.update_schedule(sched.id, last_task_id=task.id)
        await self.engine.rt.emit(
            ET.SCHEDULE_FIRED,
            {
                "schedule_id": sched.id,
                "name": sched.name,
                "task_id": task.id,
                "manual": manual,
                "next_run_at": next_at.isoformat() if next_at else None,
            },
            severity=Severity.normal,
            workspace_id=sched.workspace_id,
            task_id=task.id,
        )
        self.wake()
        return task.id

    # ------------------------------------------------------------------ queue
    async def dispatch(self, now: datetime | None = None) -> list[str]:
        async with self._lock:
            return await self._dispatch(now or utcnow())

    async def _dispatch(self, now: datetime) -> list[str]:
        engine = self.engine
        rt = engine.rt
        max_runs = max(1, await rt.int_setting("engine.max_concurrent_runs"))
        capacity = max_runs - engine.active_run_count()
        started: list[str] = []
        if capacity <= 0:
            return started
        poll = max(0.01, await rt.float_setting("engine.limit_poll_seconds"))
        for row in await rt.store.list_task_rows(statuses=["queued"], order="queue", limit=500):
            if capacity <= 0:
                break
            if row["scheduled_at"] is not None and row["scheduled_at"] > now:
                continue
            if row["hold_until"] is not None and row["hold_until"] > now:
                continue
            task = task_from_row(row)
            try:
                hold = await engine.limit_hold(task, row, now=now, poll_seconds=poll)
                if hold is not None:
                    until, reason = hold
                    if row["hold_until"] != until or row["hold_reason"] != reason:
                        first_hold = row["hold_reason"] != reason
                        await rt.store.update_task(task.id, hold_until=until, hold_reason=reason)
                        await engine.emit_task(task, "task.updated", {"status": "queued", "hold_reason": reason})
                        if first_hold:
                            # spec §15: "limit doldu ve iş kuyruğa alındı" is a critical alert
                            await engine.emit_task(
                                task,
                                "task.limit_hold",
                                {"reason": reason, "hold_until": until.isoformat()},
                                severity=Severity.critical,
                            )
                    continue
                await engine.start(task.id)
                started.append(task.id)
                capacity -= 1
            except StudioError as e:
                await rt.store.update_task(task.id, status="failed", error=e.message, finished_at=utcnow())
                await engine.emit_task(task, "task.failed", {"error": e.message}, severity=Severity.high)
        return started
