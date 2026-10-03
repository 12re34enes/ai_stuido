"""One-way channels: macOS (via the app), Discord, Microsoft Teams, e-mail, ntfy, webhook."""

from __future__ import annotations

import hashlib
import hmac
import html
import json
import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit

import aiosmtplib

from aistudio.alerts.channels.base import Channel, ChannelError, build_email, post
from aistudio.alerts.models import Alert
from aistudio.alerts.render import (
    SEVERITY_EMOJI,
    SEVERITY_LABELS,
    clip,
    is_http,
    iso,
    outcome_line,
    plain_text,
)
from aistudio.contracts.approvals import Approval, ApprovalStatus
from aistudio.core.events import Severity

# --------------------------------------------------------------------------- macOS


class MacosChannel(Channel):
    """No network: emits ``alert.notify``; the desktop app shows a native notification.

    Payload (see module docs): alert_id, title, body, severity, sound, silent, link, web_url,
    approval_id, approval_kind, production, actions [{id, label, url?}], items, thread_id, expires_at.
    """

    kind = "macos"

    @property
    def updatable(self) -> bool:
        return True

    @staticmethod
    def actions(alert: Alert) -> list[dict[str, Any]]:
        actions: list[dict[str, Any]] = []
        if alert.approval_id and alert.actionable and not alert.items:
            if not alert.production:  # production: decide only after looking at it in the app
                actions.append({"id": "approve", "label": "Onayla"})
            actions.append({"id": "reject", "label": "Reddet"})
        if alert.link:
            actions.insert(0 if alert.production else len(actions), {"id": "open", "label": "Aç", "url": alert.link})
        return actions

    async def send(self, alert: Alert) -> dict[str, Any] | None:
        payload = {
            "alert_id": alert.id,
            "event_type": alert.event_type,
            "title": alert.title,
            "body": plain_text(alert, with_link=False),
            "severity": alert.severity.value,
            "sound": alert.sound and not alert.silent,
            "silent": alert.silent,
            "link": alert.link,
            "web_url": alert.web_url,
            "approval_id": alert.approval_id,
            "approval_kind": alert.approval_kind,
            "production": alert.production,
            "actions": self.actions(alert),
            "items": [i.model_dump(mode="json") for i in alert.items],
            "thread_id": "approvals" if alert.approval_targets() else (alert.group_key or alert.event_type),
            "expires_at": iso(alert.created_at + timedelta(minutes=10)),
            "test": alert.test,
        }
        ev = await self.deps.events.append(
            "alert.notify",
            payload,
            severity=alert.severity,
            workspace_id=alert.workspace_id,
            task_id=alert.task_id,
            run_id=alert.run_id,
        )
        return {"event_id": ev.id}

    async def update(self, ref: dict[str, Any], alert: Alert, approvals: dict[str, Approval]) -> None:
        decided = {aid: a for aid, a in approvals.items() if a.status != ApprovalStatus.pending}
        if not decided:
            return
        await self.deps.events.append(
            "alert.resolved",
            {
                "alert_id": alert.id,
                "approvals": {aid: a.status.value for aid, a in decided.items()},
                "all_decided": len(decided) == len(alert.approval_targets()),
                "outcome": outcome_line(next(iter(decided.values()))),
            },
            workspace_id=alert.workspace_id,
        )


# --------------------------------------------------------------------------- Discord

_DISCORD_COLORS = {
    Severity.critical: 0xE5484D,
    Severity.high: 0xF76B15,
    Severity.normal: 0x3E63DD,
    Severity.info: 0x8B8D98,
}


class DiscordChannel(Channel):
    kind = "discord"

    async def send(self, alert: Alert) -> dict[str, Any] | None:
        url = self.secrets.get("webhook_url")
        if not url:
            raise ChannelError("Discord webhook adresi tanımlı değil.")
        embed: dict[str, Any] = {
            "title": clip(f"{SEVERITY_EMOJI[alert.severity]} {alert.title}", 256),
            "description": clip(plain_text(alert, with_link=False), 4000),
            "color": _DISCORD_COLORS[alert.severity],
            "timestamp": iso(alert.created_at),
            "footer": {"text": f"AI Studio · {SEVERITY_LABELS[alert.severity]}"},
            "fields": [],
        }
        if is_http(alert.web_url):
            embed["url"] = alert.web_url
        if alert.link:
            embed["fields"].append({"name": "Uygulamada aç", "value": f"`{alert.link}`", "inline": False})
        payload = {
            "username": self.config.get("username") or "AI Studio",
            "embeds": [embed],
            "allowed_mentions": {"parse": []},
        }
        await post(self.deps.http, url, "Discord", json=payload)
        return None


# --------------------------------------------------------------------------- Microsoft Teams

_TEAMS_COLORS = {
    Severity.critical: "Attention",
    Severity.high: "Warning",
    Severity.normal: "Accent",
    Severity.info: "Default",
}


class TeamsChannel(Channel):
    """Teams Workflows ("When a Teams webhook request is received") or a legacy incoming webhook."""

    kind = "teams"

    @staticmethod
    def card(alert: Alert) -> dict[str, Any]:
        facts = [{"title": "Önem", "value": SEVERITY_LABELS[alert.severity]}]
        if alert.link:
            facts.append({"title": "Uygulamada aç", "value": alert.link})
        body: list[dict[str, Any]] = [
            {
                "type": "TextBlock",
                "text": f"{SEVERITY_EMOJI[alert.severity]} {alert.title}",
                "weight": "Bolder",
                "size": "Medium",
                "wrap": True,
                "color": _TEAMS_COLORS[alert.severity],
            }
        ]
        text = plain_text(alert, with_link=False)
        if text:
            body.append({"type": "TextBlock", "text": clip(text, 4000), "wrap": True})
        body.append({"type": "FactSet", "facts": facts})
        card: dict[str, Any] = {
            "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
            "type": "AdaptiveCard",
            "version": "1.4",
            "msteams": {"width": "Full"},
            "body": body,
        }
        if is_http(alert.web_url):
            card["actions"] = [{"type": "Action.OpenUrl", "title": "Aç", "url": alert.web_url}]
        return card

    async def send(self, alert: Alert) -> dict[str, Any] | None:
        url = self.secrets.get("webhook_url")
        if not url:
            raise ChannelError("Teams webhook adresi tanımlı değil.")
        payload = {
            "type": "message",
            "attachments": [
                {
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "contentUrl": None,
                    "content": self.card(alert),
                }
            ],
        }
        await post(self.deps.http, url, "Microsoft Teams", json=payload)
        return None


# --------------------------------------------------------------------------- e-mail


class EmailChannel(Channel):
    kind = "email"

    async def send(self, alert: Alert) -> dict[str, Any] | None:
        cfg = self.config
        host = str(cfg.get("host") or "")
        sender = str(cfg.get("from_addr") or "")
        recipients = [str(r) for r in cfg.get("to_addrs") or []]
        if not host or not sender or not recipients:
            raise ChannelError("E-posta kanalı eksik yapılandırılmış (sunucu, gönderen, alıcı).")
        security = str(cfg.get("security") or "starttls")
        port = int(cfg.get("port") or (465 if security == "tls" else 587 if security == "starttls" else 25))
        text = plain_text(alert)
        body_html = "<br>".join(html.escape(line) for line in plain_text(alert, with_link=False).splitlines())
        link_html = (
            f'<p style="color:#6b6b6b;font-size:12px">Uygulamada aç: <code>{html.escape(alert.link)}</code></p>'
            if alert.link
            else ""
        )
        web_html = f'<p><a href="{html.escape(alert.web_url or "")}">Aç</a></p>' if is_http(alert.web_url) else ""
        page = (
            '<div style="font-family:-apple-system,Helvetica,sans-serif;font-size:14px;line-height:1.5">'
            f'<h2 style="font-family:ui-serif,Georgia,serif;font-weight:600">{html.escape(alert.title)}</h2>'
            f"<p>{body_html}</p>{web_html}{link_html}"
            f'<p style="color:#6b6b6b;font-size:12px">AI Studio · {SEVERITY_LABELS[alert.severity]}</p></div>'
        )
        msg = build_email(
            subject=f"[AI Studio] {SEVERITY_LABELS[alert.severity]}: {alert.title}",
            sender=sender,
            recipients=recipients,
            text=text,
            html=page,
        )
        try:
            await self.deps.smtp_send(
                msg,
                hostname=host,
                port=port,
                username=cfg.get("username") or None,
                password=self.secrets.get("password") or None,
                use_tls=security == "tls",
                start_tls=security == "starttls",
                timeout=20,
            )
        except aiosmtplib.SMTPAuthenticationError as e:
            raise ChannelError("SMTP kimlik doğrulaması başarısız. Kullanıcı adı ve parolayı kontrol et.") from e
        except (aiosmtplib.SMTPConnectError, aiosmtplib.SMTPServerDisconnected, TimeoutError, OSError) as e:
            raise ChannelError("SMTP sunucusuna bağlanılamadı.", transient=True) from e
        except aiosmtplib.SMTPRecipientsRefused as e:
            raise ChannelError("SMTP sunucusu alıcıları reddetti.") from e
        except aiosmtplib.SMTPException as e:
            raise ChannelError(f"E-posta gönderilemedi: {e}") from e
        return None


# --------------------------------------------------------------------------- ntfy

_NTFY_PRIORITY = {Severity.critical: 5, Severity.high: 4, Severity.normal: 3, Severity.info: 2}
_NTFY_TAGS = {
    Severity.critical: "rotating_light",
    Severity.high: "warning",
    Severity.normal: "bell",
    Severity.info: "information_source",
}


def split_ntfy_url(topic_url: str) -> tuple[str, str]:
    parts = urlsplit(topic_url.strip())
    segments = [s for s in parts.path.split("/") if s]
    if parts.scheme not in ("http", "https") or not parts.netloc or not segments:
        raise ChannelError("ntfy konu adresi geçersiz (ör. https://ntfy.sh/konu-adi).")
    prefix = "/".join(segments[:-1])
    server = f"{parts.scheme}://{parts.netloc}" + (f"/{prefix}" if prefix else "")
    return server, segments[-1]


class NtfyChannel(Channel):
    """Publishes as JSON to the server root (UTF-8 safe titles), click opens ``aistudio://``."""

    kind = "ntfy"

    async def send(self, alert: Alert) -> dict[str, Any] | None:
        topic_url = self.secrets.get("topic_url")
        if not topic_url:
            raise ChannelError("ntfy konu adresi tanımlı değil.")
        server, topic = split_ntfy_url(topic_url)
        payload: dict[str, Any] = {
            "topic": topic,
            "title": clip(alert.title, 250),
            "message": clip(plain_text(alert, with_link=False) or alert.title, 3500),
            "priority": _NTFY_PRIORITY[alert.severity],
            "tags": [_NTFY_TAGS[alert.severity]],
        }
        actions: list[dict[str, Any]] = []
        if alert.link:
            payload["click"] = alert.link
            actions.append({"action": "view", "label": "Uygulamada aç", "url": alert.link})
        if is_http(alert.web_url):
            actions.append({"action": "view", "label": "Web'de aç", "url": alert.web_url})
        if actions:
            payload["actions"] = actions
        headers = {"Authorization": f"Bearer {self.secrets['token']}"} if self.secrets.get("token") else None
        await post(self.deps.http, server + "/", "ntfy", json=payload, headers=headers)
        return None


# --------------------------------------------------------------------------- webhook


def webhook_signature(secret: str, timestamp: str, body: bytes) -> str:
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    return f"sha256={digest}"


class WebhookChannel(Channel):
    """Generic JSON POST. With a signing secret: ``X-AIStudio-Signature: sha256=HMAC(secret,
    "<X-AIStudio-Timestamp>.<raw body>")``."""

    kind = "webhook"

    @staticmethod
    def payload(alert: Alert) -> dict[str, Any]:
        return {
            "type": "alert",
            "id": alert.id,
            "event_id": alert.event_id,
            "event_type": alert.event_type,
            "severity": alert.severity.value,
            "title": alert.title,
            "body": alert.body,
            "text": plain_text(alert),
            "link": alert.link,
            "web_url": alert.web_url,
            "workspace_id": alert.workspace_id,
            "task_id": alert.task_id,
            "run_id": alert.run_id,
            "approval_id": alert.approval_id,
            "production": alert.production,
            "items": [i.model_dump(mode="json") for i in alert.items],
            "test": alert.test,
            "created_at": iso(alert.created_at),
        }

    async def send(self, alert: Alert) -> dict[str, Any] | None:
        url = self.secrets.get("url")
        if not url:
            raise ChannelError("Webhook adresi tanımlı değil.")
        body = json.dumps(self.payload(alert), ensure_ascii=False, separators=(",", ":")).encode()
        ts = str(int(self.deps.clock().timestamp()))
        headers = {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "AI-Studio",
            "X-AIStudio-Event": "alert",
            "X-AIStudio-Delivery": str(uuid.uuid4()),
            "X-AIStudio-Timestamp": ts,
        }
        secret = self.secrets.get("signing_secret")
        if secret:
            headers["X-AIStudio-Signature"] = webhook_signature(secret, ts, body)
        await post(self.deps.http, url, "Webhook", content=body, headers=headers)
        return None
