"""Telegram: bot token + chat id; two-way through long polling (``getUpdates``), no inbound port.

* Approval alerts carry inline buttons (``a:ok:<id>`` / ``a:no:<id>``); only the linked user may
  press them. Production approvals (when allowed remotely) ask for a second tap (``a:ok2:<id>``)
  on a separate confirmation message (``a:x:<id>`` = Vazgeç).
* Linking: the app shows a one-time code, the user sends ``/baglan <kod>`` (or opens the bot with
  ``/start <kod>``); the chat id and Telegram user id are then stored in the channel config.
"""

from __future__ import annotations

import asyncio
import contextlib
import html
import logging
import re
from typing import Any

import httpx

from aistudio.alerts.channels.base import Action, Channel, ChannelError, InteractionResult
from aistudio.alerts.models import Alert
from aistudio.alerts.render import (
    SEVERITY_EMOJI,
    SEVERITY_LABELS,
    UNAUTHORIZED,
    clip,
    is_http,
    is_pending,
    item_line,
    outcome_line,
)
from aistudio.contracts.approvals import Approval, ApprovalStatus

log = logging.getLogger(__name__)

_ACTIONS: dict[str, Action] = {"ok": "approve", "no": "reject", "ok2": "confirm", "x": "cancel"}
_LINK_CMD = re.compile(r"^/(?:start|baglan|bağlan)(?:@\w+)?(?:\s+(\S+))?\s*$", re.IGNORECASE)
_MAX_BUTTON_ROWS = 8


def _esc(text: str) -> str:
    return html.escape(text, quote=False)


class TelegramChannel(Channel):
    kind = "telegram"

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._task: asyncio.Task[None] | None = None
        self._offset: int | None = None
        self.poll_timeout = self.deps.telegram_poll_timeout

    @property
    def two_way(self) -> bool:
        return bool(self.secrets.get("bot_token"))

    @property
    def updatable(self) -> bool:
        return True

    @property
    def listening(self) -> bool:
        return self._task is not None and not self._task.done()

    # ------------------------------------------------------------------ API
    async def call(self, method: str, payload: dict[str, Any], *, timeout: float | None = None) -> Any:
        token = self.secrets.get("bot_token")
        if not token:
            raise ChannelError("Telegram bot belirteci tanımlı değil.")
        url = f"{self.deps.telegram_api_base}/bot{token}/{method}"
        try:
            kwargs: dict[str, Any] = {"json": payload}
            if timeout is not None:
                kwargs["timeout"] = timeout
            resp = await self.deps.http.post(url, **kwargs)
        except httpx.TimeoutException as e:
            raise ChannelError("Telegram zaman aşımına uğradı.", transient=True) from e
        except httpx.TransportError as e:
            raise ChannelError("Telegram sunucusuna ulaşılamadı.", transient=True) from e
        try:
            body = resp.json()
        except ValueError:
            body = {}
        if isinstance(body, dict) and body.get("ok"):
            return body.get("result")
        code = int(body.get("error_code") or resp.status_code) if isinstance(body, dict) else resp.status_code
        desc = str(body.get("description") or "") if isinstance(body, dict) else ""
        params = body.get("parameters") or {} if isinstance(body, dict) else {}
        if code == 429:
            raise ChannelError(
                "Telegram hız sınırına takıldı.", transient=True, retry_after=float(params.get("retry_after") or 1)
            )
        if code >= 500:
            raise ChannelError(f"Telegram sunucusu hata verdi (HTTP {code}).", transient=True)
        if code == 401:
            raise ChannelError("Telegram bot belirteci geçersiz.", fatal=True)
        if code == 403:
            raise ChannelError("Bot bu sohbete mesaj gönderemiyor (engellenmiş ya da sohbetten çıkarılmış olabilir).")
        if code == 409:
            raise ChannelError("Bu bot başka bir yerde de güncellemeleri okuyor (webhook ya da ikinci bir uygulama).")
        if "chat not found" in desc.lower():
            raise ChannelError("Telegram sohbeti bulunamadı. Kanal bağlantısını yenile.")
        raise ChannelError(f"Telegram isteği reddetti: {desc or code}")

    # ------------------------------------------------------------------ rendering
    def render(self, alert: Alert, approvals: dict[str, Approval] | None = None) -> str:
        lines = [f"{SEVERITY_EMOJI[alert.severity]} <b>{_esc(alert.title)}</b>"]
        if alert.items:
            for idx, item in enumerate(alert.items, 1):
                line = f"{idx}. {_esc(clip(item_line(item), 300))}"
                if approvals and item.approval_id in approvals and not is_pending(item, approvals):
                    line += f"\n    <i>{_esc(outcome_line(approvals[item.approval_id]))}</i>"
                lines.append(line)
        elif alert.body:
            lines.append(_esc(clip(alert.body, 3000)))
        if not alert.items and alert.approval_id and approvals and alert.approval_id in approvals:
            approval = approvals[alert.approval_id]
            if approval.status != ApprovalStatus.pending:
                lines.append(f"\n<b>{_esc(outcome_line(approval))}</b>")
        footer = f"<i>{SEVERITY_LABELS[alert.severity]} · AI Studio</i>"
        if alert.link:
            footer += f"\n<code>{_esc(alert.link)}</code>"
        lines.append("\n" + footer)
        return "\n".join(lines)[:4096]

    def keyboard(self, alert: Alert, approvals: dict[str, Approval] | None = None) -> list[list[dict[str, str]]]:
        rows: list[list[dict[str, str]]] = []
        targets = [t for t in alert.approval_targets() if t.actionable and is_pending(t, approvals)]
        if targets:
            if alert.items:
                for item in targets[:_MAX_BUTTON_ROWS]:
                    idx = alert.items.index(item) + 1
                    rows.append(
                        [
                            {"text": f"✅ {idx}. Onayla", "callback_data": f"a:ok:{item.approval_id}"},
                            {"text": f"❌ {idx}. Reddet", "callback_data": f"a:no:{item.approval_id}"},
                        ]
                    )
            else:
                aid = targets[0].approval_id
                rows.append(
                    [
                        {"text": "✅ Onayla", "callback_data": f"a:ok:{aid}"},
                        {"text": "❌ Reddet", "callback_data": f"a:no:{aid}"},
                    ]
                )
        if is_http(alert.web_url):
            rows.append([{"text": "🔗 Aç", "url": str(alert.web_url)}])
        return rows

    # ------------------------------------------------------------------ send / update
    async def send(self, alert: Alert) -> dict[str, Any] | None:
        chat_id = self.config.get("chat_id")
        if not chat_id:
            raise ChannelError("Telegram sohbeti henüz bağlanmadı. Kanal ayarlarından bağlantı kodunu kullan.")
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": self.render(alert),
            "parse_mode": "HTML",
            "link_preview_options": {"is_disabled": True},
            "disable_notification": alert.silent,
        }
        keyboard = self.keyboard(alert)
        if keyboard:
            payload["reply_markup"] = {"inline_keyboard": keyboard}
        result = await self.call("sendMessage", payload)
        return {"chat_id": chat_id, "message_id": (result or {}).get("message_id")}

    async def update(self, ref: dict[str, Any], alert: Alert, approvals: dict[str, Approval]) -> None:
        if not ref.get("message_id"):
            return
        try:
            await self.call(
                "editMessageText",
                {
                    "chat_id": ref.get("chat_id"),
                    "message_id": ref["message_id"],
                    "text": self.render(alert, approvals),
                    "parse_mode": "HTML",
                    "link_preview_options": {"is_disabled": True},
                    "reply_markup": {"inline_keyboard": self.keyboard(alert, approvals)},
                },
            )
        except ChannelError as e:
            if "not modified" not in e.message.lower():
                raise

    # ------------------------------------------------------------------ long polling
    async def start(self) -> None:
        if self.two_way and not self.listening:
            self._task = asyncio.create_task(self._loop(), name=f"alerts.telegram.{self.id}")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _loop(self) -> None:
        backoff = 1.0
        while True:
            try:
                started = asyncio.get_running_loop().time()
                count = await self.poll_once()
                backoff = 1.0
                await self.deps.host.channel_problem(self.id, None)
                if count == 0 and asyncio.get_running_loop().time() - started < 1.0:
                    await asyncio.sleep(self.deps.telegram_idle_pause)
            except asyncio.CancelledError:
                raise
            except ChannelError as e:
                if e.fatal:
                    await self.deps.host.channel_problem(self.id, e.message)
                    return  # invalid token: polling cannot recover
                if not e.transient:
                    await self.deps.host.channel_problem(self.id, e.message)
                await asyncio.sleep(e.retry_after or backoff)
                backoff = min(backoff * 2, 60.0)
            except Exception:
                log.exception("telegram polling failed")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def poll_once(self) -> int:
        """One ``getUpdates`` round (blocks up to ``poll_timeout`` seconds). Returns the update count."""
        payload: dict[str, Any] = {"timeout": self.poll_timeout, "allowed_updates": ["message", "callback_query"]}
        if self._offset is not None:
            payload["offset"] = self._offset
        updates = await self.call("getUpdates", payload, timeout=self.poll_timeout + 15) or []
        for upd in updates:
            self._offset = int(upd.get("update_id", 0)) + 1
            try:
                if "callback_query" in upd:
                    await self._on_callback(upd["callback_query"])
                elif "message" in upd:
                    await self._on_message(upd["message"])
            except Exception:
                log.exception("telegram update handling failed")
        return len(updates)

    def _authorized(self, user: dict[str, Any], chat: dict[str, Any]) -> bool:
        uid = str(user.get("id", ""))
        linked = str(self.config.get("linked_user_id") or "")
        if linked:
            return uid == linked
        chat_id = str(self.config.get("chat_id") or "")
        return bool(chat_id) and chat.get("type") == "private" and str(chat.get("id")) == chat_id == uid

    async def _answer(self, callback_id: str, text: str, *, alert: bool = False) -> None:
        with contextlib.suppress(ChannelError):
            await self.call(
                "answerCallbackQuery", {"callback_query_id": callback_id, "text": clip(text, 190), "show_alert": alert}
            )

    async def _on_callback(self, cq: dict[str, Any]) -> None:
        cq_id = str(cq.get("id", ""))
        user = cq.get("from") or {}
        message = cq.get("message") or {}
        chat = message.get("chat") or {}
        parts = str(cq.get("data") or "").split(":", 2)
        action = _ACTIONS.get(parts[1]) if len(parts) == 3 and parts[0] == "a" else None
        if action is None:
            await self._answer(cq_id, "Bilinmeyen işlem.")
            return
        approval_id = parts[2]
        if not self._authorized(user, chat):
            await self._answer(cq_id, UNAUTHORIZED, alert=True)
            return
        label = str(user.get("username") or user.get("first_name") or user.get("id"))
        result = await self.deps.host.approval_action(
            channel_id=self.id,
            channel_kind="telegram",
            user_id=str(user.get("id")),
            user_label=label,
            approval_id=approval_id,
            action=action,
        )
        await self._show_result(cq_id, message, chat, approval_id, action, result)

    async def _show_result(
        self,
        cq_id: str,
        message: dict[str, Any],
        chat: dict[str, Any],
        approval_id: str,
        action: Action,
        result: InteractionResult,
    ) -> None:
        chat_id = chat.get("id")
        message_id = message.get("message_id")
        from_prompt = action in ("confirm", "cancel")  # pressed on our confirmation message
        if result.kind == "confirm":
            await self._answer(cq_id, result.message)
            await self.call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": f"⚠️ {_esc(result.message)}",
                    "parse_mode": "HTML",
                    "reply_parameters": {"message_id": message_id, "allow_sending_without_reply": True},
                    "reply_markup": {
                        "inline_keyboard": [
                            [{"text": "✅ Evet, onayla", "callback_data": f"a:ok2:{approval_id}"}],
                            [{"text": "↩️ Vazgeç", "callback_data": f"a:x:{approval_id}"}],
                        ]
                    },
                },
            )
            return
        if result.kind == "refused":
            await self._answer(cq_id, result.message, alert=True)
            await self.call(
                "sendMessage",
                {
                    "chat_id": chat_id,
                    "text": f"⛔ {_esc(result.message)}",
                    "parse_mode": "HTML",
                    "reply_parameters": {"message_id": message_id, "allow_sending_without_reply": True},
                },
            )
        else:
            await self._answer(cq_id, result.message, alert=result.kind in ("expired", "not_found", "invalid"))
        if from_prompt and message_id is not None:
            with contextlib.suppress(ChannelError):
                await self.call(
                    "editMessageText",
                    {
                        "chat_id": chat_id,
                        "message_id": message_id,
                        "text": _esc(result.message),
                        "reply_markup": {"inline_keyboard": []},
                    },
                )
        if result.kind == "already":
            await self.deps.host.refresh_approval(approval_id)

    async def _on_message(self, msg: dict[str, Any]) -> None:
        text = str(msg.get("text") or "").strip()
        m = _LINK_CMD.match(text)
        if m is None:
            return
        chat = msg.get("chat") or {}
        user = msg.get("from") or {}
        code = m.group(1)
        if not code:
            reply = (
                "Merhaba! Bu botu AI Studio'ya bağlamak için uygulamada Ayarlar → Uyarılar → Telegram "
                "kanalından bağlantı kodu al ve buraya /baglan &lt;kod&gt; yaz."
            )
        else:
            ok = await self.deps.host.link_identity(
                self.id,
                code,
                {
                    "chat_id": str(chat.get("id")),
                    "user_id": str(user.get("id")),
                    "username": str(user.get("username") or user.get("first_name") or ""),
                },
            )
            reply = (
                "Bağlantı tamam ✅ AI Studio bildirimleri artık bu sohbete gelecek."
                if ok
                else "Kod geçersiz ya da süresi dolmuş. Uygulamadan yeni bir kod al."
            )
        await self.call("sendMessage", {"chat_id": chat.get("id"), "text": reply, "parse_mode": "HTML"})
