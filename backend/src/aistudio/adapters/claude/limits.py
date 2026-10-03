"""Subscription limit windows from Claude Code (spec §17).

Two sources, with DIFFERENT utilization scales:

* ``rate_limit_event`` (stream): ``rate_limit_info.utilization`` and
  ``unifiedWindows.<w>.utilization`` are FRACTIONS (usually 0..1, may exceed 1 when usage runs
  past a cap); ``resetsAt`` is unix epoch SECONDS. Taken from the
  ``anthropic-ratelimit-unified-*`` response headers.
* ``get_usage`` control request (no model turn, used by ``read_limits``):
  ``rate_limits.<w>.utilization`` is a PERCENT (0..100); ``resets_at`` is an ISO-8601 string.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from aistudio.adapters.claude.protocol import as_dict, as_float, as_list, as_str
from aistudio.contracts.limits import LimitWindow

Status = Literal["ok", "warning", "exhausted"]

FIVE_HOURS_MIN = 5 * 60
SEVEN_DAYS_MIN = 7 * 24 * 60
WARNING_PERCENT = 80.0

_LABELS: dict[str, str] = {
    "five_hour": "5 saat",
    "seven_day": "Haftalık",
    "seven_day_opus": "Haftalık (Opus)",
    "seven_day_sonnet": "Haftalık (Sonnet)",
    "seven_day_overage_included": "Haftalık (model)",
    "overage": "Ek kullanım",
}
_MINUTES: dict[str, int] = {
    "five_hour": FIVE_HOURS_MIN,
    "seven_day": SEVEN_DAYS_MIN,
    "seven_day_opus": SEVEN_DAYS_MIN,
    "seven_day_sonnet": SEVEN_DAYS_MIN,
    "seven_day_overage_included": SEVEN_DAYS_MIN,
}
_STATUS: dict[str, Status] = {"allowed": "ok", "allowed_warning": "warning", "rejected": "exhausted"}


def window_label(window: str) -> str:
    if window in _LABELS:
        return _LABELS[window]
    if window.startswith("seven_day_model:"):
        return f"Haftalık ({window.split(':', 1)[1]})"
    return window.replace("_", " ")


def window_minutes(window: str) -> int | None:
    if window in _MINUTES:
        return _MINUTES[window]
    if window.startswith("seven_day"):
        return SEVEN_DAYS_MIN
    return None


def _clamp_percent(value: float) -> float:
    return round(max(0.0, min(100.0, value)), 2)


def _epoch(value: Any) -> datetime | None:
    seconds = as_float(value)
    if seconds is None or seconds <= 0:
        return None
    if seconds > 10_000_000_000:  # defensive: milliseconds
        seconds /= 1000.0
    try:
        return datetime.fromtimestamp(seconds, UTC)
    except (OverflowError, OSError, ValueError):
        return None


def _iso(value: Any) -> datetime | None:
    text = as_str(value)
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _derived_status(percent: float) -> Status:
    return "warning" if percent >= WARNING_PERCENT else "ok"


def windows_from_rate_limit_event(event: dict[str, Any], *, observed_at: datetime) -> list[LimitWindow]:
    """Windows from one ``rate_limit_event`` message (or its ``rate_limit_info`` dict)."""
    info = as_dict(event.get("rate_limit_info")) if "rate_limit_info" in event else event
    status = _STATUS.get(as_str(info.get("status")) or "", "ok")
    limiting = as_str(info.get("rateLimitType"))
    out: dict[str, LimitWindow] = {}

    for name, raw in as_dict(info.get("unifiedWindows")).items():
        win = as_dict(raw)
        util = as_float(win.get("utilization"))
        if util is None:
            continue
        percent = _clamp_percent(util * 100.0)
        win_status: Status = status if name == limiting else _derived_status(percent)
        if name != limiting and percent >= 100.0 and status == "exhausted":
            win_status = "exhausted"
        out[name] = LimitWindow(
            provider="claude",
            window=name,
            label=window_label(name),
            used_percent=percent,
            resets_at=_epoch(win.get("resetsAt")),
            window_minutes=window_minutes(name),
            status=win_status,
            source="event",
            observed_at=observed_at,
        )

    if limiting:
        util = as_float(info.get("utilization"))
        existing = out.get(limiting)
        if util is not None:
            percent = _clamp_percent(util * 100.0)
        elif existing is not None:
            percent = existing.used_percent
        else:
            # No utilization: a rejection means the window is full; otherwise unknown -> skip.
            percent = 100.0 if status == "exhausted" else -1.0
        if percent >= 0:
            out[limiting] = LimitWindow(
                provider="claude",
                window=limiting,
                label=window_label(limiting),
                used_percent=percent,
                resets_at=_epoch(info.get("resetsAt")) or (existing.resets_at if existing else None),
                window_minutes=window_minutes(limiting),
                status=status,
                source="event",
                observed_at=observed_at,
            )
    order = list(_LABELS)
    return sorted(out.values(), key=lambda w: (order.index(w.window) if w.window in order else len(order), w.window))


def windows_from_usage_response(response: dict[str, Any], *, observed_at: datetime) -> list[LimitWindow]:
    """Windows from a ``get_usage`` control response (percent scale, ISO reset times)."""
    if response.get("rate_limits_available") is False:
        return []
    limits = as_dict(response.get("rate_limits"))
    out: list[LimitWindow] = []

    def add(window: str, raw: Any) -> None:
        entry = as_dict(raw)
        util = as_float(entry.get("utilization"))
        if util is None:
            return
        percent = _clamp_percent(util)
        out.append(
            LimitWindow(
                provider="claude",
                window=window,
                label=window_label(window),
                used_percent=percent,
                resets_at=_iso(entry.get("resets_at")),
                window_minutes=window_minutes(window),
                status="exhausted" if percent >= 100.0 else _derived_status(percent),
                source="probe",
                observed_at=observed_at,
            )
        )

    for name in ("five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"):
        add(name, limits.get(name))
    for item in as_list(limits.get("model_scoped")):
        entry = as_dict(item)
        display = as_str(entry.get("display_name"))
        if display:
            add(f"seven_day_model:{display}", entry)
    return out
