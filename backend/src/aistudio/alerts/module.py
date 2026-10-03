"""Multi-channel alerts module (spec §15).

API (mounted under ``/api/alerts``)::

    GET    /kinds                         channel kinds (fields, secret fields, two-way?)
    GET    /channels                      list          POST /channels      create
    GET    /channels/{id}                 get           PATCH /channels/{id} update
    DELETE /channels/{id}
    POST   /channels/{id}/test            send a test alert (bypasses routing / quiet hours)
    POST   /channels/{id}/link            one-time code to link a Telegram / Slack user
    GET    /rules                         list          POST /rules         create
    PATCH  /rules/{id}                    update        DELETE /rules/{id}
    GET    /defaults                      default routing table + settings + quiet hours
    PUT    /defaults                      update settings (dedup, grouping, rate limit, primary channel...)
    GET    /quiet-hours                   PUT /quiet-hours
    GET    /log                           delivery log (?limit=&channel_id=&status=&before_id=)

Events emitted: ``alert.notify`` (macOS channel; the desktop app shows the native notification),
``alert.resolved`` (an approval shown in a notification was decided), ``alert.sent``,
``alert.failed``, ``alert.channel_linked``, ``alert.channel_error``, ``alert.channel_created``,
``alert.channel_deleted``.
"""

from __future__ import annotations

from fastapi import APIRouter, Response

from aistudio.alerts import tables as _tables  # noqa: F401  (registers tables)
from aistudio.alerts.models import (
    AlertDefaults,
    AlertRule,
    AlertRuleCreate,
    AlertRuleUpdate,
    AlertSettingsUpdate,
    ChannelCreate,
    ChannelKindSpec,
    ChannelOut,
    ChannelUpdate,
    DeliveryLogEntry,
    DeliveryOutcome,
    LinkCode,
    QuietHours,
)
from aistudio.alerts.service import SETTINGS_DEFAULTS, AlertService
from aistudio.core.context import AppContext
from aistudio.core.module import Module


class AlertsModule(Module):
    name = "alerts"

    def __init__(self) -> None:
        self.svc: AlertService | None = None

    async def setup(self, ctx: AppContext) -> None:
        for key, value in SETTINGS_DEFAULTS.items():
            ctx.store.declare(key, value)
        self.svc = AlertService(ctx)
        ctx.services.register(AlertService, self.svc)

    async def start(self, ctx: AppContext) -> None:
        assert self.svc is not None
        await self.svc.start()

    async def stop(self) -> None:
        if self.svc is not None:
            await self.svc.stop()

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/alerts", tags=["alerts"])

        def svc() -> AlertService:
            assert self.svc is not None
            return self.svc

        @r.get("/kinds", response_model=list[ChannelKindSpec])
        async def kinds() -> list[ChannelKindSpec]:
            return svc().kinds()

        @r.get("/channels", response_model=list[ChannelOut])
        async def list_channels() -> list[ChannelOut]:
            return await svc().list_channels()

        @r.post("/channels", response_model=ChannelOut, status_code=201)
        async def create_channel(body: ChannelCreate) -> ChannelOut:
            return await svc().create_channel(body)

        @r.get("/channels/{channel_id}", response_model=ChannelOut)
        async def get_channel(channel_id: str) -> ChannelOut:
            return await svc().get_channel(channel_id)

        @r.patch("/channels/{channel_id}", response_model=ChannelOut)
        async def update_channel(channel_id: str, body: ChannelUpdate) -> ChannelOut:
            return await svc().update_channel(channel_id, body)

        @r.delete("/channels/{channel_id}", status_code=204)
        async def delete_channel(channel_id: str) -> Response:
            await svc().delete_channel(channel_id)
            return Response(status_code=204)

        @r.post("/channels/{channel_id}/test", response_model=DeliveryOutcome)
        async def test_channel(channel_id: str) -> DeliveryOutcome:
            return await svc().test_channel(channel_id)

        @r.post("/channels/{channel_id}/link", response_model=LinkCode)
        async def link_channel(channel_id: str) -> LinkCode:
            return await svc().create_link_code(channel_id)

        @r.get("/rules", response_model=list[AlertRule])
        async def list_rules() -> list[AlertRule]:
            return await svc().list_rules()

        @r.post("/rules", response_model=AlertRule, status_code=201)
        async def create_rule(body: AlertRuleCreate) -> AlertRule:
            return await svc().create_rule(body)

        @r.patch("/rules/{rule_id}", response_model=AlertRule)
        async def update_rule(rule_id: str, body: AlertRuleUpdate) -> AlertRule:
            return await svc().update_rule(rule_id, body)

        @r.delete("/rules/{rule_id}", status_code=204)
        async def delete_rule(rule_id: str) -> Response:
            await svc().delete_rule(rule_id)
            return Response(status_code=204)

        @r.get("/defaults", response_model=AlertDefaults)
        async def defaults() -> AlertDefaults:
            return await svc().get_defaults()

        @r.put("/defaults", response_model=AlertDefaults)
        async def update_defaults(body: AlertSettingsUpdate) -> AlertDefaults:
            return await svc().update_settings(body)

        @r.get("/quiet-hours", response_model=QuietHours)
        async def quiet_hours() -> QuietHours:
            return await svc().get_quiet_hours()

        @r.put("/quiet-hours", response_model=QuietHours)
        async def set_quiet_hours(body: QuietHours) -> QuietHours:
            return await svc().set_quiet_hours(body)

        @r.get("/log", response_model=list[DeliveryLogEntry])
        async def delivery_log(
            limit: int = 100, channel_id: str | None = None, status: str | None = None, before_id: int | None = None
        ) -> list[DeliveryLogEntry]:
            return await svc().delivery_log(limit=limit, channel_id=channel_id, status=status, before_id=before_id)

        return r


module = AlertsModule()
