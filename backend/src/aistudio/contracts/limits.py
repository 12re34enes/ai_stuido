"""Subscription limit tracking (spec §17). Plan-agnostic: windows are whatever the CLI reports.

Claude ``rate_limit_event`` windows: five_hour, seven_day, seven_day_opus, seven_day_sonnet, ...
Codex ``account/rateLimits``: primary (usually 5h) and secondary (usually weekly) with
``windowDurationMins``; adapters map those to ``five_hour`` / ``seven_day`` when the duration
matches, otherwise keep ``primary`` / ``secondary``.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from aistudio.contracts.common import Provider


class LimitWindow(BaseModel):
    provider: Provider
    window: str  # five_hour | seven_day | seven_day_opus | primary | secondary | ...
    label: str  # Turkish display label: "5 saat", "Haftalık", "Haftalık (Opus)"
    used_percent: float  # 0..100
    resets_at: datetime | None = None
    window_minutes: int | None = None
    status: Literal["ok", "warning", "exhausted"] = "ok"
    source: Literal["event", "probe", "estimate"] = "event"
    observed_at: datetime


class Budget(BaseModel):
    """Per-task budget, expressed in limit percentages (subscriptions have no $ cost)."""

    max_five_hour_percent: float | None = None  # max share of the 5h window this task may use
    max_weekly_percent: float | None = None
    max_duration_minutes: int | None = None
    max_turns: int | None = None


class BudgetCheck(BaseModel):
    ok: bool
    reason: str | None = None  # Turkish
    resets_at: datetime | None = None


class LimitPolicy(BaseModel):
    """What to do when a provider is exhausted (per flow)."""

    on_exhausted: Literal["switch_provider", "queue", "ask"] = "queue"


class UsageTotals(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    duration_ms: int = 0
    turns: int = 0
    five_hour_percent_spent: float = 0.0
    weekly_percent_spent: float = 0.0
    by_provider: dict[str, dict[str, float]] = Field(default_factory=dict)


class LimitService(Protocol):
    async def record(self, windows: list[LimitWindow]) -> None:
        """Store snapshots; emits limit.updated / limit.warning / limit.exhausted / limit.reset."""
        ...

    async def current(self, provider: Provider | None = None) -> list[LimitWindow]: ...
    async def is_available(self, provider: Provider) -> BudgetCheck: ...
    async def check_budget(self, provider: Provider, budget: Budget, *, task_id: str) -> BudgetCheck: ...
    async def task_usage(self, task_id: str) -> UsageTotals: ...
    async def refresh(self) -> None:
        """Ask adapters for fresh values where that is free (Codex app-server)."""
        ...
