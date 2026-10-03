"""Multi-channel alerts (spec §15).

Pipeline: persisted event -> catalog alert (Turkish, severity) -> mask -> dedup (5 min) ->
grouping (bursts become "3 onay bekliyor") -> routing (rules / defaults) -> quiet hours ->
per-channel rate limit -> delivery with retries -> ``alerts_log`` + ``alert.sent`` /
``alert.failed`` events. Approval messages on Telegram / Slack carry buttons; any decision
(from anywhere) edits those messages to show the outcome.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets as pysecrets
from collections.abc import Callable, Coroutine, Sequence
from datetime import datetime, timedelta
from typing import Any

import aiosmtplib
import httpx
import sqlalchemy as sa

from aistudio.alerts.catalog import build_alert, generic_alert
from aistudio.alerts.channels import (
    DEFAULT_NAMES,
    KIND_SPECS,
    Channel,
    ChannelDeps,
    ChannelError,
    build_channel,
    validate_channel,
)
from aistudio.alerts.channels.base import Action, InteractionResult, SlackSocketFactory, SmtpSend
from aistudio.alerts.channels.slack import sdk_socket_factory
from aistudio.alerts.interactions import ApprovalInteractor
from aistudio.alerts.models import (
    Alert,
    AlertDefaults,
    AlertRule,
    AlertRuleCreate,
    AlertRuleUpdate,
    AlertSettings,
    AlertSettingsUpdate,
    ChannelCreate,
    ChannelKindSpec,
    ChannelOut,
    ChannelUpdate,
    DeliveryLogEntry,
    DeliveryOutcome,
    DeliveryStatus,
    LinkCode,
    QuietHours,
)
from aistudio.alerts.routing import (
    DEFAULT_ROUTING,
    ChannelRecord,
    Deduper,
    Grouper,
    RateLimiter,
    make_group_alert,
    primary_mobile,
    quiet_active,
    route,
)
from aistudio.alerts.tables import alerts_channels, alerts_log, alerts_messages, alerts_rules
from aistudio.contracts.approvals import Approval, ApprovalService, ApprovalStatus
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, NotFound, ValidationFailed
from aistudio.core.eventlog import SubscriberLagged
from aistudio.core.events import ET, Event, EventFilter, Severity
from aistudio.core.ids import new_id
from aistudio.security.secrets import secret_ref

log = logging.getLogger(__name__)

SETTINGS_DEFAULTS: dict[str, Any] = {
    "alerts.enabled": True,
    "alerts.quiet_hours": QuietHours().model_dump(),
    "alerts.dedup_seconds": 300,
    "alerts.group_window_seconds": 60,
    "alerts.rate_limit_per_minute": 20,
    "alerts.primary_channel_id": None,
    "alerts.confirm_timeout_seconds": 120,
}
_LINK_CODE_TTL = timedelta(minutes=10)
_SEND_TIMEOUT = 60.0
_MAX_RETRY_WAIT = 30.0


class AlertService:
    def __init__(
        self,
        ctx: AppContext,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        smtp_send: SmtpSend | None = None,
        slack_socket_factory: SlackSocketFactory | None = None,
        clock: Callable[[], datetime] = utcnow,
        retry_delays: Sequence[float] = (2.0, 8.0),
        telegram_poll_timeout: int = 50,
        telegram_idle_pause: float = 1.0,
        tick_seconds: float = 1.0,
        listeners: bool = True,
    ) -> None:
        self._ctx = ctx
        self._clock = clock
        self._retry_delays = list(retry_delays)
        self._tick_seconds = tick_seconds
        self._listeners = listeners
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=10.0), transport=transport, headers={"User-Agent": "AI-Studio"}
        )
        self.deps = ChannelDeps(
            http=self._http,
            events=ctx.events,
            masker=ctx.masker,
            clock=clock,
            smtp_send=smtp_send or aiosmtplib.send,
            slack_socket_factory=slack_socket_factory or sdk_socket_factory,
            host=self,
            telegram_poll_timeout=telegram_poll_timeout,
            telegram_idle_pause=telegram_idle_pause,
        )
        self._channels: dict[str, ChannelRecord] = {}
        self._rules: list[AlertRule] = []
        self._instances: dict[str, Channel] = {}
        self._dedup = Deduper()
        self._grouper = Grouper()
        self._limiter = RateLimiter()
        self._interactor = ApprovalInteractor(ctx, clock=clock, confirm_ttl=self._confirm_ttl)
        self._link_codes: dict[str, tuple[str, datetime]] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        self._bg: list[asyncio.Task[Any]] = []
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ lifecycle
    async def load(self) -> None:
        async with self._ctx.db.connect() as conn:
            chans = (await conn.execute(sa.select(alerts_channels).order_by(alerts_channels.c.created_at))).mappings()
            self._channels = {r["id"]: ChannelRecord(**dict(r)) for r in chans.all()}
            rules = (await conn.execute(sa.select(alerts_rules).order_by(alerts_rules.c.created_at))).mappings().all()
        self._rules = [AlertRule(**dict(r)) for r in rules]

    async def start(self, *, pipeline: bool = True) -> None:
        await self.load()
        if not any(c.kind == "macos" for c in self._channels.values()):
            await self.create_channel(ChannelCreate(kind="macos", name=DEFAULT_NAMES["macos"]))
        for rec in list(self._channels.values()):
            await self._sync_listener(rec)
        if pipeline:
            cursor = await self._ctx.events.last_id()  # events after start() are never missed
            self._bg.append(asyncio.create_task(self._run_pipeline(cursor), name="alerts.pipeline"))
            self._bg.append(asyncio.create_task(self._tick_loop(), name="alerts.tick"))

    async def stop(self) -> None:
        for t in self._bg:
            t.cancel()
        for t in self._bg:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        self._bg.clear()
        for inst in list(self._instances.values()):
            with contextlib.suppress(Exception):
                await inst.stop()
        for t in list(self._tasks):
            t.cancel()
        for t in list(self._tasks):
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        await self._http.aclose()

    def _spawn[T](self, coro: Coroutine[Any, Any, T]) -> asyncio.Task[T]:
        task = asyncio.create_task(coro)
        self._tasks.add(task)

        def _done(t: asyncio.Task[Any]) -> None:
            self._tasks.discard(t)
            if not t.cancelled() and t.exception() is not None:
                log.error("alert task failed", exc_info=t.exception())

        task.add_done_callback(_done)
        return task

    async def drain(self) -> None:
        """Wait for every in-flight delivery / refresh (tests, shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    async def _run_pipeline(self, last_id: int) -> None:
        flt = EventFilter(include_ephemeral=False)
        while True:
            try:
                async with self._ctx.events.subscribe(flt) as stream:
                    while True:  # catch up after a lag (subscribe first, then read the backlog)
                        backlog = await self._ctx.events.query(flt, after_id=last_id, limit=500)
                        for ev in backlog:
                            await self._ingest_safe(ev)
                            last_id = ev.id
                        if len(backlog) < 500:
                            break
                    async for ev in stream:
                        if ev.id <= last_id:
                            continue
                        await self._ingest_safe(ev)
                        last_id = ev.id
            except SubscriberLagged:
                log.warning("alert pipeline lagged; catching up from event %s", last_id)

    async def _tick_loop(self) -> None:
        while True:
            await asyncio.sleep(self._tick_seconds)
            try:
                await self.flush_groups()
                now = self._clock()
                self._interactor.prune()
                self._dedup.prune(now, float(await self._setting("alerts.dedup_seconds")))
                for code in [c for c, (_, exp) in self._link_codes.items() if exp <= now]:
                    del self._link_codes[code]
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("alert tick failed")

    async def _setting(self, key: str) -> Any:
        value = await self._ctx.store.get(key)
        return SETTINGS_DEFAULTS.get(key) if value is None else value

    async def _confirm_ttl(self) -> float:
        return float(await self._setting("alerts.confirm_timeout_seconds"))

    # ------------------------------------------------------------------ pipeline
    async def _ingest_safe(self, ev: Event) -> None:
        try:
            await self.ingest(ev)
        except Exception:
            log.exception("alert pipeline failed on event %s (%s)", ev.id, ev.type)

    async def ingest(self, ev: Event) -> list[asyncio.Task[DeliveryOutcome]]:
        if ev.type.startswith("alert."):
            return []
        if ev.type == ET.APPROVAL_DECIDED:
            approval_id = ev.payload.get("approval_id")
            if isinstance(approval_id, str):
                self._spawn(self.refresh_approval(approval_id))
            return []
        alert = build_alert(ev)
        if alert is None:
            if not any(r.names_type(ev.type) for r in self._rules):
                return []
            alert = generic_alert(ev)
        if not await self._setting("alerts.enabled"):
            return []
        return await self.submit(alert)

    async def handle_event(self, ev: Event) -> list[DeliveryOutcome]:
        tasks = await self.ingest(ev)
        return list(await asyncio.gather(*tasks)) if tasks else []

    def _mask(self, alert: Alert) -> Alert:
        m = self._ctx.masker.mask
        return alert.model_copy(
            update={
                "title": m(alert.title),
                "body": m(alert.body),
                "web_url": m(alert.web_url) if alert.web_url else None,
                "items": [i.model_copy(update={"title": m(i.title), "body": m(i.body)}) for i in alert.items],
            }
        )

    async def submit(self, alert: Alert) -> list[asyncio.Task[DeliveryOutcome]]:
        alert = self._mask(alert)
        now = self._clock()
        if self._dedup.seen(alert.dedup_key, now, float(await self._setting("alerts.dedup_seconds"))):
            await self._log(alert, None, "deduplicated")
            return []
        window = float(await self._setting("alerts.group_window_seconds"))
        if alert.severity != Severity.critical and not self._grouper.offer(alert, now, window):
            await self._log(alert, None, "grouped")
            return []
        return await self._dispatch(alert, now)

    async def flush_groups(self, *, force: bool = False) -> list[asyncio.Task[DeliveryOutcome]]:
        now = self._clock()
        window = float(await self._setting("alerts.group_window_seconds"))
        tasks: list[asyncio.Task[DeliveryOutcome]] = []
        for batch in self._grouper.due(now, window, force=force):
            batch = await self._still_relevant(batch)
            if batch:
                tasks += await self._dispatch(make_group_alert(batch, now), now)
        return tasks

    async def _still_relevant(self, batch: list[Alert]) -> list[Alert]:
        """Drop buffered approval alerts that were decided meanwhile."""
        svc = self._ctx.services.maybe(ApprovalService)  # type: ignore[type-abstract]
        if svc is None:
            return batch
        keep: list[Alert] = []
        for alert in batch:
            if alert.approval_id:
                try:
                    if (await svc.get(alert.approval_id)).status != ApprovalStatus.pending:
                        continue
                except NotFound:
                    continue
            keep.append(alert)
        return keep

    async def _dispatch(self, alert: Alert, now: datetime) -> list[asyncio.Task[DeliveryOutcome]]:
        channels = list(self._channels.values())
        decision = route(alert, channels, self._rules, await self._setting("alerts.primary_channel_id"))
        if not decision.channel_ids:
            return []
        qh = QuietHours.model_validate(await self._setting("alerts.quiet_hours") or {})
        quiet = not decision.bypass_quiet and alert.severity != Severity.critical and quiet_active(qh, now)
        tasks: list[asyncio.Task[DeliveryOutcome]] = []
        for cid in decision.channel_ids:
            rec = self._channels[cid]
            out = alert.model_copy(update={"sound": decision.sound})
            if quiet:
                if rec.kind != "macos":
                    await self._log(alert, rec, "suppressed", error="Sessiz saatler")
                    continue
                out = out.model_copy(update={"sound": False, "silent": True})
            tasks.append(self._spawn(self._deliver(rec, out)))
        return tasks

    async def _deliver(self, rec: ChannelRecord, alert: Alert) -> DeliveryOutcome:
        per_minute = int(await self._setting("alerts.rate_limit_per_minute"))
        if alert.severity != Severity.critical and not self._limiter.allow(rec.id, self._clock(), per_minute):
            await self._log(alert, rec, "rate_limited", error="Kanal hız sınırı")
            return DeliveryOutcome(alert_id=alert.id, channel_id=rec.id, channel_kind=rec.kind, status="rate_limited")
        return await self._send_with_retry(rec, alert, self._retry_delays)

    async def _send_with_retry(self, rec: ChannelRecord, alert: Alert, delays: list[float]) -> DeliveryOutcome:
        attempts = 0
        error: ChannelError | None = None
        try:
            inst = await self._instance(rec)
        except ChannelError as e:
            error = e
        else:
            for i in range(len(delays) + 1):
                if i:
                    wait = delays[i - 1]
                    if error is not None and error.retry_after:
                        wait = max(wait, error.retry_after)
                    await asyncio.sleep(min(wait, _MAX_RETRY_WAIT))
                attempts += 1
                try:
                    ref = await asyncio.wait_for(inst.send(alert), timeout=_SEND_TIMEOUT)
                except ChannelError as e:
                    error = e
                    if not e.transient:
                        break
                    continue
                except TimeoutError:
                    error = ChannelError("Kanal zaman aşımına uğradı.", transient=True)
                    continue
                except Exception as e:
                    log.exception("channel %s send failed", rec.id)
                    error = ChannelError(f"Beklenmeyen hata: {type(e).__name__}")
                    break
                await self._record_sent(rec, inst, alert, attempts, ref)
                return DeliveryOutcome(
                    alert_id=alert.id, channel_id=rec.id, channel_kind=rec.kind, status="sent", attempts=attempts
                )
        message = self._ctx.masker.mask(error.message if error else "Bilinmeyen hata")
        await self._log(alert, rec, "failed", attempts=attempts, error=message)
        await self._ctx.events.append(
            "alert.failed",
            {
                "alert_id": alert.id,
                "channel_id": rec.id,
                "channel_kind": rec.kind,
                "channel_name": rec.name,
                "event_type": alert.event_type,
                "title": alert.title,
                "attempts": attempts,
                "error": message,
                "test": alert.test,
            },
            severity=Severity.normal,
            workspace_id=alert.workspace_id,
        )
        await self._set_last_error(rec.id, message)
        return DeliveryOutcome(
            alert_id=alert.id,
            channel_id=rec.id,
            channel_kind=rec.kind,
            status="failed",
            attempts=attempts,
            error=message,
        )

    async def _record_sent(
        self, rec: ChannelRecord, inst: Channel, alert: Alert, attempts: int, ref: dict[str, Any] | None
    ) -> None:
        await self._log(alert, rec, "sent", attempts=attempts)
        await self._ctx.events.append(
            "alert.sent",
            {
                "alert_id": alert.id,
                "channel_id": rec.id,
                "channel_kind": rec.kind,
                "event_type": alert.event_type,
                "severity": alert.severity.value,
                "title": alert.title,
                "attempts": attempts,
                "test": alert.test,
            },
            workspace_id=alert.workspace_id,
        )
        targets = alert.approval_targets()
        if ref and inst.updatable and targets:
            now = self._clock()
            snapshot = alert.model_dump(mode="json")
            async with self._ctx.db.begin() as conn:
                for item in targets:
                    await conn.execute(
                        alerts_messages.insert().values(
                            id=new_id("amsg"),
                            channel_id=rec.id,
                            approval_id=item.approval_id,
                            external_ref=ref,
                            alert=snapshot,
                            created_at=now,
                            updated_at=now,
                        )
                    )
        if rec.last_error:
            await self._set_last_error(rec.id, None)

    async def _log(
        self,
        alert: Alert,
        rec: ChannelRecord | None,
        status: DeliveryStatus,
        *,
        attempts: int = 0,
        error: str | None = None,
    ) -> None:
        targets = alert.approval_targets()
        async with self._ctx.db.begin() as conn:
            await conn.execute(
                alerts_log.insert().values(
                    alert_id=alert.id,
                    channel_id=rec.id if rec else None,
                    channel_kind=rec.kind if rec else None,
                    event_id=alert.event_id,
                    event_type=alert.event_type,
                    severity=alert.severity.value,
                    title=alert.title,
                    status=status,
                    attempts=attempts,
                    error=error,
                    approval_id=targets[0].approval_id if len(targets) == 1 else None,
                    test=alert.test,
                    created_at=self._clock(),
                )
            )

    # ------------------------------------------------------------------ approval messages
    async def refresh_approval(self, approval_id: str) -> None:
        """Edit every channel message carrying this approval to show its outcome."""
        svc = self._ctx.services.maybe(ApprovalService)  # type: ignore[type-abstract]
        if svc is None:
            return
        async with self._ctx.db.connect() as conn:
            rows = (
                (await conn.execute(sa.select(alerts_messages).where(alerts_messages.c.approval_id == approval_id)))
                .mappings()
                .all()
            )
        for row in rows:
            rec = self._channels.get(row["channel_id"])
            if rec is None:
                continue
            alert = Alert.model_validate(row["alert"])
            approvals: dict[str, Approval] = {}
            for item in alert.approval_targets():
                assert item.approval_id is not None
                with contextlib.suppress(NotFound):
                    approvals[item.approval_id] = await svc.get(item.approval_id)
            try:
                inst = await self._instance(rec)
                await inst.update(dict(row["external_ref"] or {}), alert, approvals)
            except ChannelError as e:
                log.warning("could not update alert message on %s: %s", rec.id, self._ctx.masker.mask(e.message))
                continue
            async with self._ctx.db.begin() as conn:
                await conn.execute(
                    alerts_messages.update().where(alerts_messages.c.id == row["id"]).values(updated_at=self._clock())
                )

    # ------------------------------------------------------------------ InteractionHost
    async def approval_action(
        self, *, channel_id: str, channel_kind: str, user_id: str, user_label: str, approval_id: str, action: Action
    ) -> InteractionResult:
        return await self._interactor.handle(
            channel_id=channel_id, channel_kind=channel_kind, user_id=user_id, approval_id=approval_id, action=action
        )

    async def link_identity(self, channel_id: str, code: str, identity: dict[str, str]) -> bool:
        entry = self._link_codes.get(code)
        if entry is None or entry[0] != channel_id or entry[1] <= self._clock():
            return False
        del self._link_codes[code]
        rec = self._channels.get(channel_id)
        if rec is None:
            return False
        config = dict(rec.config)
        if rec.kind == "telegram":
            config.update(
                chat_id=identity.get("chat_id"),
                linked_user_id=identity.get("user_id"),
                linked_username=identity.get("username") or None,
            )
        elif rec.kind == "slack":
            users = [str(u) for u in config.get("allowed_user_ids") or []]
            if identity.get("user_id") and identity["user_id"] not in users:
                users.append(identity["user_id"])
            config["allowed_user_ids"] = users
            if not config.get("channel") and identity.get("channel_id"):
                config["channel"] = identity["channel_id"]
        else:
            return False
        await self._write_channel(channel_id, config=config)
        inst = self._instances.get(channel_id)
        if inst is not None:
            inst.apply_config(config)
        await self._ctx.events.append(
            "alert.channel_linked", {"channel_id": channel_id, "channel_kind": rec.kind}, actor=f"channel:{rec.kind}"
        )
        return True

    async def channel_problem(self, channel_id: str, message: str | None) -> None:
        rec = self._channels.get(channel_id)
        if rec is None or rec.last_error == message:
            return
        await self._set_last_error(channel_id, message)
        if message:
            await self._ctx.events.append(
                "alert.channel_error",
                {"channel_id": channel_id, "channel_kind": rec.kind, "error": self._ctx.masker.mask(message)},
                severity=Severity.normal,
            )

    async def _set_last_error(self, channel_id: str, message: str | None) -> None:
        rec = self._channels.get(channel_id)
        if rec is None:
            return
        rec.last_error = message
        async with self._ctx.db.begin() as conn:
            await conn.execute(
                alerts_channels.update().where(alerts_channels.c.id == channel_id).values(last_error=message)
            )

    # ------------------------------------------------------------------ channel instances
    async def _secrets_of(self, rec: ChannelRecord) -> dict[str, str]:
        values: dict[str, str] = {}
        for field, ref in rec.secret_refs.items():
            value = await asyncio.to_thread(self._ctx.secrets.get, ref)
            if value:
                values[field] = value
        return values

    async def _instance(self, rec: ChannelRecord) -> Channel:
        inst = self._instances.get(rec.id)
        if inst is None:
            inst = build_channel(
                rec.kind,
                channel_id=rec.id,
                name=rec.name,
                config=rec.config,
                secrets=await self._secrets_of(rec),
                deps=self.deps,
            )
            self._instances[rec.id] = inst
        return inst

    async def _sync_listener(self, rec: ChannelRecord) -> None:
        inst = await self._instance(rec)
        if self._listeners and rec.enabled and inst.two_way:
            await inst.start()
        else:
            await inst.stop()

    async def _drop_instance(self, channel_id: str) -> None:
        inst = self._instances.pop(channel_id, None)
        if inst is not None:
            await inst.stop()

    # ------------------------------------------------------------------ channels CRUD
    def _out(self, rec: ChannelRecord) -> ChannelOut:
        inst = self._instances.get(rec.id)
        return ChannelOut(
            id=rec.id,
            kind=rec.kind,
            name=rec.name,
            enabled=rec.enabled,
            config=rec.config,
            secrets_set=sorted(rec.secret_refs),
            two_way=bool(inst and inst.two_way),
            listening=bool(inst and inst.listening),
            last_error=rec.last_error,
            created_at=rec.created_at,
            updated_at=rec.updated_at,
        )

    def kinds(self) -> list[ChannelKindSpec]:
        return list(KIND_SPECS.values())

    async def list_channels(self) -> list[ChannelOut]:
        return [self._out(r) for r in self._channels.values()]

    def _record(self, channel_id: str) -> ChannelRecord:
        rec = self._channels.get(channel_id)
        if rec is None:
            raise NotFound("Uyarı kanalı bulunamadı.")
        return rec

    async def get_channel(self, channel_id: str) -> ChannelOut:
        return self._out(self._record(channel_id))

    async def create_channel(self, req: ChannelCreate) -> ChannelOut:
        if req.kind == "macos" and any(c.kind == "macos" for c in self._channels.values()):
            raise Conflict("macOS bildirim kanalı zaten var.")
        secrets = {k: v.strip() for k, v in req.secrets.items() if v and v.strip()}
        for value in secrets.values():
            self._ctx.masker.add_secret(value)
        config = validate_channel(req.kind, req.config, secrets)
        now = self._clock()
        channel_id = new_id("chan")
        refs: dict[str, str] = {}
        for field, value in secrets.items():
            ref = secret_ref("alerts", channel_id, field)
            await asyncio.to_thread(self._ctx.secrets.set, ref, value)
            refs[field] = ref
        rec = ChannelRecord(
            id=channel_id,
            kind=req.kind,
            name=(req.name or "").strip() or DEFAULT_NAMES[req.kind],
            enabled=req.enabled,
            config=config,
            secret_refs=refs,
            last_error=None,
            created_at=now,
            updated_at=now,
        )
        async with self._ctx.db.begin() as conn:
            await conn.execute(
                alerts_channels.insert().values(
                    id=rec.id,
                    kind=rec.kind,
                    name=rec.name,
                    enabled=rec.enabled,
                    config=rec.config,
                    secret_refs=rec.secret_refs,
                    created_at=now,
                    updated_at=now,
                )
            )
        self._channels[rec.id] = rec
        await self._sync_listener(rec)
        await self._ctx.events.append("alert.channel_created", {"channel_id": rec.id, "kind": rec.kind}, actor="user")
        return self._out(rec)

    async def _write_channel(self, channel_id: str, **values: Any) -> ChannelRecord:
        rec = self._record(channel_id)
        values["updated_at"] = self._clock()
        async with self._ctx.db.begin() as conn:
            await conn.execute(alerts_channels.update().where(alerts_channels.c.id == channel_id).values(**values))
        for k, v in values.items():
            setattr(rec, k, v)
        return rec

    async def update_channel(self, channel_id: str, req: ChannelUpdate) -> ChannelOut:
        async with self._lock:
            rec = self._record(channel_id)
            current = await self._secrets_of(rec)
            effective = dict(current)
            changes: dict[str, str | None] = {}
            for field, value in (req.secrets or {}).items():
                value = (value or "").strip() or None
                changes[field] = value
                if value is None:
                    effective.pop(field, None)
                else:
                    effective[field] = value
                    self._ctx.masker.add_secret(value)
            config = validate_channel(rec.kind, req.config if req.config is not None else rec.config, effective)
            refs = dict(rec.secret_refs)
            for field, value in changes.items():
                ref = secret_ref("alerts", channel_id, field)
                if value is None:
                    await asyncio.to_thread(self._ctx.secrets.delete, ref)
                    refs.pop(field, None)
                else:
                    await asyncio.to_thread(self._ctx.secrets.set, ref, value)
                    refs[field] = ref
            values: dict[str, Any] = {"config": config, "secret_refs": refs}
            if req.name is not None and req.name.strip():
                values["name"] = req.name.strip()
            if req.enabled is not None:
                values["enabled"] = req.enabled
            if changes or req.config is not None:
                values["last_error"] = None
            rec = await self._write_channel(channel_id, **values)
            await self._drop_instance(channel_id)
            await self._sync_listener(rec)
        return self._out(rec)

    async def delete_channel(self, channel_id: str) -> None:
        rec = self._record(channel_id)
        if rec.kind == "macos":
            raise Conflict("macOS bildirim kanalı silinemez; istersen kapatabilirsin.")
        await self._drop_instance(channel_id)
        async with self._ctx.db.begin() as conn:
            await conn.execute(alerts_messages.delete().where(alerts_messages.c.channel_id == channel_id))
            await conn.execute(alerts_channels.delete().where(alerts_channels.c.id == channel_id))
        for ref in rec.secret_refs.values():
            await asyncio.to_thread(self._ctx.secrets.delete, ref)
        del self._channels[channel_id]
        for rule in self._rules:
            if channel_id in rule.channel_ids:
                rule.channel_ids = [c for c in rule.channel_ids if c != channel_id]
                async with self._ctx.db.begin() as conn:
                    await conn.execute(
                        alerts_rules.update().where(alerts_rules.c.id == rule.id).values(channel_ids=rule.channel_ids)
                    )
        if await self._setting("alerts.primary_channel_id") == channel_id:
            await self._ctx.store.set("alerts.primary_channel_id", None)
        await self._ctx.events.append(
            "alert.channel_deleted", {"channel_id": channel_id, "kind": rec.kind}, actor="user"
        )

    async def test_channel(self, channel_id: str) -> DeliveryOutcome:
        rec = self._record(channel_id)
        now = self._clock()
        alert = Alert(
            id=new_id("alert"),
            event_type="alert.test",
            severity=Severity.normal,
            title="AI Studio test bildirimi",
            body=f"“{rec.name}” kanalı çalışıyor. Uyarılar buraya gelecek.",
            dedup_key=f"test:{channel_id}:{now.isoformat()}",
            test=True,
            created_at=now,
        )
        return await self._send_with_retry(rec, alert, [])

    async def create_link_code(self, channel_id: str) -> LinkCode:
        rec = self._record(channel_id)
        inst = await self._instance(rec)
        if rec.kind not in ("telegram", "slack") or not inst.two_way:
            raise ValidationFailed(
                "Bağlantı kodu yalnız çift yönlü Telegram ve Slack (Socket Mode) kanallarında kullanılır."
            )
        if not rec.enabled:
            raise ValidationFailed("Önce kanalı etkinleştir.")
        code = f"{pysecrets.randbelow(1_000_000):06d}"
        expires = self._clock() + _LINK_CODE_TTL
        self._link_codes[code] = (channel_id, expires)
        instructions = (
            f"Telegram'da botuna şu mesajı gönder: /baglan {code}"
            if rec.kind == "telegram"
            else f"Slack'te bota doğrudan mesaj olarak şunu yaz: baglan {code}"
        )
        return LinkCode(code=code, expires_at=expires, instructions=f"{instructions} (10 dakika geçerli)")

    # ------------------------------------------------------------------ rules CRUD
    def _check_channels(self, ids: list[str]) -> list[str]:
        missing = [c for c in ids if c not in self._channels]
        if missing:
            raise ValidationFailed("Kuralda bilinmeyen kanal var.", details={"channel_ids": missing})
        return list(dict.fromkeys(ids))

    @staticmethod
    def _check_types(types: list[str]) -> list[str]:
        cleaned = [t.strip() for t in types if t.strip()]
        if any(" " in t or (t.endswith("*") and not t.endswith(".*")) for t in cleaned):
            raise ValidationFailed("Olay türleri 'pr.review' ya da 'pr.*' biçiminde olmalı.")
        return cleaned

    async def list_rules(self) -> list[AlertRule]:
        return list(self._rules)

    def _rule(self, rule_id: str) -> AlertRule:
        rule = next((r for r in self._rules if r.id == rule_id), None)
        if rule is None:
            raise NotFound("Uyarı kuralı bulunamadı.")
        return rule

    async def create_rule(self, req: AlertRuleCreate) -> AlertRule:
        if not req.name.strip():
            raise ValidationFailed("Kural adı boş olamaz.")
        now = self._clock()
        rule = AlertRule(
            id=new_id("arule"),
            name=req.name.strip(),
            enabled=req.enabled,
            event_types=self._check_types(req.event_types),
            min_severity=req.min_severity,
            workspace_id=req.workspace_id,
            channel_ids=self._check_channels(req.channel_ids),
            sound=req.sound,
            bypass_quiet_hours=req.bypass_quiet_hours,
            created_at=now,
            updated_at=now,
        )
        async with self._ctx.db.begin() as conn:
            await conn.execute(
                alerts_rules.insert().values(
                    **rule.model_dump(exclude={"min_severity"}), min_severity=rule.min_severity.value
                )
            )
        self._rules.append(rule)
        return rule

    async def update_rule(self, rule_id: str, req: AlertRuleUpdate) -> AlertRule:
        rule = self._rule(rule_id)
        data = req.model_dump(exclude_unset=True)
        if "event_types" in data and data["event_types"] is not None:
            data["event_types"] = self._check_types(data["event_types"])
        if "channel_ids" in data and data["channel_ids"] is not None:
            data["channel_ids"] = self._check_channels(data["channel_ids"])
        if "name" in data and not (data["name"] or "").strip():
            raise ValidationFailed("Kural adı boş olamaz.")
        data = {k: v for k, v in data.items() if v is not None or k == "workspace_id"}
        updated = rule.model_copy(update={**data, "updated_at": self._clock()})
        values = updated.model_dump(exclude={"id", "created_at", "min_severity"})
        values["min_severity"] = updated.min_severity.value
        async with self._ctx.db.begin() as conn:
            await conn.execute(alerts_rules.update().where(alerts_rules.c.id == rule_id).values(**values))
        self._rules = [updated if r.id == rule_id else r for r in self._rules]
        return updated

    async def delete_rule(self, rule_id: str) -> None:
        self._rule(rule_id)
        async with self._ctx.db.begin() as conn:
            await conn.execute(alerts_rules.delete().where(alerts_rules.c.id == rule_id))
        self._rules = [r for r in self._rules if r.id != rule_id]

    # ------------------------------------------------------------------ settings
    async def get_settings(self) -> AlertSettings:
        return AlertSettings(
            enabled=bool(await self._setting("alerts.enabled")),
            dedup_seconds=int(await self._setting("alerts.dedup_seconds")),
            group_window_seconds=int(await self._setting("alerts.group_window_seconds")),
            rate_limit_per_minute=int(await self._setting("alerts.rate_limit_per_minute")),
            primary_channel_id=await self._setting("alerts.primary_channel_id"),
            confirm_timeout_seconds=int(await self._setting("alerts.confirm_timeout_seconds")),
        )

    async def get_defaults(self) -> AlertDefaults:
        primary = primary_mobile(list(self._channels.values()), await self._setting("alerts.primary_channel_id"))
        return AlertDefaults(
            routing=DEFAULT_ROUTING,
            settings=await self.get_settings(),
            quiet_hours=await self.get_quiet_hours(),
            primary_channel_id=primary.id if primary else None,
        )

    async def update_settings(self, req: AlertSettingsUpdate) -> AlertDefaults:
        if req.primary_channel_id is not None:
            rec = self._record(req.primary_channel_id)
            if rec.kind not in ("telegram", "slack", "ntfy"):
                raise ValidationFailed("Birincil mobil kanal Telegram, Slack ya da ntfy olmalı.")
            await self._ctx.store.set("alerts.primary_channel_id", rec.id)
        elif req.clear_primary_channel:
            await self._ctx.store.set("alerts.primary_channel_id", None)
        for field in (
            "enabled",
            "dedup_seconds",
            "group_window_seconds",
            "rate_limit_per_minute",
            "confirm_timeout_seconds",
        ):
            value = getattr(req, field)
            if value is not None:
                await self._ctx.store.set(f"alerts.{field}", value)
        return await self.get_defaults()

    async def get_quiet_hours(self) -> QuietHours:
        return QuietHours.model_validate(await self._setting("alerts.quiet_hours") or {})

    async def set_quiet_hours(self, qh: QuietHours) -> QuietHours:
        qh = qh.check()
        await self._ctx.store.set("alerts.quiet_hours", qh.model_dump())
        return qh

    # ------------------------------------------------------------------ delivery log
    async def delivery_log(
        self,
        *,
        limit: int = 100,
        channel_id: str | None = None,
        status: str | None = None,
        before_id: int | None = None,
    ) -> list[DeliveryLogEntry]:
        t = alerts_log
        stmt = sa.select(t).order_by(t.c.id.desc()).limit(max(1, min(limit, 1000)))
        if channel_id:
            stmt = stmt.where(t.c.channel_id == channel_id)
        if status:
            stmt = stmt.where(t.c.status == status)
        if before_id:
            stmt = stmt.where(t.c.id < before_id)
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [DeliveryLogEntry(**dict(r)) for r in rows]
