"""Alert, channel, rule and delivery models (API + internal)."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field

from aistudio.core.errors import ValidationFailed
from aistudio.core.events import Severity

ChannelKind = Literal["macos", "slack", "telegram", "discord", "teams", "email", "ntfy", "webhook"]
CHANNEL_KINDS: tuple[ChannelKind, ...] = ("macos", "slack", "telegram", "discord", "teams", "email", "ntfy", "webhook")
DeliveryStatus = Literal["sent", "failed", "suppressed", "rate_limited", "deduplicated", "grouped"]

SEVERITY_RANK: dict[Severity, int] = {Severity.info: 0, Severity.normal: 1, Severity.high: 2, Severity.critical: 3}


class AlertItem(BaseModel):
    """One member of a grouped alert ("3 onay bekliyor")."""

    title: str
    body: str = ""
    link: str | None = None
    approval_id: str | None = None
    approval_kind: str | None = None
    production: bool = False
    actionable: bool = False


class Alert(BaseModel):
    id: str
    event_id: int | None = None
    event_type: str
    severity: Severity
    title: str
    body: str = ""
    link: str | None = None  # aistudio://approval/<id> | aistudio://task/<id> | aistudio://run/<id>
    web_url: str | None = None  # https link (PR page...) for channels that can open it
    workspace_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    approval_id: str | None = None
    approval_kind: str | None = None
    production: bool = False
    actionable: bool = False  # Onayla / Reddet make sense (pending approval, not a question)
    dedup_key: str
    group_key: str | None = None
    group_label: str | None = None  # "{n} onay bekliyor"
    items: list[AlertItem] = Field(default_factory=list)
    sound: bool = False
    silent: bool = False  # quiet hours: show without sound / without push
    test: bool = False
    created_at: datetime

    def approval_targets(self) -> list[AlertItem]:
        """Approvals this message is about (one for a single alert, several for a group)."""
        if self.items:
            return [i for i in self.items if i.approval_id]
        if self.approval_id:
            return [
                AlertItem(
                    title=self.title,
                    body=self.body,
                    link=self.link,
                    approval_id=self.approval_id,
                    approval_kind=self.approval_kind,
                    production=self.production,
                    actionable=self.actionable,
                )
            ]
        return []


# --------------------------------------------------------------------------- channels


class ChannelKindSpec(BaseModel):
    kind: ChannelKind
    label: str
    two_way: bool
    description: str
    config_fields: list[str]
    secret_fields: list[str]


class ChannelOut(BaseModel):
    id: str
    kind: ChannelKind
    name: str
    enabled: bool
    config: dict[str, Any] = Field(default_factory=dict)
    secrets_set: list[str] = Field(default_factory=list)  # which secret fields have a value
    two_way: bool = False
    listening: bool = False
    last_error: str | None = None
    created_at: datetime
    updated_at: datetime


class ChannelCreate(BaseModel):
    kind: ChannelKind
    name: str | None = None
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, str] = Field(default_factory=dict)


class ChannelUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    config: dict[str, Any] | None = None  # replaces the config
    secrets: dict[str, str | None] | None = None  # merged; null/"" removes a secret


class LinkCode(BaseModel):
    code: str
    expires_at: datetime
    instructions: str


# --------------------------------------------------------------------------- rules


class AlertRule(BaseModel):
    id: str
    name: str
    enabled: bool = True
    event_types: list[str] = Field(default_factory=list)  # "pr.*" prefix patterns; empty = all
    min_severity: Severity = Severity.info
    workspace_id: str | None = None
    channel_ids: list[str] = Field(default_factory=list)  # empty = mute matching alerts
    sound: bool = False
    bypass_quiet_hours: bool = False
    created_at: datetime
    updated_at: datetime

    def matches(self, alert: Alert) -> bool:
        if not self.enabled:
            return False
        if SEVERITY_RANK[alert.severity] < SEVERITY_RANK[self.min_severity]:
            return False
        if self.workspace_id is not None and alert.workspace_id != self.workspace_id:
            return False
        if self.event_types:
            return any(
                alert.event_type.startswith(t[:-1]) if t.endswith(".*") else alert.event_type == t
                for t in self.event_types
            )
        return True

    def names_type(self, event_type: str) -> bool:
        """True if the rule explicitly lists ``event_type`` (used for events without a catalog entry)."""
        return self.enabled and any(
            event_type.startswith(t[:-1]) if t.endswith(".*") else event_type == t for t in self.event_types
        )


class AlertRuleCreate(BaseModel):
    name: str
    enabled: bool = True
    event_types: list[str] = Field(default_factory=list)
    min_severity: Severity = Severity.info
    workspace_id: str | None = None
    channel_ids: list[str] = Field(default_factory=list)
    sound: bool = False
    bypass_quiet_hours: bool = False


class AlertRuleUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    event_types: list[str] | None = None
    min_severity: Severity | None = None
    workspace_id: str | None = None
    channel_ids: list[str] | None = None
    sound: bool | None = None
    bypass_quiet_hours: bool | None = None


# --------------------------------------------------------------------------- settings

_HHMM = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class QuietHours(BaseModel):
    enabled: bool = False
    start: str = "23:00"
    end: str = "08:00"
    timezone: str | None = None  # IANA name; None = the Mac's local time zone
    days: list[int] | None = None  # 0=Mon..6=Sun (day the window starts); None = every day

    def check(self) -> QuietHours:
        """Validate values (raises ``ValidationFailed`` with a Turkish message)."""
        for value in (self.start, self.end):
            if not _HHMM.match(value):
                raise ValidationFailed("Saat SS:DD biçiminde olmalı (ör. 23:00).", details={"value": value})
        if self.timezone:
            try:
                ZoneInfo(self.timezone)
            except (ZoneInfoNotFoundError, ValueError) as e:
                raise ValidationFailed("Geçersiz saat dilimi.", details={"timezone": self.timezone}) from e
        if self.days is not None and any(d < 0 or d > 6 for d in self.days):
            raise ValidationFailed("Günler 0 (Pazartesi) ile 6 (Pazar) arasında olmalı.")
        return self.model_copy(update={"timezone": self.timezone or None})

    def is_valid(self) -> bool:
        try:
            self.check()
        except ValidationFailed:
            return False
        return True


class AlertSettings(BaseModel):
    enabled: bool = True
    dedup_seconds: int = 300
    group_window_seconds: int = 60
    rate_limit_per_minute: int = 20
    primary_channel_id: str | None = None
    confirm_timeout_seconds: int = 120


class AlertSettingsUpdate(BaseModel):
    enabled: bool | None = None
    dedup_seconds: int | None = Field(default=None, ge=0, le=86400)
    group_window_seconds: int | None = Field(default=None, ge=0, le=3600)
    rate_limit_per_minute: int | None = Field(default=None, ge=1, le=600)
    primary_channel_id: str | None = None
    clear_primary_channel: bool = False
    confirm_timeout_seconds: int | None = Field(default=None, ge=10, le=3600)


class RoutingRow(BaseModel):
    severity: Severity
    label: str
    channels: str
    examples: list[str]
    bypasses_quiet_hours: bool = False


class AlertDefaults(BaseModel):
    routing: list[RoutingRow]
    settings: AlertSettings
    quiet_hours: QuietHours
    primary_channel_id: str | None = None  # the channel used as "birincil mobil kanal" right now


# --------------------------------------------------------------------------- delivery


class DeliveryOutcome(BaseModel):
    alert_id: str
    channel_id: str | None = None
    channel_kind: str | None = None
    status: DeliveryStatus
    attempts: int = 0
    error: str | None = None


class DeliveryLogEntry(BaseModel):
    id: int
    alert_id: str
    channel_id: str | None = None
    channel_kind: str | None = None
    event_id: int | None = None
    event_type: str
    severity: Severity
    title: str
    status: DeliveryStatus
    attempts: int = 0
    error: str | None = None
    approval_id: str | None = None
    test: bool = False
    created_at: datetime
