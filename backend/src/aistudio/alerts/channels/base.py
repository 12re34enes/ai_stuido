"""Channel interface and shared HTTP helpers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from email.message import EmailMessage
from typing import Any, ClassVar, Literal, Protocol

import httpx
from pydantic import BaseModel

from aistudio.alerts.models import Alert, ChannelKind
from aistudio.contracts.approvals import Approval
from aistudio.core.eventlog import EventLog
from aistudio.security.masking import Masker

Action = Literal["approve", "reject", "confirm", "cancel"]


class ChannelError(Exception):
    """A delivery failure. ``transient`` failures are retried (network, 5xx, 429)."""

    def __init__(
        self, message: str, *, transient: bool = False, retry_after: float | None = None, fatal: bool = False
    ) -> None:
        super().__init__(message)
        self.message = message
        self.transient = transient
        self.retry_after = retry_after
        self.fatal = fatal  # credentials rejected: listeners stop until the channel is reconfigured


class InteractionResult(BaseModel):
    kind: Literal["decided", "confirm", "refused", "already", "cancelled", "expired", "not_found", "invalid"]
    message: str
    approval_id: str | None = None


class InteractionHost(Protocol):
    """Implemented by the alert service; two-way channels call back into it."""

    async def approval_action(
        self, *, channel_id: str, channel_kind: str, user_id: str, user_label: str, approval_id: str, action: Action
    ) -> InteractionResult: ...

    async def link_identity(self, channel_id: str, code: str, identity: dict[str, str]) -> bool: ...

    async def refresh_approval(self, approval_id: str) -> None: ...

    async def channel_problem(self, channel_id: str, message: str | None) -> None: ...


SmtpSend = Callable[..., Awaitable[Any]]


@dataclass
class SocketRequest:
    envelope_id: str
    type: str  # "interactive" | "events_api" | "slash_commands"
    payload: dict[str, Any]


class SlackSocket(Protocol):
    """Slack Socket Mode connection (abstracted so tests can drive it without a websocket)."""

    def set_handler(self, handler: Callable[[SocketRequest], Awaitable[None]]) -> None: ...
    async def connect(self) -> None: ...
    async def ack(self, envelope_id: str, payload: dict[str, Any] | None = None) -> None: ...
    async def close(self) -> None: ...


SlackSocketFactory = Callable[[str, str], SlackSocket]  # (app_token, bot_token)


@dataclass
class ChannelDeps:
    http: httpx.AsyncClient
    events: EventLog
    masker: Masker
    clock: Callable[[], datetime]
    smtp_send: SmtpSend
    slack_socket_factory: SlackSocketFactory
    host: InteractionHost
    telegram_poll_timeout: int = 50
    telegram_idle_pause: float = 1.0  # pause when getUpdates returned at once with nothing
    telegram_api_base: str = "https://api.telegram.org"
    slack_api_base: str = "https://slack.com/api"
    extra: dict[str, Any] = field(default_factory=dict)


class Channel(ABC):
    kind: ClassVar[ChannelKind]

    def __init__(
        self, *, channel_id: str, name: str, config: dict[str, Any], secrets: dict[str, str], deps: ChannelDeps
    ) -> None:
        self.id = channel_id
        self.name = name
        self.config = dict(config)
        self.secrets = dict(secrets)
        self.deps = deps

    @property
    def two_way(self) -> bool:
        return False

    @property
    def updatable(self) -> bool:
        """Can edit a sent message (used to show approval outcomes)."""
        return False

    @property
    def listening(self) -> bool:
        return False

    def apply_config(self, config: dict[str, Any]) -> None:
        self.config = dict(config)

    @abstractmethod
    async def send(self, alert: Alert) -> dict[str, Any] | None:
        """Deliver; returns a reference for later edits (or None)."""
        ...

    async def update(self, ref: dict[str, Any], alert: Alert, approvals: dict[str, Approval]) -> None:
        return None

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None


def _retry_after(resp: httpx.Response) -> float | None:
    value = resp.headers.get("retry-after")
    if value:
        try:
            return float(value)
        except ValueError:
            return None
    return None


def check_response(resp: httpx.Response, label: str) -> None:
    if resp.is_success:
        return
    code = resp.status_code
    if code == 429:
        raise ChannelError(f"{label} hız sınırına takıldı (HTTP 429).", transient=True, retry_after=_retry_after(resp))
    if code >= 500:
        raise ChannelError(f"{label} sunucusu hata verdi (HTTP {code}).", transient=True)
    snippet = resp.text.strip().replace("\n", " ")[:200]
    if code in (401, 403):
        raise ChannelError(f"{label} kimlik doğrulamayı reddetti (HTTP {code}). Belirteci ya da adresi kontrol et.")
    if code == 404:
        raise ChannelError(f"{label} adresi bulunamadı (HTTP 404). Webhook silinmiş olabilir.")
    raise ChannelError(f"{label} isteği reddetti (HTTP {code}): {snippet}")


async def post(
    http: httpx.AsyncClient,
    url: str,
    label: str,
    *,
    json: Any = None,
    content: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float | None = None,
) -> httpx.Response:
    try:
        kwargs: dict[str, Any] = {"headers": headers}
        if timeout is not None:
            kwargs["timeout"] = timeout
        if content is not None:
            resp = await http.post(url, content=content, **kwargs)
        else:
            resp = await http.post(url, json=json, **kwargs)
    except httpx.TimeoutException as e:
        raise ChannelError(f"{label} zaman aşımına uğradı.", transient=True) from e
    except httpx.TransportError as e:
        raise ChannelError(f"{label} sunucusuna ulaşılamadı.", transient=True) from e
    check_response(resp, label)
    return resp


def build_email(*, subject: str, sender: str, recipients: list[str], text: str, html: str) -> EmailMessage:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")
    return msg
