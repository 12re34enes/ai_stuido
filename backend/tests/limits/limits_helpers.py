"""Helpers for limits tests."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal

from aistudio.contracts.agents import (
    AdapterHealth,
    AgentEventPayload,
    AgentEventSink,
    AgentSessionHandle,
    NativeSessionInfo,
    PermissionHandler,
    SessionSpec,
)
from aistudio.contracts.common import Provider
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolHost
from aistudio.contracts.transport import Transport
from aistudio.core.clock import utcnow

LABELS = {"five_hour": "5 saat", "seven_day": "Haftalık", "seven_day_opus": "Haftalık (Opus)"}


def win(
    used: float,
    *,
    provider: Provider = "claude",
    window: str = "five_hour",
    minutes: int | None = None,
    resets_in: timedelta | None = None,
    resets_at: datetime | None = None,
    observed_at: datetime | None = None,
    status: Literal["ok", "warning", "exhausted"] = "ok",
    source: Literal["event", "probe", "estimate"] = "event",
) -> LimitWindow:
    now = observed_at or utcnow()
    return LimitWindow(
        provider=provider,
        window=window,
        label=LABELS.get(window, window),
        used_percent=used,
        window_minutes=minutes,
        resets_at=resets_at if resets_at is not None else (now + resets_in if resets_in is not None else None),
        status=status,
        source=source,
        observed_at=now,
    )


class LimitsAdapter:
    """Adapter that only answers ``read_limits`` (or fails, if ``error`` is set)."""

    def __init__(self, provider: Provider, windows: list[LimitWindow], *, error: Exception | None = None) -> None:
        self.provider: Provider = provider
        self.windows = windows
        self.error = error
        self.calls = 0

    async def health(self, transport: Transport) -> AdapterHealth:
        return AdapterHealth(provider=self.provider, installed=True)

    async def start(
        self,
        spec: SessionSpec,
        *,
        transport: Transport,
        sink: AgentEventSink,
        tools: ToolHost,
        permissions: PermissionHandler,
    ) -> AgentSessionHandle:
        raise NotImplementedError

    async def list_native_sessions(
        self, transport: Transport, *, cwd: str | None = None, limit: int = 200
    ) -> list[NativeSessionInfo]:
        return []

    async def read_native_history(
        self, transport: Transport, native_id: str, *, cwd: str | None = None
    ) -> list[AgentEventPayload]:
        return []

    async def read_limits(self, transport: Transport) -> list[LimitWindow]:
        self.calls += 1
        if self.error is not None:
            raise self.error
        return [w.model_copy(update={"observed_at": utcnow()}) for w in self.windows]
