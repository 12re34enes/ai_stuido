"""Helpers for alert tests. Credentials and webhook URLs are assembled at runtime and use
example domains, so nothing credential-looking is committed."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from typing import Any

from aistudio.alerts.channels.base import SocketRequest
from aistudio.alerts.models import Alert, ChannelCreate, ChannelOut
from aistudio.alerts.service import AlertService
from aistudio.approvals.service import ApprovalServiceImpl
from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalRequest
from aistudio.core.context import AppContext
from aistudio.core.events import Event, EventFilter, Severity
from aistudio.core.ids import new_id

TG_TOKEN = "-".join(["tg", "test", "bot", "token", "01"])
TG_API = f"https://api.telegram.org/bot{TG_TOKEN}"
SLACK_BOT = "-".join(["slack", "test", "bot", "token"])
SLACK_APP = "-".join(["slack", "test", "app", "token"])
SLACK_HOOK = "https://hooks.example.test/slack/" + "a1b2" * 3
DISCORD_HOOK = "https://discord.example.test/api/webhooks/1/" + "c3d4" * 3
TEAMS_HOOK = "https://teams.example.test/workflows/" + "e5f6" * 3
NTFY_URL = "https://ntfy.example.test/aistudio-" + "g7h8" * 2
NTFY_TOKEN = "-".join(["ntfy", "test", "token"])
HOOK_URL = "https://hooks.example.test/aistudio"
HOOK_SECRET = "-".join(["hmac", "test", "secret"])
SMTP_PASSWORD = "-".join(["smtp", "test", "pass"])


class FakeClock:
    def __init__(self, start: datetime | None = None) -> None:
        self.now = start or datetime(2026, 10, 3, 9, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@dataclass
class FakeSmtp:
    sent: list[tuple[EmailMessage, dict[str, Any]]] = field(default_factory=list)

    async def __call__(self, message: EmailMessage, **kwargs: Any) -> None:
        self.sent.append((message, kwargs))


class FakeSocket:
    """Stands in for the Socket Mode websocket: tests push requests with ``emit``."""

    def __init__(self, app_token: str, bot_token: str) -> None:
        self.app_token = app_token
        self.bot_token = bot_token
        self.handler: Callable[[SocketRequest], Awaitable[None]] | None = None
        self.connected = False
        self.closed = False
        self.acks: list[str] = []

    def set_handler(self, handler: Callable[[SocketRequest], Awaitable[None]]) -> None:
        self.handler = handler

    async def connect(self) -> None:
        self.connected = True

    async def ack(self, envelope_id: str, payload: dict[str, Any] | None = None) -> None:
        self.acks.append(envelope_id)

    async def close(self) -> None:
        self.closed = True

    async def emit(self, type_: str, payload: dict[str, Any]) -> str:
        assert self.handler is not None
        envelope = new_id("env")
        await self.handler(SocketRequest(envelope_id=envelope, type=type_, payload=payload))
        return envelope


@dataclass
class SocketFactory:
    sockets: list[FakeSocket] = field(default_factory=list)

    def __call__(self, app_token: str, bot_token: str) -> FakeSocket:
        sock = FakeSocket(app_token, bot_token)
        self.sockets.append(sock)
        return sock


@dataclass
class AlertEnv:
    ctx: AppContext
    svc: AlertService
    approvals: ApprovalServiceImpl
    clock: FakeClock
    smtp: FakeSmtp
    sockets: SocketFactory

    async def event(
        self,
        type_: str,
        payload: dict[str, Any] | None = None,
        *,
        severity: Severity = Severity.info,
        **kw: Any,
    ) -> Event:
        return await self.ctx.events.append(type_, payload or {}, severity=severity, **kw)

    async def last(self, type_: str) -> Event:
        events = await self.ctx.events.query(EventFilter(types=[type_]), descending=True, limit=1)
        assert events, f"no {type_} event"
        return events[0]

    async def events(self, type_: str) -> list[Event]:
        return await self.ctx.events.query(EventFilter(types=[type_]))

    async def channel(self, kind: Any, *, config: dict[str, Any] | None = None, **secrets: str) -> ChannelOut:
        return await self.svc.create_channel(ChannelCreate(kind=kind, config=config or {}, secrets=secrets))

    async def macos_id(self) -> str:
        return next(c.id for c in await self.svc.list_channels() if c.kind == "macos")

    async def disable_macos(self) -> None:
        from aistudio.alerts.models import ChannelUpdate

        await self.svc.update_channel(await self.macos_id(), ChannelUpdate(enabled=False))

    async def approval(
        self, kind: ApprovalKind = ApprovalKind.plan, *, production: bool = False, title: str = "Planı onayla"
    ) -> tuple[Approval, Event]:
        a = await self.approvals.request(
            ApprovalRequest(kind=kind, title=title, summary="Özet satırı", production=production, workspace_id="ws_1")
        )
        return a, await self.last("approval.requested")

    def alert(self, **over: Any) -> Alert:
        fields: dict[str, Any] = {
            "id": new_id("alert"),
            "event_type": "task.completed",
            "severity": Severity.normal,
            "title": "Görev tamamlandı",
            "body": "Ödeme modülü",
            "link": "aistudio://task/task_1",
            "dedup_key": new_id("dk"),
            "created_at": self.clock.now,
        }
        fields.update(over)
        return Alert(**fields)
