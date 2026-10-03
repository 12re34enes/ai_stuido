"""Slack: incoming webhook (one-way) or bot token + app token with Socket Mode (two-way).

Socket Mode keeps an outbound websocket open, so Block Kit button clicks reach studiod without
exposing the Mac. The websocket itself is behind :class:`SlackSocket` (real implementation:
``slack_sdk``'s aiohttp client); Web API calls go through httpx.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

from aistudio.alerts.channels.base import (
    Action,
    Channel,
    ChannelError,
    SlackSocket,
    SocketRequest,
    post,
)
from aistudio.alerts.models import Alert, AlertItem
from aistudio.alerts.render import (
    SEVERITY_EMOJI,
    SEVERITY_LABELS,
    UNAUTHORIZED,
    clip,
    is_http,
    is_pending,
    outcome_line,
    plain_text,
)
from aistudio.contracts.approvals import Approval

log = logging.getLogger(__name__)

_ACTION_IDS: dict[str, Action] = {
    "aistudio_approve": "approve",
    "aistudio_reject": "reject",
    "aistudio_confirm": "confirm",
    "aistudio_cancel": "cancel",
}
_LINK_TEXT = re.compile(r"^/?ba[gğ]lan\s+(\S+)\s*$", re.IGNORECASE)
_MAX_GROUP_ITEMS = 10


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _section(text: str) -> dict[str, Any]:
    return {"type": "section", "text": {"type": "mrkdwn", "text": clip(text, 2900)}}


def _approval_buttons(approval_id: str) -> dict[str, Any]:
    return {
        "type": "actions",
        "block_id": f"aistudio:{approval_id}",
        "elements": [
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Onayla", "emoji": True},
                "style": "primary",
                "action_id": "aistudio_approve",
                "value": approval_id,
            },
            {
                "type": "button",
                "text": {"type": "plain_text", "text": "Reddet", "emoji": True},
                "style": "danger",
                "action_id": "aistudio_reject",
                "value": approval_id,
            },
        ],
    }


def confirm_blocks(approval_id: str, text: str) -> list[dict[str, Any]]:
    return [
        _section(f":warning: *{_esc(text)}*"),
        {
            "type": "actions",
            "block_id": f"aistudio-confirm:{approval_id}",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Evet, onayla"},
                    "style": "danger",
                    "action_id": "aistudio_confirm",
                    "value": approval_id,
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "Vazgeç"},
                    "action_id": "aistudio_cancel",
                    "value": approval_id,
                },
            ],
        },
    ]


def build_blocks(
    alert: Alert, approvals: dict[str, Approval] | None = None, *, interactive: bool = True
) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = [
        {
            "type": "header",
            "text": {"type": "plain_text", "text": clip(f"{SEVERITY_EMOJI[alert.severity]} {alert.title}", 150)},
        }
    ]

    def decided(item: AlertItem) -> Approval | None:
        if approvals and item.approval_id in approvals and not is_pending(item, approvals):
            return approvals[item.approval_id]
        return None

    if alert.items:
        for idx, item in enumerate(alert.items[:_MAX_GROUP_ITEMS], 1):
            text = f"*{idx}. {_esc(item.title)}*"
            if item.body:
                text += "\n" + _esc(clip(item.body, 500))
            outcome = decided(item)
            if outcome is not None:
                text += f"\n_{_esc(outcome_line(outcome))}_"
            blocks.append(_section(text))
            if interactive and item.actionable and item.approval_id and outcome is None:
                blocks.append(_approval_buttons(item.approval_id))
        if len(alert.items) > _MAX_GROUP_ITEMS:
            more = len(alert.items) - _MAX_GROUP_ITEMS
            blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": f"… ve {more} tane daha"}]})
    else:
        if alert.body:
            blocks.append(_section(_esc(alert.body)))
        target = alert.approval_targets()
        outcome = decided(target[0]) if target else None
        if outcome is not None:
            blocks.append(_section(f"*{_esc(outcome_line(outcome))}*"))
        elif interactive and target and target[0].actionable and alert.approval_id:
            blocks.append(_approval_buttons(alert.approval_id))
    context = f"{SEVERITY_LABELS[alert.severity]} · AI Studio"
    if alert.link:
        context += f" · `{alert.link}`"
    blocks.append({"type": "context", "elements": [{"type": "mrkdwn", "text": context}]})
    if is_http(alert.web_url):
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    {
                        "type": "button",
                        "text": {"type": "plain_text", "text": "Aç"},
                        "url": alert.web_url,
                        "action_id": "aistudio_link",
                    }
                ],
            }
        )
    return blocks


class SlackChannel(Channel):
    kind = "slack"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._socket: SlackSocket | None = None
        self._task: asyncio.Task[None] | None = None
        self._connected = False

    @property
    def mode(self) -> str:
        return str(self.config.get("mode") or ("bot" if self.secrets.get("bot_token") else "webhook"))

    @property
    def two_way(self) -> bool:
        return self.mode == "bot" and bool(self.secrets.get("bot_token")) and bool(self.secrets.get("app_token"))

    @property
    def updatable(self) -> bool:
        return self.mode == "bot"

    @property
    def listening(self) -> bool:
        return self._connected

    # ------------------------------------------------------------------ Web API
    async def api(self, method: str, payload: dict[str, Any]) -> dict[str, Any]:
        token = self.secrets.get("bot_token")
        if not token:
            raise ChannelError("Slack bot belirteci tanımlı değil.")
        try:
            resp = await self.deps.http.post(
                f"{self.deps.slack_api_base}/{method}",
                json=payload,
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
            )
        except httpx.TimeoutException as e:
            raise ChannelError("Slack zaman aşımına uğradı.", transient=True) from e
        except httpx.TransportError as e:
            raise ChannelError("Slack sunucusuna ulaşılamadı.", transient=True) from e
        if resp.status_code == 429:
            retry = resp.headers.get("retry-after")
            raise ChannelError(
                "Slack hız sınırına takıldı.", transient=True, retry_after=float(retry) if retry else 1.0
            )
        if resp.status_code >= 500:
            raise ChannelError(f"Slack sunucusu hata verdi (HTTP {resp.status_code}).", transient=True)
        try:
            body = resp.json()
        except ValueError as e:
            raise ChannelError("Slack geçersiz bir yanıt döndürdü.") from e
        if body.get("ok"):
            return body
        error = str(body.get("error") or "unknown_error")
        if error in ("invalid_auth", "not_authed", "token_revoked", "account_inactive"):
            raise ChannelError("Slack bot belirteci geçersiz.", fatal=True)
        if error == "channel_not_found":
            raise ChannelError("Slack kanalı bulunamadı. Kanal kimliğini kontrol et.")
        if error == "not_in_channel":
            raise ChannelError("Bot kanala eklenmemiş. Kanalda /invite @bot yaz.")
        if error == "ratelimited":
            raise ChannelError("Slack hız sınırına takıldı.", transient=True, retry_after=1.0)
        raise ChannelError(f"Slack isteği reddetti: {error}")

    # ------------------------------------------------------------------ send / update
    async def send(self, alert: Alert) -> dict[str, Any] | None:
        fallback = clip(f"{alert.title}\n{plain_text(alert)}", 3000)
        if self.mode == "webhook":
            url = self.secrets.get("webhook_url")
            if not url:
                raise ChannelError("Slack webhook adresi tanımlı değil.")
            payload = {"text": fallback, "blocks": build_blocks(alert, interactive=False)}
            await post(self.deps.http, url, "Slack", json=payload)
            return None
        channel = self.config.get("channel")
        if not channel:
            raise ChannelError("Slack kanalı tanımlı değil.")
        body = await self.api(
            "chat.postMessage",
            {
                "channel": channel,
                "text": fallback,
                "blocks": build_blocks(alert, interactive=self.two_way),
                "unfurl_links": False,
                "unfurl_media": False,
            },
        )
        return {"channel": body.get("channel", channel), "ts": body.get("ts")}

    async def update(self, ref: dict[str, Any], alert: Alert, approvals: dict[str, Approval]) -> None:
        if self.mode != "bot" or not ref.get("ts"):
            return
        await self.api(
            "chat.update",
            {
                "channel": ref.get("channel"),
                "ts": ref["ts"],
                "text": clip(f"{alert.title}\n{plain_text(alert, approvals)}", 3000),
                "blocks": build_blocks(alert, approvals, interactive=self.two_way),
            },
        )

    async def ephemeral(
        self, channel: str | None, user: str | None, text: str, blocks: list[Any] | None = None
    ) -> None:
        if not channel or not user:
            return
        payload: dict[str, Any] = {"channel": channel, "user": user, "text": text}
        if blocks:
            payload["blocks"] = blocks
        with contextlib.suppress(ChannelError):
            await self.api("chat.postEphemeral", payload)

    async def respond(self, response_url: str, text: str) -> None:
        """Replace an ephemeral message (our confirmation prompt) through its response_url."""
        with contextlib.suppress(ChannelError):
            await post(self.deps.http, response_url, "Slack", json={"replace_original": True, "text": text})

    # ------------------------------------------------------------------ Socket Mode
    async def start(self) -> None:
        if not self.two_way or self._task is not None:
            return
        socket = self.deps.slack_socket_factory(self.secrets["app_token"], self.secrets["bot_token"])
        socket.set_handler(self.handle_request)
        self._socket = socket
        self._task = asyncio.create_task(self._connect_loop(socket), name=f"alerts.slack.{self.id}")

    async def _connect_loop(self, socket: SlackSocket) -> None:
        backoff = 2.0
        while True:
            try:
                await socket.connect()  # the SDK reconnects by itself afterwards
                self._connected = True
                await self.deps.host.channel_problem(self.id, None)
                return
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("slack socket mode connect failed: %s", e)
                await self.deps.host.channel_problem(self.id, "Slack Socket Mode bağlantısı kurulamadı.")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 120.0)

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        socket, self._socket = self._socket, None
        self._connected = False
        if socket is not None:
            with contextlib.suppress(Exception):
                await socket.close()

    async def handle_request(self, req: SocketRequest) -> None:
        socket = self._socket
        if socket is not None:
            await socket.ack(req.envelope_id)  # within 3 s, before any slow work
        try:
            if req.type == "interactive":
                await self._on_interactive(req.payload)
            elif req.type == "events_api":
                await self._on_event(req.payload.get("event") or {})
        except Exception:
            log.exception("slack interaction handling failed")

    def _authorized(self, user_id: str | None) -> bool:
        allowed = [str(u) for u in self.config.get("allowed_user_ids") or []]
        return bool(user_id) and user_id in allowed

    async def _on_interactive(self, payload: dict[str, Any]) -> None:
        if payload.get("type") != "block_actions":
            return
        user = payload.get("user") or {}
        user_id = user.get("id")
        container = payload.get("container") or {}
        channel = (payload.get("channel") or {}).get("id") or container.get("channel_id")
        response_url = payload.get("response_url")
        for act in payload.get("actions") or []:
            action = _ACTION_IDS.get(str(act.get("action_id")))
            approval_id = str(act.get("value") or "")
            if action is None or not approval_id:
                continue
            if not self._authorized(user_id):
                await self.ephemeral(channel, user_id, UNAUTHORIZED)
                continue
            result = await self.deps.host.approval_action(
                channel_id=self.id,
                channel_kind="slack",
                user_id=str(user_id),
                user_label=str(user.get("username") or user.get("name") or user_id),
                approval_id=approval_id,
                action=action,
            )
            if result.kind == "confirm":
                await self.ephemeral(channel, user_id, result.message, confirm_blocks(approval_id, result.message))
            elif action in ("confirm", "cancel") and response_url:
                await self.respond(response_url, result.message)
            elif result.kind != "decided":
                await self.ephemeral(channel, user_id, result.message)
            if result.kind == "already":
                await self.deps.host.refresh_approval(approval_id)

    async def _on_event(self, event: dict[str, Any]) -> None:
        if event.get("type") != "message" or event.get("bot_id") or event.get("subtype"):
            return
        if event.get("channel_type") != "im":
            return
        m = _LINK_TEXT.match(str(event.get("text") or "").strip())
        if m is None:
            return
        ok = await self.deps.host.link_identity(
            self.id, m.group(1), {"user_id": str(event.get("user")), "channel_id": str(event.get("channel"))}
        )
        text = (
            "Bağlantı tamam ✅ Artık AI Studio onaylarını Slack'ten verebilirsin."
            if ok
            else "Kod geçersiz ya da süresi dolmuş. Uygulamadan yeni bir kod al."
        )
        with contextlib.suppress(ChannelError):
            await self.api("chat.postMessage", {"channel": event.get("channel"), "text": text})


class SdkSlackSocket:
    """Real Socket Mode connection backed by ``slack_sdk`` (aiohttp)."""

    def __init__(self, app_token: str, bot_token: str) -> None:
        from slack_sdk.socket_mode.aiohttp import SocketModeClient
        from slack_sdk.web.async_client import AsyncWebClient

        self._client = SocketModeClient(app_token=app_token, web_client=AsyncWebClient(token=bot_token))
        self._handler: Callable[[SocketRequest], Awaitable[None]] | None = None

    def set_handler(self, handler: Callable[[SocketRequest], Awaitable[None]]) -> None:
        self._handler = handler

        async def listener(_client: Any, req: Any) -> None:
            if self._handler is not None:
                await self._handler(
                    SocketRequest(envelope_id=str(req.envelope_id), type=str(req.type), payload=dict(req.payload or {}))
                )

        self._client.socket_mode_request_listeners.append(listener)

    async def connect(self) -> None:
        await self._client.connect()

    async def ack(self, envelope_id: str, payload: dict[str, Any] | None = None) -> None:
        from slack_sdk.socket_mode.response import SocketModeResponse

        await self._client.send_socket_mode_response(SocketModeResponse(envelope_id=envelope_id, payload=payload))

    async def close(self) -> None:
        await self._client.close()


def sdk_socket_factory(app_token: str, bot_token: str) -> SlackSocket:
    return SdkSlackSocket(app_token, bot_token)
