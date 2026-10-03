"""Routing (spec §15): default severity routing, user rules, quiet hours, dedup, grouping and
per-channel rate limits. Everything here is synchronous and clock-injected for tests.

Default routing:
    Kritik  -> every enabled channel + sound (bypasses quiet hours)
    Yüksek  -> macOS + the primary mobile channel (first enabled telegram / slack / ntfy, or the
               one chosen in ``alerts.primary_channel_id``)
    Normal  -> macOS
    Bilgi   -> nothing (in-app only)
Enabled user rules that match an alert replace the default (union of their channels; a matching
rule with no channels mutes the alert).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from aistudio.alerts.catalog import GROUP_LINKS
from aistudio.alerts.models import SEVERITY_RANK, Alert, AlertItem, AlertRule, ChannelKind, QuietHours, RoutingRow
from aistudio.alerts.render import first_line
from aistudio.core.events import Severity
from aistudio.core.ids import new_id

MOBILE_KINDS: tuple[ChannelKind, ...] = ("telegram", "slack", "ntfy")

DEFAULT_ROUTING: list[RoutingRow] = [
    RoutingRow(
        severity=Severity.critical,
        label="Kritik",
        channels="Tüm etkin kanallar + sesli macOS bildirimi",
        examples=[
            "Production komut veya deploy onayı bekliyor",
            "Production deploy başarısız",
            "Sınır ihlali",
            "Ajan çöktü veya takıldı",
            "Limit doldu, iş kuyruğa alındı",
        ],
        bypasses_quiet_hours=True,
    ),
    RoutingRow(
        severity=Severity.high,
        label="Yüksek",
        channels="macOS + birincil mobil kanal",
        examples=[
            "Onay bekleyen iş (plan, birleştirme, son onay, ajan sorusu)",
            "Kapı tur sınırını aştı",
            "PR takibi CI'ı düzeltemedi",
            "Production deploy başarılı",
        ],
    ),
    RoutingRow(
        severity=Severity.normal,
        label="Normal",
        channels="macOS",
        examples=[
            "Görev tamamlandı",
            "PR'a yeni review",
            "Limit %80",
            "Zamanlanmış görev başladı veya bitti",
            "Test ortamına deploy",
        ],
    ),
    RoutingRow(
        severity=Severity.info,
        label="Bilgi",
        channels="Yalnız uygulama içi",
        examples=["Hafıza önerisi", "Ajan devretti", "Limit sıfırlandı"],
    ),
]


@dataclass
class ChannelRecord:
    id: str
    kind: ChannelKind
    name: str
    enabled: bool
    config: dict[str, Any]
    secret_refs: dict[str, str]
    last_error: str | None
    created_at: datetime
    updated_at: datetime


@dataclass
class RouteDecision:
    channel_ids: list[str]
    sound: bool
    bypass_quiet: bool
    rule_ids: list[str] = field(default_factory=list)


def primary_mobile(channels: list[ChannelRecord], preferred_id: str | None) -> ChannelRecord | None:
    if preferred_id:
        chosen = next((c for c in channels if c.id == preferred_id and c.enabled), None)
        if chosen is not None:
            return chosen
    candidates = [c for c in channels if c.enabled and c.kind in MOBILE_KINDS]
    return min(candidates, key=lambda c: c.created_at) if candidates else None


def default_channels(
    severity: Severity, channels: list[ChannelRecord], preferred_id: str | None
) -> list[ChannelRecord]:
    enabled = [c for c in channels if c.enabled]
    macos = [c for c in enabled if c.kind == "macos"]
    if severity == Severity.critical:
        return enabled
    if severity == Severity.high:
        mobile = primary_mobile(channels, preferred_id)
        return macos + ([mobile] if mobile is not None and mobile not in macos else [])
    if severity == Severity.normal:
        return macos
    return []


def route(
    alert: Alert, channels: list[ChannelRecord], rules: list[AlertRule], preferred_id: str | None
) -> RouteDecision:
    critical = alert.severity == Severity.critical
    matched = [r for r in rules if r.matches(alert)]
    if matched:
        enabled = {c.id for c in channels if c.enabled}
        ids: list[str] = []
        for rule in matched:
            for cid in rule.channel_ids:
                if cid in enabled and cid not in ids:
                    ids.append(cid)
        return RouteDecision(
            channel_ids=ids,
            sound=critical or any(r.sound for r in matched),
            bypass_quiet=critical or any(r.bypass_quiet_hours for r in matched),
            rule_ids=[r.id for r in matched],
        )
    picked = default_channels(alert.severity, channels, preferred_id)
    return RouteDecision(channel_ids=[c.id for c in picked], sound=critical, bypass_quiet=critical)


def _parse_hhmm(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


def quiet_active(qh: QuietHours, now: datetime) -> bool:
    """Is ``now`` inside the quiet window? Windows may wrap past midnight (23:00 -> 08:00)."""
    if not qh.enabled or not qh.is_valid():
        return False
    local = now.astimezone(ZoneInfo(qh.timezone)) if qh.timezone else now.astimezone()
    start, end = _parse_hhmm(qh.start), _parse_hhmm(qh.end)
    current = local.time().replace(second=0, microsecond=0)
    if start == end:
        inside, window_day = True, local.weekday()
    elif start < end:
        inside, window_day = start <= current < end, local.weekday()
    else:
        inside = current >= start or current < end
        # After midnight the window started the previous day.
        window_day = local.weekday() if current >= start else (local.weekday() - 1) % 7
    if not inside:
        return False
    return qh.days is None or window_day in qh.days


class Deduper:
    """Same dedup key within the window -> one notification."""

    def __init__(self) -> None:
        self._seen: dict[str, datetime] = {}

    def seen(self, key: str, now: datetime, window: float) -> bool:
        last = self._seen.get(key)
        if last is not None and window > 0 and (now - last).total_seconds() < window:
            return True
        self._seen[key] = now
        return False

    def prune(self, now: datetime, window: float) -> None:
        horizon = now - timedelta(seconds=max(window, 1))
        for key in [k for k, t in self._seen.items() if t < horizon]:
            del self._seen[key]


@dataclass
class _Group:
    opened_at: datetime
    buffered: list[Alert] = field(default_factory=list)


class Grouper:
    """Leading-edge grouping: the first alert of a group goes out at once; more alerts of the same
    group within the window are buffered and flushed as one message ("3 onay bekliyor")."""

    def __init__(self) -> None:
        self._groups: dict[str, _Group] = {}

    def offer(self, alert: Alert, now: datetime, window: float) -> bool:
        """True = send now; False = buffered for the group message."""
        key = alert.group_key
        if not key or window <= 0:
            return True
        group = self._groups.get(key)
        if group is None or (not group.buffered and (now - group.opened_at).total_seconds() >= window):
            self._groups[key] = _Group(opened_at=now)
            return True
        group.buffered.append(alert)
        return False

    def due(self, now: datetime, window: float, *, force: bool = False) -> list[list[Alert]]:
        out: list[list[Alert]] = []
        for key, group in list(self._groups.items()):
            if not force and (now - group.opened_at).total_seconds() < window:
                continue
            if group.buffered:
                out.append(group.buffered)
                self._groups[key] = _Group(opened_at=now)  # keep throttling a continuing burst
            else:
                del self._groups[key]
        return out

    def pending(self) -> int:
        return sum(len(g.buffered) for g in self._groups.values())


def make_group_alert(items: list[Alert], now: datetime) -> Alert:
    if len(items) == 1:
        return items[0]
    first = items[0]
    severity = max((a.severity for a in items), key=SEVERITY_RANK.__getitem__)
    label = first.group_label or "{n} uyarı"
    members = [
        AlertItem(
            title=a.title,
            body=first_line(a.body, 200),
            link=a.link,
            approval_id=a.approval_id,
            approval_kind=a.approval_kind,
            production=a.production,
            actionable=a.actionable,
        )
        for a in items
    ]
    lines = [f"• {a.title}" + (f" — {first_line(a.body, 100)}" if a.body else "") for a in items[:10]]
    if len(items) > 10:
        lines.append(f"… ve {len(items) - 10} tane daha")
    workspaces = {a.workspace_id for a in items}
    return Alert(
        id=new_id("alert"),
        event_type=first.event_type,
        severity=severity,
        title=label.format(n=len(items)),
        body="\n".join(lines),
        link=GROUP_LINKS.get(first.group_key or "", first.link),
        workspace_id=next(iter(workspaces)) if len(workspaces) == 1 else None,
        dedup_key=f"group:{first.group_key}:{now.isoformat()}",
        items=members,
        created_at=now,
    )


class RateLimiter:
    """Token bucket per channel (``per_minute`` messages, burst = ``per_minute``)."""

    def __init__(self) -> None:
        self._buckets: dict[str, tuple[float, datetime]] = {}

    def allow(self, key: str, now: datetime, per_minute: int) -> bool:
        capacity = float(max(1, per_minute))
        tokens, last = self._buckets.get(key, (capacity, now))
        tokens = min(capacity, tokens + (now - last).total_seconds() * capacity / 60.0)
        if tokens < 1.0:
            self._buckets[key] = (tokens, now)
            return False
        self._buckets[key] = (tokens - 1.0, now)
        return True
