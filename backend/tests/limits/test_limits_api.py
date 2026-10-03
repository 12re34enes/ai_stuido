"""/api/limits endpoints through the full app."""

from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient
from limits_helpers import LimitsAdapter, win

from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.contracts.agents import AdapterRegistry
from aistudio.contracts.limits import LimitService
from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]


def test_limits_overview_history_task_usage_and_refresh(app_ctx: AppCtx) -> None:
    client, ctx, _ = app_ctx
    empty = client.get("/api/limits").json()
    assert empty["windows"] == []
    assert {p: a["ok"] for p, a in empty["availability"].items()} == {"claude": True, "codex": True}
    assert client.get("/api/settings").json()["limits.refresh_minutes"] == 5

    svc = ctx.services.get(LimitService)  # type: ignore[type-abstract]
    client.portal.call(svc.record, [win(40), win(100, window="seven_day", resets_in=timedelta(days=2))])  # type: ignore[union-attr]
    claude = client.get("/api/limits", params={"provider": "claude"}).json()
    assert [w["window"] for w in claude["windows"]] == ["five_hour", "seven_day"]
    assert list(claude["availability"]) == ["claude"]
    assert claude["availability"]["claude"]["ok"] is False
    assert "Haftalık" in claude["availability"]["claude"]["reason"]

    history = client.get("/api/limits/history", params={"provider": "claude", "window": "five_hour"}).json()
    assert [h["used_percent"] for h in history] == [40]

    usage = client.get("/api/limits/tasks/task_none").json()
    assert usage["turns"] == 0 and usage["five_hour_percent_spent"] == 0 and usage["by_provider"] == {}

    registry = ctx.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry, AdapterRegistryImpl)
    registry.replace(LimitsAdapter("codex", [win(12, provider="codex", window="primary", minutes=300, source="probe")]))
    refreshed = client.post("/api/limits/refresh").json()
    codex = [w for w in refreshed["windows"] if w["provider"] == "codex"]
    assert [(w["window"], w["used_percent"], w["source"]) for w in codex] == [("primary", 12, "probe")]
    assert refreshed["availability"]["codex"]["ok"] is True

    types = {e["type"] for e in client.get("/api/events", params={"types": "limit.*"}).json()["events"]}
    assert {"limit.updated", "limit.exhausted"} <= types
    assert client.get("/api/limits", params={"provider": "other"}).status_code == 422
