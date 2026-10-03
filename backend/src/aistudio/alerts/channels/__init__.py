"""Channel registry: kind descriptions (for the settings UI), validation and construction."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from aistudio.alerts.channels.base import Channel, ChannelDeps, ChannelError
from aistudio.alerts.channels.simple import (
    DiscordChannel,
    EmailChannel,
    MacosChannel,
    NtfyChannel,
    TeamsChannel,
    WebhookChannel,
    split_ntfy_url,
)
from aistudio.alerts.channels.slack import SlackChannel
from aistudio.alerts.channels.telegram import TelegramChannel
from aistudio.alerts.models import ChannelKind, ChannelKindSpec
from aistudio.core.errors import ValidationFailed

CHANNEL_CLASSES: dict[ChannelKind, type[Channel]] = {
    "macos": MacosChannel,
    "slack": SlackChannel,
    "telegram": TelegramChannel,
    "discord": DiscordChannel,
    "teams": TeamsChannel,
    "email": EmailChannel,
    "ntfy": NtfyChannel,
    "webhook": WebhookChannel,
}

KIND_SPECS: dict[ChannelKind, ChannelKindSpec] = {
    "macos": ChannelKindSpec(
        kind="macos",
        label="macOS bildirimi",
        two_way=False,
        description="Butonlu yerel bildirim (Onayla / Reddet / Aç). Ağ gerektirmez.",
        config_fields=[],
        secret_fields=[],
    ),
    "slack": ChannelKindSpec(
        kind="slack",
        label="Slack",
        two_way=True,
        description=(
            "Gelen webhook ile tek yönlü ya da bot + uygulama belirteci (Socket Mode) ile butonlu, çift yönlü."
        ),
        config_fields=["mode", "channel", "allowed_user_ids"],
        secret_fields=["webhook_url", "bot_token", "app_token"],
    ),
    "telegram": ChannelKindSpec(
        kind="telegram",
        label="Telegram",
        two_way=True,
        description="Bot ile satır içi butonlu, çift yönlü. Uzun sorgulama kullanır, dışarıdan erişim gerekmez.",
        config_fields=["chat_id", "linked_user_id"],
        secret_fields=["bot_token"],
    ),
    "discord": ChannelKindSpec(
        kind="discord",
        label="Discord",
        two_way=False,
        description="Webhook ile zengin kart (embed).",
        config_fields=["username"],
        secret_fields=["webhook_url"],
    ),
    "teams": ChannelKindSpec(
        kind="teams",
        label="Microsoft Teams",
        two_way=False,
        description="Teams Workflows (ya da gelen webhook) ile Adaptive Card.",
        config_fields=[],
        secret_fields=["webhook_url"],
    ),
    "email": ChannelKindSpec(
        kind="email",
        label="E-posta",
        two_way=False,
        description="SMTP (STARTTLS ya da TLS).",
        config_fields=["host", "port", "security", "username", "from_addr", "to_addrs"],
        secret_fields=["password"],
    ),
    "ntfy": ChannelKindSpec(
        kind="ntfy",
        label="Telefona push (ntfy)",
        two_way=False,
        description="ntfy konusuna push; öneme göre öncelik, dokununca uygulamada açılır.",
        config_fields=[],
        secret_fields=["topic_url", "token"],
    ),
    "webhook": ChannelKindSpec(
        kind="webhook",
        label="Genel webhook",
        two_way=False,
        description="JSON POST; isteğe bağlı HMAC-SHA256 imzası.",
        config_fields=[],
        secret_fields=["url", "signing_secret"],
    ),
}

DEFAULT_NAMES: dict[ChannelKind, str] = {k: v.label for k, v in KIND_SPECS.items()}


def _https(url: str | None, field: str, *, allow_http: bool = False) -> None:
    parts = urlsplit(url or "")
    schemes = ("https", "http") if allow_http else ("https",)
    if parts.scheme not in schemes or not parts.netloc:
        raise ValidationFailed(f"{field} geçerli bir {'http(s)' if allow_http else 'https'} adresi olmalı.")


def validate_channel(kind: ChannelKind, config: dict[str, Any], secrets: dict[str, str]) -> dict[str, Any]:
    """Check required fields for ``kind``; returns the normalized config. ``secrets`` = effective values."""
    spec = KIND_SPECS[kind]
    unknown = set(secrets) - set(spec.secret_fields)
    if unknown:
        raise ValidationFailed(f"Bu kanal türü için bilinmeyen gizli alan: {', '.join(sorted(unknown))}")
    cfg = {k: v for k, v in config.items() if v is not None}
    if kind == "slack":
        mode = str(cfg.get("mode") or ("bot" if secrets.get("bot_token") else "webhook"))
        if mode not in ("webhook", "bot"):
            raise ValidationFailed("Slack modu 'webhook' ya da 'bot' olmalı.")
        cfg["mode"] = mode
        if mode == "webhook":
            _https(secrets.get("webhook_url"), "Slack webhook adresi")
        else:
            if not secrets.get("bot_token"):
                raise ValidationFailed("Slack bot modu için bot belirteci (xoxb-…) gerekli.")
            if not cfg.get("channel"):
                raise ValidationFailed("Slack bot modu için kanal kimliği gerekli (ör. C0123ABCD).")
        ids = cfg.get("allowed_user_ids") or []
        if not isinstance(ids, list):
            raise ValidationFailed("allowed_user_ids bir liste olmalı.")
        cfg["allowed_user_ids"] = [str(i).strip() for i in ids if str(i).strip()]
    elif kind == "telegram":
        if not secrets.get("bot_token"):
            raise ValidationFailed("Telegram için bot belirteci gerekli (BotFather'dan alınır).")
        for key in ("chat_id", "linked_user_id"):
            if cfg.get(key) is not None:
                cfg[key] = str(cfg[key]).strip() or None
    elif kind in ("discord", "teams"):
        _https(secrets.get("webhook_url"), "Webhook adresi")
    elif kind == "email":
        for key, label in (("host", "SMTP sunucusu"), ("from_addr", "Gönderen adresi")):
            if not str(cfg.get(key) or "").strip():
                raise ValidationFailed(f"{label} gerekli.")
        to = cfg.get("to_addrs") or []
        if isinstance(to, str):
            to = [t.strip() for t in to.split(",")]
        to = [str(t).strip() for t in to if str(t).strip()]
        if not to or any("@" not in t for t in to):
            raise ValidationFailed("En az bir geçerli alıcı e-posta adresi gerekli.")
        cfg["to_addrs"] = to
        security = str(cfg.get("security") or "starttls")
        if security not in ("starttls", "tls", "none"):
            raise ValidationFailed("Güvenlik 'starttls', 'tls' ya da 'none' olmalı.")
        cfg["security"] = security
        if cfg.get("port") is not None:
            try:
                cfg["port"] = int(cfg["port"])
            except (TypeError, ValueError) as e:
                raise ValidationFailed("Port bir sayı olmalı.") from e
    elif kind == "ntfy":
        if not secrets.get("topic_url"):
            raise ValidationFailed("ntfy konu adresi gerekli (ör. https://ntfy.sh/konu-adi).")
        try:
            split_ntfy_url(secrets["topic_url"])
        except ChannelError as e:
            raise ValidationFailed(e.message) from e
    elif kind == "webhook":
        _https(secrets.get("url"), "Webhook adresi", allow_http=True)
    return cfg


def build_channel(
    kind: ChannelKind,
    *,
    channel_id: str,
    name: str,
    config: dict[str, Any],
    secrets: dict[str, str],
    deps: ChannelDeps,
) -> Channel:
    cls = CHANNEL_CLASSES[kind]
    return cls(channel_id=channel_id, name=name, config=config, secrets=secrets, deps=deps)


__all__ = [
    "CHANNEL_CLASSES",
    "DEFAULT_NAMES",
    "KIND_SPECS",
    "Channel",
    "ChannelDeps",
    "ChannelError",
    "build_channel",
    "validate_channel",
]
