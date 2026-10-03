from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from aistudio.alerts.models import Alert, AlertRule, QuietHours
from aistudio.alerts.routing import (
    ChannelRecord,
    Deduper,
    Grouper,
    RateLimiter,
    default_channels,
    make_group_alert,
    quiet_active,
    route,
)
from aistudio.core.errors import ValidationFailed
from aistudio.core.events import Severity

T0 = datetime(2026, 10, 3, 9, 0, tzinfo=UTC)


def chan(cid: str, kind: Any, minutes: int, enabled: bool = True) -> ChannelRecord:
    at = T0 + timedelta(minutes=minutes)
    return ChannelRecord(
        id=cid,
        kind=kind,
        name=cid,
        enabled=enabled,
        config={},
        secret_refs={},
        last_error=None,
        created_at=at,
        updated_at=at,
    )


CHANNELS = [
    chan("mac", "macos", 0),
    chan("ntfy_off", "ntfy", 1, enabled=False),
    chan("tg", "telegram", 2),
    chan("slack", "slack", 3),
    chan("discord", "discord", 4),
    chan("mail", "email", 5),
]


def alert(severity: Severity, event_type: str = "x.y", workspace_id: str | None = "ws_1") -> Alert:
    return Alert(
        id="a",
        event_type=event_type,
        severity=severity,
        title="t",
        dedup_key="k",
        workspace_id=workspace_id,
        created_at=T0,
    )


def rule(**over: Any) -> AlertRule:
    fields: dict[str, Any] = {"id": "r1", "name": "kural", "created_at": T0, "updated_at": T0}
    fields.update(over)
    return AlertRule(**fields)


@pytest.mark.parametrize(
    ("severity", "expected", "sound"),
    [
        (Severity.critical, ["mac", "tg", "slack", "discord", "mail"], True),
        (Severity.high, ["mac", "tg"], False),  # macOS + first enabled telegram/slack/ntfy
        (Severity.normal, ["mac"], False),
        (Severity.info, [], False),
    ],
)
def test_default_routing_table(severity: Severity, expected: list[str], sound: bool) -> None:
    decision = route(alert(severity), CHANNELS, [], None)
    assert decision.channel_ids == expected
    assert decision.sound is sound
    assert decision.bypass_quiet is (severity == Severity.critical)


def test_primary_mobile_channel_can_be_chosen() -> None:
    assert [c.id for c in default_channels(Severity.high, CHANNELS, "slack")] == ["mac", "slack"]
    # A disabled preferred channel falls back to the first enabled mobile channel.
    assert [c.id for c in default_channels(Severity.high, CHANNELS, "ntfy_off")] == ["mac", "tg"]


def test_rules_override_defaults() -> None:
    pr_to_discord = rule(event_types=["pr.*"], channel_ids=["discord", "ntfy_off"], sound=True)
    decision = route(alert(Severity.normal, "pr.review"), CHANNELS, [pr_to_discord], None)
    assert decision.channel_ids == ["discord"]  # disabled channels never receive
    assert decision.sound is True and decision.rule_ids == ["r1"]
    assert route(alert(Severity.normal, "task.completed"), CHANNELS, [pr_to_discord], None).channel_ids == ["mac"]

    mute = rule(event_types=["task.completed"], channel_ids=[])
    assert route(alert(Severity.normal, "task.completed"), CHANNELS, [mute], None).channel_ids == []

    other_ws = rule(workspace_id="ws_2", channel_ids=["mail"])
    assert route(alert(Severity.normal), CHANNELS, [other_ws], None).channel_ids == ["mac"]
    assert route(alert(Severity.normal, workspace_id="ws_2"), CHANNELS, [other_ws], None).channel_ids == ["mail"]

    min_high = rule(min_severity=Severity.high, channel_ids=["slack"], bypass_quiet_hours=True)
    assert route(alert(Severity.normal), CHANNELS, [min_high], None).channel_ids == ["mac"]
    high = route(alert(Severity.high), CHANNELS, [min_high], None)
    assert high.channel_ids == ["slack"] and high.bypass_quiet is True

    disabled = rule(enabled=False, channel_ids=["mail"])
    assert route(alert(Severity.normal), CHANNELS, [disabled], None).channel_ids == ["mac"]

    union = [rule(id="a", event_types=["pr.review"], channel_ids=["slack"]), rule(id="b", channel_ids=["mail"])]
    assert route(alert(Severity.normal, "pr.review"), CHANNELS, union, None).channel_ids == ["slack", "mail"]


IST = "Europe/Istanbul"  # UTC+3


@pytest.mark.parametrize(
    ("utc_time", "qh", "active"),
    [
        (datetime(2026, 10, 3, 23, 30, tzinfo=UTC), QuietHours(enabled=True, timezone=IST), True),  # 02:30 local
        (datetime(2026, 10, 3, 9, 0, tzinfo=UTC), QuietHours(enabled=True, timezone=IST), False),  # 12:00
        (datetime(2026, 10, 3, 4, 59, tzinfo=UTC), QuietHours(enabled=True, timezone=IST), True),  # 07:59
        (datetime(2026, 10, 3, 5, 0, tzinfo=UTC), QuietHours(enabled=True, timezone=IST), False),  # 08:00
        (datetime(2026, 10, 3, 23, 30, tzinfo=UTC), QuietHours(enabled=False, timezone=IST), False),
        (
            datetime(2026, 10, 3, 11, 0, tzinfo=UTC),
            QuietHours(enabled=True, start="13:00", end="15:00", timezone=IST),
            True,
        ),
        # Sat 3 Oct 2026, 02:30 local: the window started on Friday (weekday 4).
        (
            datetime(2026, 10, 3, 23, 30, tzinfo=UTC) - timedelta(days=1),
            QuietHours(enabled=True, timezone=IST, days=[4]),
            True,
        ),
        (
            datetime(2026, 10, 3, 23, 30, tzinfo=UTC) - timedelta(days=1),
            QuietHours(enabled=True, timezone=IST, days=[5]),
            False,
        ),
    ],
)
def test_quiet_hours(utc_time: datetime, qh: QuietHours, active: bool) -> None:
    assert quiet_active(qh, utc_time) is active


def test_quiet_hours_validation() -> None:
    with pytest.raises(ValidationFailed, match="SS:DD"):
        QuietHours(start="25:00").check()
    with pytest.raises(ValidationFailed, match="saat dilimi"):
        QuietHours(timezone="Mars/Olympus").check()
    with pytest.raises(ValidationFailed, match="Günler"):
        QuietHours(days=[7]).check()
    # Invalid stored values never silence alerts.
    assert quiet_active(QuietHours(enabled=True, start="99:00"), T0) is False


def test_dedup_window() -> None:
    d = Deduper()
    assert d.seen("k", T0, 300) is False
    assert d.seen("k", T0 + timedelta(seconds=299), 300) is True
    assert d.seen("k", T0 + timedelta(seconds=301), 300) is False
    assert d.seen("other", T0, 300) is False


def test_grouper_leading_edge_and_flush() -> None:
    g = Grouper()
    a = [
        alert(Severity.high).model_copy(
            update={"id": f"a{i}", "group_key": "approval", "group_label": "{n} onay bekliyor"}
        )
        for i in range(4)
    ]
    assert g.offer(a[0], T0, 60) is True  # first one goes out immediately
    assert [g.offer(x, T0 + timedelta(seconds=5), 60) for x in a[1:]] == [False, False, False]
    assert g.due(T0 + timedelta(seconds=30), 60) == []
    batches = g.due(T0 + timedelta(seconds=61), 60)
    assert [[x.id for x in b] for b in batches] == [["a1", "a2", "a3"]]
    grouped = make_group_alert(batches[0], T0)
    assert grouped.title == "3 onay bekliyor" and len(grouped.items) == 3
    assert grouped.link == "aistudio://approvals" and grouped.group_key is None
    # The window stays open after a flush, so a continuing burst is throttled too.
    assert g.offer(a[0], T0 + timedelta(seconds=70), 60) is False
    assert g.due(T0 + timedelta(seconds=200), 60, force=True) != []
    assert g.due(T0 + timedelta(seconds=300), 60) == []
    assert g.offer(alert(Severity.normal), T0, 60) is True  # no group key


def test_rate_limiter() -> None:
    rl = RateLimiter()
    assert [rl.allow("c", T0, 2) for _ in range(3)] == [True, True, False]
    assert rl.allow("c", T0 + timedelta(seconds=30), 2) is True  # refilled one token
    assert rl.allow("other", T0, 2) is True
