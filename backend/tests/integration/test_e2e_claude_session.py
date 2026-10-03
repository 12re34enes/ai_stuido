"""End-to-end: API -> AgentManager -> policy -> ClaudeAdapter -> LocalTransport -> fake Claude CLI.

Exercises the real module wiring of a full app: a session started over HTTP streams normalized
events into the event log, an unsafe command goes to the approval inbox and is approved over
HTTP, an in-worktree edit is auto-allowed, and rate limits land in the limits module.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from aistudio.adapters.claude.adapter import ClaudeAdapter
from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.contracts.agents import AdapterRegistry
from aistudio.core.context import AppContext

ROOT = Path(__file__).resolve().parents[3]
FAKE_CLAUDE = ROOT / "backend" / "tests" / "adapters_claude" / "fake_claude.py"
SCENARIO = ROOT / "fixtures" / "claude" / "scenario_full_turn.json"


def wait_for[T](fn: Callable[[], T | None], timeout: float = 20.0, what: str = "condition") -> T:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for {what}")


def events(client: TestClient, **params: Any) -> list[dict[str, Any]]:
    return client.get("/api/events", params={"limit": 5000, **params}).json()["events"]


def test_claude_session_end_to_end(app_ctx: tuple[TestClient, AppContext, str], git_repo: Path) -> None:
    client, ctx, _ = app_ctx
    registry = ctx.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry, AdapterRegistryImpl)
    registry.replace(ClaudeAdapter(binary=[sys.executable, str(FAKE_CLAUDE)]))

    ws = client.post("/api/workspaces", json={"name": "E2E"}).json()
    client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)})

    r = client.post(
        "/api/agents/sessions",
        json={
            "workspace_id": ws["id"],
            "spec": {
                "provider": "claude",
                "cwd": str(git_repo),
                "env": {"FAKE_CLAUDE_SCENARIO": str(SCENARIO)},
            },
            "label": "e2e",
            "initial_prompt": "Testleri çalıştır ve app.ts'i güncelle.",
        },
    )
    assert r.status_code == 201, r.text
    session_id = r.json()["id"]

    # `npm test` is not on the safe list -> it must reach the approval inbox.
    def pending_permission() -> dict[str, Any] | None:
        for a in client.get("/api/approvals").json():
            if a["kind"] == "tool_permission" and a["session_id"] == session_id:
                return a
        return None

    approval = wait_for(pending_permission, what="tool permission approval")
    assert "npm test" in (approval["title"] + str(approval["payload"]))
    decided = client.post(f"/api/approvals/{approval['id']}/decision", json={"approve": True})
    assert decided.status_code == 200, decided.text

    def turn_completed() -> dict[str, Any] | None:
        for ev in events(client, session_id=session_id, types="agent.turn.completed"):
            return ev
        return None

    done = wait_for(turn_completed, what="turn completion")
    assert done["payload"]["status"] == "success"
    assert "testler geçti" in (done["payload"].get("result_text") or "")

    evs = events(client, session_id=session_id)
    types = [e["type"] for e in evs]
    for expected in (
        "agent.session.started",
        "agent.tool.call",
        "agent.tool.result",
        "agent.permission.request",
        "agent.permission.decided",
        "agent.file.changed",
        "agent.usage",
    ):
        assert expected in types, f"missing {expected}: {sorted(set(types))}"
    assert all(not e["type"].endswith(".delta") for e in evs), "deltas must not be persisted"
    assert all(e["actor"].startswith(("agent:", "user", "system")) for e in evs)

    decisions = [e["payload"] for e in evs if e["type"] == "agent.permission.decided"]
    via_inbox = [d for d in decisions if d.get("approval_id") == approval["id"]]
    assert via_inbox and via_inbox[0]["allow"] is True
    assert via_inbox[0]["decided_by"].startswith("user")
    # The in-worktree edit is auto-allowed by policy (no second approval).
    assert any(d["allow"] and d.get("approval_id") is None for d in decisions)

    limits = client.get("/api/limits", params={"provider": "claude"}).json()
    five_hour = [w for w in limits["windows"] if w["window"] == "five_hour"]
    assert five_hour and round(five_hour[0]["used_percent"]) == 82  # fixture: utilization 0.82

    session = client.get(f"/api/agents/sessions/{session_id}").json()
    assert session["native_id"]
    assert session["state"] in ("idle", "done")

    closed = client.post(f"/api/agents/sessions/{session_id}/close")
    assert closed.status_code == 200
    ok = client.get("/api/events/verify").json()
    assert ok["ok"] is True
