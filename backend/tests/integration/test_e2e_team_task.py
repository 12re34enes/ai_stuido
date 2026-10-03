"""End-to-end Ekip (team) task through every real module.

HTTP -> engine (team node) -> gitops worktrees -> agent manager
     -> lead: Claude adapter + fake CLI calling the team Studio tools over MCP
        (team_delegate -> team_wait -> team_finish)
     -> worker: Codex adapter + fake app-server, in its own worktree branched from the lead's branch
     -> studiod commits the worker's change and merges it into the lead's branch (real git)
     -> boundary gate -> build/test gate (``test -f TEAM.md`` passes only if the merge reached the
        lead's worktree) -> cross-review by Codex (the lead is Claude) -> final approval over HTTP.

Fake CLIs are wrapped in ``env VAR=... python fake.py`` because agent processes run with the
scrubbed environment.
"""

from __future__ import annotations

import json
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from aistudio.adapters.claude.adapter import ClaudeAdapter
from aistudio.adapters.codex.adapter import CodexAdapter
from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.contracts.agents import AdapterRegistry
from aistudio.core.context import AppContext

ROOT = Path(__file__).resolve().parents[3]
FAKE_CLAUDE = ROOT / "backend" / "tests" / "adapters_claude" / "fake_claude.py"
FAKE_CODEX = ROOT / "backend" / "tests" / "adapters_codex" / "fake_app_server.py"


def wait_for[T](fn: Callable[[], T | None], timeout: float = 60.0, what: str = "condition") -> T:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


def _assistant(text: str, msg_id: str) -> dict[str, Any]:
    return {
        "op": "emit",
        "msg": {
            "type": "assistant",
            "message": {
                "id": msg_id,
                "type": "message",
                "role": "assistant",
                "model": "claude-sonnet-4-5",
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 10, "output_tokens": 8},
            },
            "parent_tool_use_id": None,
            "session_id": "$SESSION",
            "uuid": f"a-{msg_id}",
        },
    }


def claude_lead_scenario() -> dict[str, Any]:
    lead_turn = [
        {
            "op": "mcp_call",
            "tool": "team_delegate",
            "arguments": {"member_id": "dev", "title": "Ekip notu", "instructions": "Repoya TEAM.md dosyasını ekle."},
            "tool_use_id": "toolu_delegate",
        },
        {"op": "mcp_call", "tool": "team_wait", "arguments": {"timeout_s": 8}, "tool_use_id": "toolu_wait"},
        {
            "op": "mcp_call",
            "tool": "team_finish",
            "arguments": {"summary": "TEAM.md ekip tarafından eklendi."},
            "tool_use_id": "toolu_finish",
        },
        _assistant("Ekip işi tamamladı.", "msg_l1"),
        {"op": "result", "result": "Ekip işi tamamladı."},
    ]
    plain = [_assistant("Tamam.", "msg_l2"), {"op": "result", "result": "Tamam."}]
    return {"model": "claude-sonnet-4-5", "turns": [lead_turn, plain, plain]}


def codex_scenario() -> dict[str, Any]:
    text = 'İş tamam, engelleyici bir sorun yok.\n\n```json\n{"findings": []}\n```'
    turn = [
        {"sleep": 1500},  # the worker "works": the test writes TEAM.md into its worktree meanwhile
        {"item": {"type": "agentMessage", "id": "msg_c1", "text": "", "phase": "final_answer"}, "phase": "started"},
        {"item": {"type": "agentMessage", "id": "msg_c1", "text": text, "phase": "final_answer"}, "phase": "completed"},
    ]
    return {
        "version": "0.160.0",
        "login": "chatgpt",
        "threadId": "thr_team",
        "model": "gpt-5-codex",
        "turnScripts": [turn, turn, turn],
    }


def test_team_task_end_to_end(app_ctx: tuple[TestClient, AppContext, str], git_repo: Path, tmp_path: Path) -> None:
    client, ctx, _ = app_ctx
    lead_file = tmp_path / "claude_lead.json"
    lead_file.write_text(json.dumps(claude_lead_scenario()))
    codex_file = tmp_path / "codex.json"
    codex_file.write_text(json.dumps(codex_scenario()))
    registry = ctx.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry, AdapterRegistryImpl)
    registry.replace(
        ClaudeAdapter(binary=["env", f"FAKE_CLAUDE_SCENARIO={lead_file}", sys.executable, str(FAKE_CLAUDE)])
    )
    registry.replace(
        CodexAdapter(command=["env", f"FAKE_CODEX_SCENARIO={codex_file}", sys.executable, str(FAKE_CODEX)])
    )

    ws = client.post("/api/workspaces", json={"name": "Ekip E2E"}).json()
    repo = client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)}).json()
    client.patch(f"/api/workspaces/repos/{repo['id']}", json={"commands": {"test": "test -f TEAM.md"}})

    team = {
        "members": [
            {"id": "lead", "name": "Lider", "role": "lead", "provider": "claude", "effort": "high"},
            {"id": "dev", "name": "Geliştirici", "role": "worker", "parent_id": "lead", "provider": "codex"},
        ]
    }
    r = client.post(
        "/api/engine/tasks",
        json={"workspace_id": ws["id"], "title": "Ekip notu", "prompt": "TEAM.md ekle.", "mode": "team", "team": team},
    )
    assert r.status_code == 201, r.text
    task_id = r.json()["task"]["id"]

    def detail() -> dict[str, Any]:
        d = client.get(f"/api/engine/tasks/{task_id}").json()
        assert d["task"]["status"] not in ("failed", "cancelled"), json.dumps(d, ensure_ascii=False)[:3000]
        return d

    run_id = wait_for(lambda: detail()["task"]["current_run_id"], what="run")

    def dev_worktree() -> str | None:
        resp = client.get(f"/api/engine/runs/{run_id}/team")
        if resp.status_code != 200:
            return None
        dev = next(m for m in resp.json()["members"] if m["member_id"] == "dev")
        return dev["worktree_id"] if dev["session_id"] and dev["status"] == "working" else None

    wt_id = wait_for(dev_worktree, what="worker worktree")
    wt = client.get(f"/api/gitops/worktrees/{wt_id}").json()
    Path(wt["path"], "TEAM.md").write_text("# Ekip\n\nBu dosyayı ekip ekledi.\n")

    def final_approval() -> dict[str, Any] | None:
        for a in client.get("/api/approvals").json():
            if a["task_id"] == task_id and a["kind"] == "final":
                return a
            assert a["kind"] in ("final", "memory"), f"unexpected approval: {a['kind']} {a['title']}"
        detail()
        return None

    final = wait_for(final_approval, what="final approval")
    assert "TEAM.md ekip tarafından eklendi." in (final["summary"] or "")
    decided = client.post(f"/api/approvals/{final['id']}/decision", json={"approve": True, "note": "tamam"})
    assert decided.status_code == 200, decided.text

    def completed() -> dict[str, Any] | None:
        d = detail()
        return d if d["task"]["status"] == "completed" else None

    done = wait_for(completed, what="completion")
    assert done["quality"] and any(c["key"] == "team" for c in done["quality"]["components"])

    view = client.get(f"/api/engine/runs/{run_id}/team").json()
    assert view["status"] == "completed" and view["summary"] == "TEAM.md ekip tarafından eklendi."
    work = view["assignments"]
    assert len(work) == 1 and work[0]["status"] == "completed" and work[0]["merge"]["status"] == "clean"
    assert work[0]["from_member"] == "lead" and work[0]["to_member"] == "dev"
    members = {m["member_id"]: m for m in view["members"]}
    assert members["lead"]["provider"] == "claude" and members["dev"]["provider"] == "codex"

    gates = {g["kind"]: g["status"] for g in client.get(f"/api/engine/runs/{run_id}/gates").json()}
    assert gates["build_test"] == "passed", gates  # TEAM.md reached the lead's worktree through the merge
    assert gates["cross_review"] == "passed" and gates["user_final"] == "passed", gates

    lead_wt = client.get(f"/api/gitops/worktrees/{members['lead']['worktree_id']}").json()
    assert Path(lead_wt["path"], "TEAM.md").read_text().startswith("# Ekip")
    assert wt["base_ref"] == lead_wt["branch"]  # the worker branched from the lead's branch

    sessions = client.get("/api/agents/sessions", params={"run_id": run_id}).json()
    labels = {s["label"]: s["provider"] for s in sessions}
    assert labels["Lider"] == "claude" and labels["Geliştirici"] == "codex"

    events = client.get("/api/events", params={"run_id": run_id, "limit": 5000}).json()["events"]
    types = [e["type"] for e in events]
    for t in ("team.started", "team.assignment.created", "team.assignment.completed", "team.merge", "team.finished"):
        assert t in types, t
    calls = [e["payload"]["tool"] for e in events if e["type"] == "tool.called"]
    assert calls[:3] == ["team_delegate", "team_wait", "team_finish"], calls
    handoffs = [e["payload"] for e in events if e["type"] == "agent.handoff"]
    assert [h["kind"] for h in handoffs] == ["delegate", "result"]
    assert client.get("/api/events/verify").json()["ok"] is True
