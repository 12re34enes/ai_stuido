"""Subscription limit tracking (spec §17): ``LimitService``.

Recording
    Adapters report windows through the session sink (``record``) or on request
    (``refresh`` -> ``AgentAdapter.read_limits``). The service keeps the latest value per
    (provider, window) in memory and persists a ``limits_snapshots`` row only for meaningful
    changes: first observation, ≥1 point change, status change, a moved reset time or a reset.

Events
    limit.updated    (info)      {provider, window, label, used_percent, resets_at, ..., previous_percent}
    limit.warning    (normal)    crossed ``limits.warning_percent`` (default 80) or CLI warning status
    limit.exhausted  (critical)  window is full (≥100% or CLI says rejected)
    limit.reset      (info)      window reset: its reset time passed (synthesised by the
                                 background check) or usage dropped sharply (≥10 points)

Per-task attribution (approximation)
    Token counts, agent time and turns come exactly from ``agent.usage`` events carrying the
    task id (adapters emit one non-partial ``Usage`` per turn with that turn's increments;
    live ``partial`` running totals are skipped). Limit
    *percentages* are only reported per account, so every positive change of a window is split
    equally across the provider's tasks that were active (a turn running, or any turn/usage
    event) since the previous observation of that window. Concurrent tasks of very different
    weight therefore share the cost evenly, and usage by sessions outside AI Studio is charged
    to whatever AI Studio task was active. Good enough for budgets expressed in percent; not an
    accounting tool.

    ``UsageTotals.by_provider[provider]`` holds ``input_tokens``, ``output_tokens``, ``turns``,
    ``duration_ms``, the aggregated ``five_hour`` / ``weekly`` percentages and one
    ``window:<name>`` entry per attributed window (e.g. ``window:seven_day_opus``). The top-level
    ``*_percent_spent`` fields sum the five-hour / weekly classes over all providers.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import ValidationError
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from aistudio.contracts.agents import AdapterRegistry, AgentManager, AgentState, Usage
from aistudio.contracts.common import Provider
from aistudio.contracts.limits import Budget, BudgetCheck, LimitWindow, UsageTotals
from aistudio.contracts.transport import Transport
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import StudioError
from aistudio.core.eventlog import SubscriberLagged
from aistudio.core.events import ET, Event, EventFilter, Severity
from aistudio.limits.tables import limits_snapshots, limits_task_usage

log = logging.getLogger(__name__)

SETTING_REFRESH_MINUTES = "limits.refresh_minutes"
SETTING_WARNING_PERCENT = "limits.warning_percent"
DEFAULT_REFRESH_MINUTES = 5
DEFAULT_WARNING_PERCENT = 80.0

MEANINGFUL_DELTA = 1.0  # percentage points
RESET_DROP_POINTS = 10.0
RESET_SHIFT = timedelta(minutes=5)
RESET_CHECK_SECONDS = 30.0
INITIAL_REFRESH_DELAY = 5.0
_RESET_TEMPLATE: dict[str, Any] = {"used_percent": 0.0, "status": "ok", "resets_at": None, "source": "estimate"}
_READ_LIMITS_TIMEOUT = 60.0

PROVIDER_NAMES: dict[str, str] = {"claude": "Claude", "codex": "Codex"}
WindowClass = Literal["five_hour", "weekly", "model", "other"]

_BUCKET_KEYS = ("input_tokens", "output_tokens", "turns", "duration_ms", "five_hour", "weekly")
_RUNNING = {s.value for s in (AgentState.thinking, AgentState.responding, AgentState.running_tool)}
_RESTING = {s.value for s in (AgentState.idle, AgentState.done, AgentState.error, AgentState.interrupted)}
_ACTIVITY_EVENTS = frozenset({ET.AGENT_TURN_STARTED, ET.AGENT_USAGE, ET.AGENT_TOOL_CALL, ET.AGENT_MESSAGE})
_TRACKED_EVENTS = [
    "agent.session.created",
    ET.AGENT_TURN_STARTED,
    ET.AGENT_TURN_COMPLETED,
    ET.AGENT_STATUS,
    ET.AGENT_USAGE,
    ET.AGENT_TOOL_CALL,
    ET.AGENT_MESSAGE,
    ET.AGENT_SESSION_ENDED,
]


def window_class(w: LimitWindow) -> WindowClass:
    name = w.window
    if name == "five_hour":
        return "five_hour"
    if name == "seven_day":
        return "weekly"
    if name.startswith(("five_hour_", "seven_day_")):
        return "model"  # model-specific window (e.g. seven_day_opus)
    minutes = w.window_minutes
    if minutes is not None:
        if 240 <= minutes <= 360:
            return "five_hour"
        if 9000 <= minutes <= 11000:
            return "weekly"
    if name == "primary":
        return "five_hour"
    if name == "secondary":
        return "weekly"
    return "other"


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def human_duration(delta: timedelta) -> str:
    """Turkish, compact: '2 sa 15 dk', '3 gün 4 sa', '1 dakikadan az'."""
    minutes = int(delta.total_seconds() // 60)
    if minutes < 1:
        return "1 dakikadan az"
    days, rem = divmod(minutes, 1440)
    hours, mins = divmod(rem, 60)
    if days:
        return f"{days} gün {hours} sa" if hours else f"{days} gün"
    if hours:
        return f"{hours} sa {mins} dk" if mins else f"{hours} sa"
    return f"{mins} dk"


def _pct(value: float) -> str:
    return f"%{value:.1f}".replace(".", ",")


def _is_reset(prev: LimitWindow, new: LimitWindow) -> bool:
    if prev.used_percent - new.used_percent >= RESET_DROP_POINTS:
        return True
    if prev.resets_at is not None and new.observed_at >= prev.resets_at:
        if new.used_percent < prev.used_percent:
            return True
        if new.resets_at is not None and new.resets_at > prev.resets_at:
            return True
    return False


def _resets_moved(old: LimitWindow, new: LimitWindow) -> bool:
    if old.resets_at is None or new.resets_at is None:
        return (old.resets_at is None) != (new.resets_at is None)
    return abs(new.resets_at - old.resets_at) > RESET_SHIFT


def _row(w: LimitWindow) -> dict[str, Any]:
    return w.model_dump(mode="python")


class LimitServiceImpl:
    def __init__(self, ctx: AppContext) -> None:
        self._ctx = ctx
        self._lock = asyncio.Lock()
        self._loaded = False
        self._current: dict[tuple[str, str], LimitWindow] = {}
        self._persisted: dict[tuple[str, str], LimitWindow] = {}
        # attribution state
        self._sessions: dict[str, tuple[str, str | None] | None] = {}  # session -> (provider, task) | unknown
        self._running: dict[str, set[str]] = defaultdict(set)  # provider -> sessions with a running turn
        self._activity: dict[str, dict[str, float]] = defaultdict(dict)  # provider -> task -> monotonic
        self._observed: dict[tuple[str, str], float] = {}  # (provider, window) -> monotonic of last record

    # ------------------------------------------------------------------ lifecycle
    def start(self) -> None:
        self._ctx.spawn(self._consume_agent_events(), name="limits-activity")
        self._ctx.spawn(self._refresh_loop(), name="limits-refresh")
        self._ctx.spawn(self._reset_loop(), name="limits-reset-check")

    async def _setting_float(self, key: str, default: float) -> float:
        try:
            value = await self._ctx.store.get(key)
        except Exception:
            return default
        return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else default

    async def _load(self) -> None:
        if self._loaded:
            return
        t = limits_snapshots
        latest = sa.select(sa.func.max(t.c.id)).group_by(t.c.provider, t.c.window).scalar_subquery()
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(sa.select(t).where(t.c.id.in_(latest)))).mappings().all()
        for r in rows:
            w = LimitWindow(**{k: v for k, v in r.items() if k != "id"})
            self._current[(w.provider, w.window)] = w
            self._persisted[(w.provider, w.window)] = w
        self._loaded = True

    # ------------------------------------------------------------------ recording
    def _normalize(self, w: LimitWindow, warn_at: float) -> LimitWindow:
        used = min(100.0, max(0.0, float(w.used_percent)))
        if w.status == "exhausted" or used >= 100.0:
            status: Literal["ok", "warning", "exhausted"] = "exhausted"
        elif w.status == "warning" or used >= warn_at:
            status = "warning"
        else:
            status = "ok"
        return w.model_copy(
            update={
                "used_percent": used,
                "status": status,
                "observed_at": _aware(w.observed_at),
                "resets_at": _aware(w.resets_at) if w.resets_at is not None else None,
            }
        )

    async def record(self, windows: list[LimitWindow]) -> None:
        if not windows:
            return
        warn_at = await self._setting_float(SETTING_WARNING_PERCENT, DEFAULT_WARNING_PERCENT)
        async with self._lock:
            await self._load()
            for w in windows:
                await self._record_one(self._normalize(w, warn_at))

    async def _record_one(self, w: LimitWindow) -> None:
        key = (w.provider, w.window)
        prev = self._current.get(key)
        last = self._persisted.get(key)
        reset = prev is not None and _is_reset(prev, w)
        self._current[key] = w
        now_mono = time.monotonic()
        since = self._observed.get(key)
        self._observed[key] = now_mono

        if prev is not None and w.source != "estimate":
            delta = w.used_percent if reset else w.used_percent - prev.used_percent
            if delta > 0:
                await self._attribute(w, delta, since)

        meaningful = (
            last is None
            or reset
            or abs(w.used_percent - last.used_percent) >= MEANINGFUL_DELTA
            or w.status != last.status
            or _resets_moved(last, w)
        )
        if meaningful:
            async with self._ctx.db.begin() as conn:
                await conn.execute(limits_snapshots.insert().values(**_row(w)))
            self._persisted[key] = w

        info = {
            "provider": w.provider,
            "window": w.window,
            "label": w.label,
            "used_percent": w.used_percent,
            "resets_at": w.resets_at.isoformat() if w.resets_at else None,
            "window_minutes": w.window_minutes,
            "status": w.status,
            "source": w.source,
            "observed_at": w.observed_at.isoformat(),
        }
        events = self._ctx.events
        if reset and prev is not None:
            await events.append(ET.LIMIT_RESET, {**info, "previous_percent": prev.used_percent})
        if meaningful:
            await events.append(
                ET.LIMIT_UPDATED, {**info, "previous_percent": last.used_percent if last is not None else None}
            )
        was_exhausted = prev is not None and prev.status == "exhausted" and not reset
        was_warning = prev is not None and prev.status in ("warning", "exhausted") and not reset
        if w.status == "exhausted" and not was_exhausted:
            await events.append(ET.LIMIT_EXHAUSTED, info, severity=Severity.critical)
        elif w.status == "warning" and not was_warning:
            await events.append(ET.LIMIT_WARNING, info, severity=Severity.normal)

    async def _attribute(self, w: LimitWindow, delta: float, since: float | None) -> None:
        provider = w.provider
        tasks: set[str] = set()
        for sid in self._running.get(provider, set()):
            info = self._sessions.get(sid)
            if info is not None and info[1]:
                tasks.add(info[1])
        for task, ts in self._activity.get(provider, {}).items():
            if since is None or ts >= since:
                tasks.add(task)
        if not tasks:
            return
        share = delta / len(tasks)
        now = utcnow()
        cls = window_class(w)
        t = limits_task_usage
        async with self._ctx.db.begin() as conn:
            for task in sorted(tasks):
                stmt = sqlite_insert(t).values(
                    task_id=task, provider=provider, window=w.window, window_class=cls, percent=share, updated_at=now
                )
                stmt = stmt.on_conflict_do_update(
                    index_elements=[t.c.task_id, t.c.provider, t.c.window],
                    set_={"percent": t.c.percent + share, "updated_at": now, "window_class": cls},
                )
                await conn.execute(stmt)

    # ------------------------------------------------------------------ activity tracking
    def observe(self, ev: Event) -> None:
        """Feed an ``agent.*`` event into the activity tracker (used for attribution)."""
        sid = ev.session_id
        if not sid:
            return
        if ev.type == "agent.session.created":
            provider = ev.payload.get("provider")
            if isinstance(provider, str):
                self._sessions[sid] = (provider, ev.task_id)
            return
        info = self._sessions.get(sid)
        if info is None:
            return
        provider, task = info
        now = time.monotonic()
        running = self._running[provider]
        if ev.type in _ACTIVITY_EVENTS:
            if ev.type == ET.AGENT_TURN_STARTED:
                running.add(sid)
            if task:
                self._activity[provider][task] = now
        elif ev.type == ET.AGENT_STATUS:
            state = ev.payload.get("state")
            if state in _RUNNING:
                running.add(sid)
                if task:
                    self._activity[provider][task] = now
            elif state in _RESTING:
                running.discard(sid)
        elif ev.type in (ET.AGENT_TURN_COMPLETED, ET.AGENT_SESSION_ENDED):
            if task:
                self._activity[provider][task] = now
            running.discard(sid)

    def is_tracking(self, session_id: str) -> bool:
        """True while the session has a running turn (counts as active for attribution)."""
        return any(session_id in sessions for sessions in self._running.values())

    async def _resolve_session(self, session_id: str) -> None:
        if session_id in self._sessions:
            return
        manager = self._ctx.services.maybe(AgentManager)  # type: ignore[type-abstract]
        if manager is None:
            self._sessions[session_id] = None
            return
        try:
            rec = await manager.get(session_id)
        except StudioError:
            self._sessions[session_id] = None
            return
        self._sessions[session_id] = (rec.provider, rec.task_id)

    async def handle_event(self, ev: Event) -> None:
        if ev.session_id and ev.type != "agent.session.created":
            await self._resolve_session(ev.session_id)
        self.observe(ev)

    async def _consume_agent_events(self) -> None:
        flt = EventFilter(types=list(_TRACKED_EVENTS), include_ephemeral=False)
        while True:
            try:
                async with self._ctx.events.subscribe(flt) as stream:
                    async for ev in stream:
                        try:
                            await self.handle_event(ev)
                        except Exception:
                            log.exception("limit activity tracking failed for event %s", ev.id)
            except SubscriberLagged:
                log.warning("limits activity tracker lagged; resubscribing")

    # ------------------------------------------------------------------ queries
    async def current(self, provider: Provider | None = None) -> list[LimitWindow]:
        async with self._lock:
            await self._load()
            items = [w for w in self._current.values() if provider is None or w.provider == provider]
        return sorted(items, key=lambda w: (w.provider, w.window))

    async def is_available(self, provider: Provider) -> BudgetCheck:
        now = utcnow()
        blocking = [
            w
            for w in await self.current(provider)
            if w.status == "exhausted" and window_class(w) != "model" and (w.resets_at is None or w.resets_at > now)
        ]
        if not blocking:
            return BudgetCheck(ok=True)
        resets = [w.resets_at for w in blocking if w.resets_at is not None]
        resets_at = max(resets) if resets and len(resets) == len(blocking) else None
        name = PROVIDER_NAMES.get(provider, provider)
        labels = ", ".join(w.label for w in blocking)
        reason = f"{name} limiti doldu ({labels})."
        if resets_at is not None:
            reason += f" Yaklaşık {human_duration(resets_at - now)} sonra sıfırlanacak."
        else:
            reason += " Sıfırlanma zamanı bilinmiyor."
        return BudgetCheck(ok=False, reason=reason, resets_at=resets_at)

    async def _provider_of(self, session_id: str | None) -> str:
        if not session_id:
            return "unknown"
        await self._resolve_session(session_id)
        info = self._sessions.get(session_id)
        return info[0] if info is not None else "unknown"

    async def task_usage(self, task_id: str) -> UsageTotals:
        totals = UsageTotals()
        by_provider: dict[str, dict[str, float]] = {}

        def bucket(provider: str) -> dict[str, float]:
            return by_provider.setdefault(provider, dict.fromkeys(_BUCKET_KEYS, 0.0))

        after = 0
        page = 1000
        flt = EventFilter(types=[ET.AGENT_USAGE], task_id=task_id)
        while True:
            batch = await self._ctx.events.query(flt, after_id=after, limit=page)
            for ev in batch:
                try:
                    u = Usage.model_validate(ev.payload)
                except ValidationError:
                    continue
                if u.partial:
                    continue  # running total inside a turn; the turn's final usage follows
                totals.input_tokens += u.input_tokens
                totals.output_tokens += u.output_tokens
                totals.duration_ms += u.duration_ms or 0
                totals.turns += 1
                b = bucket(await self._provider_of(ev.session_id))
                b["input_tokens"] += u.input_tokens
                b["output_tokens"] += u.output_tokens
                b["duration_ms"] += u.duration_ms or 0
                b["turns"] += 1
            if len(batch) < page:
                break
            after = batch[-1].id

        t = limits_task_usage
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(sa.select(t).where(t.c.task_id == task_id))).mappings().all()
        for r in rows:
            b = bucket(str(r["provider"]))
            percent = float(r["percent"])
            key = f"window:{r['window']}"
            b[key] = b.get(key, 0.0) + percent
            if r["window_class"] == "five_hour":
                b["five_hour"] += percent
                totals.five_hour_percent_spent += percent
            elif r["window_class"] == "weekly":
                b["weekly"] += percent
                totals.weekly_percent_spent += percent
        totals.by_provider = by_provider
        return totals

    async def check_budget(self, provider: Provider, budget: Budget, *, task_id: str) -> BudgetCheck:
        available = await self.is_available(provider)
        if not available.ok:
            return available
        limited = (
            budget.max_five_hour_percent,
            budget.max_weekly_percent,
            budget.max_turns,
            budget.max_duration_minutes,
        )
        if all(v is None for v in limited):
            return BudgetCheck(ok=True)
        usage = await self.task_usage(task_id)
        spent = usage.by_provider.get(provider, {})
        name = PROVIDER_NAMES.get(provider, provider)
        windows = await self.current(provider)

        def resets_for(cls: WindowClass) -> datetime | None:
            return next((w.resets_at for w in windows if window_class(w) == cls and w.resets_at), None)

        five = spent.get("five_hour", 0.0)
        if budget.max_five_hour_percent is not None and five >= budget.max_five_hour_percent:
            return BudgetCheck(
                ok=False,
                reason=(
                    f"Görev bütçesi doldu: {name} 5 saatlik penceresinde bu görevin kullandığı "
                    f"{_pct(five)}, sınır {_pct(budget.max_five_hour_percent)}."
                ),
                resets_at=resets_for("five_hour"),
            )
        weekly = spent.get("weekly", 0.0)
        if budget.max_weekly_percent is not None and weekly >= budget.max_weekly_percent:
            return BudgetCheck(
                ok=False,
                reason=(
                    f"Görev bütçesi doldu: {name} haftalık penceresinde bu görevin kullandığı "
                    f"{_pct(weekly)}, sınır {_pct(budget.max_weekly_percent)}."
                ),
                resets_at=resets_for("weekly"),
            )
        if budget.max_turns is not None and usage.turns >= budget.max_turns:
            return BudgetCheck(ok=False, reason=f"Görev tur sınırına ulaştı ({usage.turns}/{budget.max_turns}).")
        if budget.max_duration_minutes is not None and usage.duration_ms >= budget.max_duration_minutes * 60_000:
            return BudgetCheck(
                ok=False, reason=f"Görev süre sınırına ulaştı ({budget.max_duration_minutes} dk ajan çalışma süresi)."
            )
        return BudgetCheck(ok=True)

    async def history(
        self, *, provider: Provider | None = None, window: str | None = None, limit: int = 500
    ) -> list[LimitWindow]:
        t = limits_snapshots
        stmt = sa.select(t).order_by(t.c.id.desc()).limit(max(1, min(limit, 5000)))
        if provider is not None:
            stmt = stmt.where(t.c.provider == provider)
        if window is not None:
            stmt = stmt.where(t.c.window == window)
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [LimitWindow(**{k: v for k, v in r.items() if k != "id"}) for r in reversed(rows)]

    # ------------------------------------------------------------------ refresh / reset detection
    async def refresh(self) -> None:
        registry = self._ctx.services.maybe(AdapterRegistry)  # type: ignore[type-abstract]
        transport = self._ctx.services.maybe(Transport)  # type: ignore[type-abstract]
        if registry is None or transport is None:
            return

        async def one(adapter: Any) -> list[LimitWindow]:
            try:
                return await asyncio.wait_for(adapter.read_limits(transport), timeout=_READ_LIMITS_TIMEOUT)
            except Exception:
                log.exception("reading limits failed for %s", getattr(adapter, "provider", "?"))
                return []

        results = await asyncio.gather(*(one(a) for a in registry.all()))
        windows = [w for batch in results for w in batch]
        if windows:
            await self.record(windows)

    async def check_resets(self) -> int:
        """Synthesise a reset for windows whose reset time has passed (no fresh data needed)."""
        now = utcnow()
        due = [
            w.model_copy(update={**_RESET_TEMPLATE, "observed_at": now})
            for w in await self.current()
            if w.resets_at is not None and w.resets_at <= now and w.used_percent > 0
        ]
        if due:
            await self.record(due)
        return len(due)

    async def _refresh_loop(self) -> None:
        await asyncio.sleep(INITIAL_REFRESH_DELAY)
        while True:
            minutes = await self._setting_float(SETTING_REFRESH_MINUTES, DEFAULT_REFRESH_MINUTES)
            if minutes > 0:
                try:
                    await self.refresh()
                except Exception:
                    log.exception("limit refresh failed")
            await asyncio.sleep(max(30.0, minutes * 60) if minutes > 0 else 60.0)

    async def _reset_loop(self) -> None:
        while True:
            await asyncio.sleep(RESET_CHECK_SECONDS)
            try:
                await self.check_resets()
            except Exception:
                log.exception("limit reset check failed")
