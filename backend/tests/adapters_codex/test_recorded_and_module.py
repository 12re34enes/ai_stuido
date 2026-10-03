"""Replays real recorded app-server notifications through a session; module registration."""

from __future__ import annotations

import json
from typing import Any

from fastapi.testclient import TestClient

from aistudio.adapters.codex import CodexAdapter
from aistudio.adapters.codex.session import CodexSession
from aistudio.contracts.agents import (
    AdapterRegistry,
    AgentErrorEv,
    AgentState,
    SessionSpec,
    TurnCompleted,
    TurnStarted,
)
from aistudio.core.context import AppContext

from .conftest import FIXTURES, FakeToolHost, Permissions, RecordingSink


def _recorded(name: str) -> list[dict[str, Any]]:
    path = FIXTURES / "recorded" / name
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


async def test_real_recorded_stream_normalizes() -> None:
    """The unauthenticated lifecycle recorded from codex 0.160.0: turn starts, the stream fails and
    retries, the turn is interrupted. Feed the real notifications through the session."""
    entries = _recorded("lifecycle_unauthenticated.jsonl")
    thread_id = next(
        e["msg"]["result"]["thread"]["id"]
        for e in entries
        if e["dir"] == "recv" and "thread" in e["msg"].get("result", {})
    )
    sink = RecordingSink()
    session = CodexSession(
        spec=SessionSpec(provider="codex", cwd="/Users/dev/project"),
        sink=sink,
        tools=FakeToolHost(),
        permissions=Permissions(),
        tool_names={"memory_read"},
    )
    session.mark_started(thread_id, model="gpt-6.1-sol", cli_version="0.160.0")
    for e in entries:
        msg = e["msg"]
        if e["dir"] == "recv" and "method" in msg and "id" not in msg:
            await session.on_notification(msg["method"], msg.get("params"))
    (started,) = sink.of(TurnStarted)
    (completed,) = sink.of(TurnCompleted)
    assert started.turn_id == completed.turn_id
    assert completed.status == "interrupted" and completed.usage is not None and completed.usage.duration_ms == 815
    (err,) = sink.of(AgentErrorEv)
    assert err.retryable and err.code == "responseStreamDisconnected"
    assert "Reconnecting... 2/5" in err.message
    assert session.state == AgentState.interrupted


def test_module_registers_codex_adapter(app_ctx: tuple[TestClient, AppContext, str]) -> None:
    _client, ctx, _token = app_ctx
    adapter = ctx.services.get(AdapterRegistry).get("codex")  # type: ignore[type-abstract]
    assert isinstance(adapter, CodexAdapter)
    assert adapter.provider == "codex"
