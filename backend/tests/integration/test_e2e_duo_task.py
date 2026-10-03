"""End-to-end İkili (duo) task through every real module.

HTTP -> engine -> gitops worktree -> agent manager -> Claude adapter (fake CLI, writer)
     -> boundary gate -> build/test gate (studiod runs the repo's test command)
     -> cross-review by the OTHER provider (Codex adapter, fake app-server)
     -> user final approval over HTTP -> task completed.

Fake CLIs are wrapped in `env VAR=... python fake.py` because agent processes run with the
scrubbed environment (scenario variables would otherwise be dropped).
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


def wait_for[T](fn: Callable[[], T | None], timeout: float = 45.0, what: str = "condition") -> T:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what}")


def claude_writer_scenario() -> dict[str, Any]:
    turn = [
        {
            "op": "emit",
            "msg": {
                "type": "assistant",
                "message": {
                    "id": "msg_w1",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-sonnet-4-5",
                    "content": [{"type": "text", "text": "Değişikliği yaptım ve kontrol ettim."}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 10, "output_tokens": 8},
                },
                "parent_tool_use_id": None,
                "session_id": "$SESSION",
                "uuid": "a-w1",
            },
        },
        {"op": "result", "result": "Değişikliği yaptım ve kontrol ettim."},
    ]
    return {"model": "claude-sonnet-4-5", "turns": [turn, turn, turn]}


def codex_reviewer_scenario() -> dict[str, Any]:
    text = 'İnceleme tamam, engelleyici bir sorun yok.\n\n```json\n{"findings": []}\n```'
    turn = [
        {"item": {"type": "agentMessage", "id": "msg_r1", "text": "", "phase": "final_answer"}, "phase": "started"},
        {"item": {"type": "agentMessage", "id": "msg_r1", "text": text, "phase": "final_answer"}, "phase": "completed"},
    ]
    return {
        "version": "0.160.0",
        "login": "chatgpt",
        "threadId": "thr_review",
        "model": "gpt-5-codex",
        "turnScripts": [turn, turn, turn],
    }


def test_duo_task_end_to_end(app_ctx: tuple[TestClient, AppContext, str], git_repo: Path, tmp_path: Path) -> None:
    client, ctx, _ = app_ctx
    writer = tmp_path / "claude_writer.json"
    writer.write_text(json.dumps(claude_writer_scenario()))
    reviewer = tmp_path / "codex_reviewer.json"
    reviewer.write_text(json.dumps(codex_reviewer_scenario()))

    registry = ctx.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry, AdapterRegistryImpl)
    registry.replace(ClaudeAdapter(binary=["env", f"FAKE_CLAUDE_SCENARIO={writer}", sys.executable, str(FAKE_CLAUDE)]))
    registry.replace(CodexAdapter(command=["env", f"FAKE_CODEX_SCENARIO={reviewer}", sys.executable, str(FAKE_CODEX)]))

    ws = client.post("/api/workspaces", json={"name": "İkili E2E"}).json()
    repo = client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)}).json()
    client.patch(f"/api/workspaces/repos/{repo['id']}", json={"commands": {"test": "test -f README.md"}})

    r = client.post(
        "/api/engine/tasks",
        json={"workspace_id": ws["id"], "title": "README güncelle", "prompt": "README'yi güncelle.", "mode": "duo"},
    )
    assert r.status_code == 201, r.text
    task_id = r.json()["task"]["id"]

    def final_approval() -> dict[str, Any] | None:
        for a in client.get("/api/approvals").json():
            if a["task_id"] == task_id and a["kind"] == "final":
                return a
            # Session-summary memory proposals are expected and non-blocking; anything else
            # waiting on the user would stall the duo flow, so surface it.
            assert a["kind"] in ("final", "memory"), f"unexpected approval: {a['kind']} {a['title']}"
        detail = client.get(f"/api/engine/tasks/{task_id}").json()
        assert detail["task"]["status"] not in ("failed", "cancelled"), json.dumps(detail, ensure_ascii=False)[:3000]
        return None

    final = wait_for(final_approval, what="final approval")
    decided = client.post(f"/api/approvals/{final['id']}/decision", json={"approve": True, "note": "tamam"})
    assert decided.status_code == 200, decided.text

    def completed() -> dict[str, Any] | None:
        detail = client.get(f"/api/engine/tasks/{task_id}").json()
        assert detail["task"]["status"] not in ("failed", "cancelled"), json.dumps(detail, ensure_ascii=False)[:3000]
        return detail if detail["task"]["status"] == "completed" else None

    detail = wait_for(completed, what="task completion")
    run_id = detail["task"]["current_run_id"]
    assert run_id, detail

    run = client.get(f"/api/engine/runs/{run_id}").json()
    assert run["node_states"] and set(run["node_states"].values()) <= {"passed", "skipped"}, run["node_states"]

    gates = client.get(f"/api/engine/runs/{run_id}/gates").json()
    statuses = {g["kind"]: g["status"] for g in gates}
    assert statuses.get("boundary_check") in ("passed", "skipped"), statuses
    assert statuses.get("build_test") == "passed", statuses
    assert statuses.get("cross_review") == "passed", statuses
    assert statuses.get("user_final") == "passed", statuses

    sessions = client.get("/api/agents/sessions", params={"run_id": run_id}).json()
    providers = {s["provider"] for s in sessions}
    assert providers == {"claude", "codex"}, providers  # reviewer is the other provider

    assert client.get("/api/events/verify").json()["ok"] is True
