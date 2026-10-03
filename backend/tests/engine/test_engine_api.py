"""HTTP API of the engine module, running inside the real app with the foundation modules."""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from engine_fakes import FakeAgentManager, FakeLimitService, FakeMemoryService, FakeWorktreeManager
from fastapi.testclient import TestClient

from aistudio.api.app import create_app
from aistudio.approvals.module import ApprovalsModule
from aistudio.bootstrap import build_context
from aistudio.contracts.agents import AgentManager
from aistudio.contracts.gitops import WorktreeManager
from aistudio.contracts.limits import LimitService
from aistudio.contracts.memory import MemoryService
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.engine.module import EngineModule
from aistudio.security.masking import Masker
from aistudio.security.secrets import MemorySecretStore
from aistudio.tools.module import ToolsModule
from aistudio.workspaces.module import WorkspacesModule

TOKEN = "test-token-engine-api"


class FakesModule(Module):
    name = "fakes"

    def __init__(self, base: Path) -> None:
        self.worktrees = FakeWorktreeManager(base)
        self.agents = FakeAgentManager(self.worktrees)
        self.memory = FakeMemoryService()
        self.limits = FakeLimitService()

        def write(session: Any, _m: str) -> str:
            if session.req.worktree_id:
                self.worktrees.touch(session.req.worktree_id, "INSTALL.md")
            return "Kurulum belgesi eklendi."

        self.agents.on(write, node_id="dev")

    async def setup(self, ctx: AppContext) -> None:
        ctx.services.register(AgentManager, self.agents)  # type: ignore[type-abstract]
        ctx.services.register(WorktreeManager, self.worktrees)  # type: ignore[type-abstract]
        ctx.services.register(MemoryService, self.memory)  # type: ignore[type-abstract]
        ctx.services.register(LimitService, self.limits)  # type: ignore[type-abstract]


@pytest.fixture
def api(tmp_path: Path) -> Iterator[tuple[TestClient, FakesModule]]:
    from engine_support import make_settings

    masker = Masker()
    ctx = build_context(make_settings(tmp_path / "home"), secrets=MemorySecretStore(masker), masker=masker)
    fakes = FakesModule(tmp_path / "wt")
    mods: list[Module] = [WorkspacesModule(), ApprovalsModule(), ToolsModule(), fakes, EngineModule()]
    app = create_app(ctx, TOKEN, mods)
    with TestClient(app, headers={"Authorization": f"Bearer {TOKEN}"}) as client:
        yield client, fakes


def poll(fn: Callable[[], Any], timeout: float = 10.0) -> Any:
    deadline = time.monotonic() + timeout
    while True:
        value = fn()
        if value:
            return value
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        time.sleep(0.02)


def test_engine_api_end_to_end(api: tuple[TestClient, FakesModule], git_repo: Path) -> None:
    client, _fakes = api
    ws = client.post("/api/workspaces", json={"name": "API Alanı"}).json()
    repo = client.post(
        f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo), "commands": {"test": "pytest -q"}}
    ).json()
    assert repo["commands"]["test"] == "pytest -q"

    modes = client.get("/api/engine/modes").json()
    assert [m["label"] for m in modes] == ["Tek", "İkili", "Yarış", "Hat", "Kurul", "Ekip", "Özel"]
    duo = client.get(f"/api/engine/modes/duo?workspace_id={ws['id']}").json()
    assert [nd["id"] for nd in duo["nodes"]] == ["dev", "boundary", "build", "review", "final"]
    assert client.get("/api/engine/modes/duo").status_code == 422

    secret = "password=" + "hunter2" + "secret"
    r = client.post(
        "/api/engine/tasks",
        json={
            "workspace_id": ws["id"],
            "title": "Kurulum <belgesi>",
            "prompt": f"INSTALL.md yaz <script>alert(1)</script> {secret}",
            "mode": "single",
        },
    )
    assert r.status_code == 201, r.text
    detail = r.json()
    task_id = detail["task"]["id"]
    assert detail["task"]["status"] in ("running", "waiting")
    run_id = detail["task"]["current_run_id"]
    assert run_id

    approval = poll(lambda: [a for a in client.get("/api/approvals").json() if a["kind"] == "final"])[0]
    assert client.get(f"/api/engine/tasks/{task_id}").json()["task"]["status"] == "waiting"
    r = client.post(f"/api/approvals/{approval['id']}/decision", json={"approve": True})
    assert r.status_code == 200
    poll(lambda: client.get(f"/api/engine/tasks/{task_id}").json()["task"]["status"] == "completed")

    run = client.get(f"/api/engine/runs/{run_id}").json()
    assert {nd["node_id"] for nd in run["nodes"]} == {"dev", "boundary", "build", "final"}
    gates = client.get(f"/api/engine/runs/{run_id}/gates").json()
    assert {g["kind"] for g in gates} == {"boundary_check", "build_test", "user_final"}
    evidence = client.get(f"/api/engine/runs/{run_id}/evidence").json()
    assert evidence[0]["kind"] == "command" and "kapı kanıtı" in evidence[0]["label"]
    checkpoints = client.get(f"/api/engine/runs/{run_id}/checkpoints").json()
    assert len(checkpoints) == 4
    timeline = client.get(f"/api/engine/runs/{run_id}/timeline").json()
    types = [ev["type"] for ev in timeline["events"]]
    assert types[0] == "run.started" and "run.completed" in types and "approval.decided" in types
    assert timeline["session_ids"]
    ids = [ev["id"] for ev in timeline["events"]]
    assert ids == sorted(ids)
    page = client.get(f"/api/engine/runs/{run_id}/timeline?limit=3").json()
    assert len(page["events"]) == 3 and page["has_more"] is True

    md = client.get(f"/api/engine/tasks/{task_id}/export?format=md")
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/markdown")
    assert md.text.startswith("# Kurulum <belgesi>")
    assert "## Kalite puanı" in md.text and "### Kapılar ve kanıtlar" in md.text
    assert "hunter2secret" not in md.text and "[gizli]" in md.text
    assert "attachment" in md.headers["content-disposition"]
    html = client.get(f"/api/engine/runs/{run_id}/export?format=html")
    assert html.headers["content-type"].startswith("text/html")
    assert html.text.startswith("<!doctype html>")
    assert "<script>alert" not in html.text and "&lt;script&gt;" in html.text
    assert "http://" not in html.text and "https://" not in html.text  # self-contained
    assert "prefers-color-scheme: dark" in html.text
    exported = json.loads(client.get(f"/api/engine/tasks/{task_id}/export?format=json").text)
    assert exported["format"] == "aistudio.export.v1"
    assert exported["runs"][0]["id"] == run_id and exported["runs"][0]["gates"]

    quality = client.get(f"/api/engine/tasks/{task_id}/quality").json()
    assert quality["score"] is not None and quality["formula"]
    rated = client.post(f"/api/engine/tasks/{task_id}/rating", json={"rating": 4, "note": "iyi"}).json()
    rating = next(c for c in rated["components"] if c["key"] == "user_rating")
    assert rating["value"] == 0.75
    assert client.post(f"/api/engine/tasks/{task_id}/rating", json={"rating": 9}).status_code == 422
    assert client.get(f"/api/engine/tasks/{task_id}").json()["rating"] == 4

    stats = client.get(f"/api/engine/stats/agents?workspace_id={ws['id']}&days=7").json()
    claude = next(s for s in stats["stats"] if s["provider"] == "claude")
    assert claude["node_runs"] == 1 and claude["success_rate"] == 1.0
    assert claude["gate_checks"] >= 2 and claude["gate_first_pass_rate"] == 1.0
    assert claude["avg_quality"] is not None

    listed = client.get(f"/api/engine/tasks?workspace_id={ws['id']}&status=completed").json()
    assert [t["id"] for t in listed] == [task_id]
    assert client.get("/api/engine/tasks?q=INSTALL").json()[0]["id"] == task_id

    retry = client.post(f"/api/engine/runs/{run_id}/nodes/dev/retry")
    assert retry.status_code == 409
    assert retry.json()["error"]["message"] == "Tamamlanmış bir koşuda düğüm yeniden denenemez."


def test_task_lifecycle_flows_and_schedules(api: tuple[TestClient, FakesModule], git_repo: Path) -> None:
    client, _ = api
    ws = client.post("/api/workspaces", json={"name": "Akışlar"}).json()
    client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)})

    # draft -> edit -> start now -> cancel -> delete
    draft = client.post(
        "/api/engine/tasks",
        json={"workspace_id": ws["id"], "title": "Taslak", "prompt": "Bir şey yap", "mode": "single", "start": False},
    ).json()["task"]
    assert draft["status"] == "draft"
    edited = client.patch(f"/api/engine/tasks/{draft['id']}", json={"title": "Yeni başlık", "priority": 3}).json()
    assert edited["title"] == "Yeni başlık" and edited["priority"] == 3
    started = client.post(f"/api/engine/tasks/{draft['id']}/start", json={"now": True}).json()
    assert started["task"]["status"] in ("running", "waiting")
    assert client.patch(f"/api/engine/tasks/{draft['id']}", json={"title": "x"}).status_code == 409
    assert client.delete(f"/api/engine/tasks/{draft['id']}").status_code == 409
    cancelled = client.post(f"/api/engine/tasks/{draft['id']}/cancel").json()
    assert cancelled["status"] == "cancelled"
    assert client.get("/api/approvals").json() == []
    assert client.delete(f"/api/engine/tasks/{draft['id']}").status_code == 204
    missing = client.get(f"/api/engine/tasks/{draft['id']}")
    assert missing.status_code == 404 and missing.json()["error"]["message"] == "Görev bulunamadı."

    bad = client.post(
        "/api/engine/tasks", json={"workspace_id": ws["id"], "title": "x", "prompt": "y", "mode": "custom"}
    )
    assert bad.status_code == 422 and "Özel mod" in bad.json()["error"]["message"]

    # flows: validate, create, version, read old version, delete
    invalid = {
        "nodes": [
            {"id": "a", "label": "A", "config": {"kind": "agent"}},
            {"id": "b", "label": "B", "config": {"kind": "agent"}},
        ]
    }
    report = client.post("/api/engine/flows/validate", json=invalid).json()
    assert report["ok"] is False and report["errors"][0]["code"] == "multiple_entries"
    single = client.get(f"/api/engine/modes/single?workspace_id={ws['id']}").json()
    created = client.post("/api/engine/flows", json={"workspace_id": ws["id"], "name": "Hızlı akış", "graph": single})
    assert created.status_code == 201
    flow = created.json()
    assert flow["version"] == 1
    single["settings"]["max_parallel_agents"] = 2
    v2 = client.put(f"/api/engine/flows/{flow['id']}", json={"graph": single, "description": "iki ajan"}).json()
    assert v2["version"] == 2 and v2["graph"]["settings"]["max_parallel_agents"] == 2
    versions = client.get(f"/api/engine/flows/{flow['id']}/versions").json()
    assert [v["version"] for v in versions] == [1, 2]
    old = client.get(f"/api/engine/flows/{flow['id']}/versions/1").json()
    assert old["graph"]["settings"]["max_parallel_agents"] == 4
    assert [f["id"] for f in client.get(f"/api/engine/flows?workspace_id={ws['id']}").json()] == [flow["id"]]

    # a task can run a saved flow
    from_flow = client.post(
        "/api/engine/tasks",
        json={"workspace_id": ws["id"], "title": "Akıştan", "prompt": "y", "mode": "custom", "flow_id": flow["id"]},
    )
    assert from_flow.status_code == 201
    run_id = from_flow.json()["task"]["current_run_id"]
    assert client.get(f"/api/engine/runs/{run_id}").json()["graph"]["settings"]["max_parallel_agents"] == 2
    client.post(f"/api/engine/runs/{run_id}/cancel")
    assert client.delete(f"/api/engine/flows/{flow['id']}").status_code == 204
    assert client.get(f"/api/engine/flows/{flow['id']}").json()["error"]["message"] == "Akış bulunamadı."

    # schedules
    sched = client.post(
        "/api/engine/schedules",
        json={
            "workspace_id": ws["id"],
            "name": "Gece",
            "cron": "0 3 * * *",
            "template": {"title": "Gece işi", "prompt": "Bağımlılıkları güncelle", "mode": "single"},
        },
    )
    assert sched.status_code == 201
    sid = sched.json()["id"]
    assert sched.json()["next_run_at"]
    assert client.patch(f"/api/engine/schedules/{sid}", json={"enabled": False}).json()["next_run_at"] is None
    assert [s["id"] for s in client.get(f"/api/engine/schedules?workspace_id={ws['id']}").json()] == [sid]
    fired = client.post(f"/api/engine/schedules/{sid}/run").json()
    assert fired["source"] == "schedule" and fired["source_ref"]["schedule_id"] == sid
    assert client.get(f"/api/engine/schedules/{sid}").json()["last_task_id"] == fired["id"]
    assert client.post("/api/engine/schedules", json={**sched.json(), "cron": "nope"}).status_code == 422
    assert client.delete(f"/api/engine/schedules/{sid}").status_code == 204
    assert client.get("/api/engine/queue").status_code == 200
