"""Team HTTP API (``/api/engine/teams``, ``/api/engine/runs/{id}/team``) inside the real app."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from engine_fakes import FakeAgentManager, FakeLimitService, FakeMemoryService, FakeSession, FakeWorktreeManager
from fastapi.testclient import TestClient
from team_support import member, spec, team_graph

from aistudio.api.app import create_app
from aistudio.approvals.module import ApprovalsModule
from aistudio.bootstrap import build_context
from aistudio.contracts.agents import AgentManager
from aistudio.contracts.gitops import WorktreeManager
from aistudio.contracts.limits import LimitService
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.engine.module import EngineModule
from aistudio.security.masking import Masker
from aistudio.security.secrets import MemorySecretStore
from aistudio.tools.module import ToolsModule
from aistudio.workspaces.module import WorkspacesModule

TOKEN = "test-token-team-api"


class TeamFakes(Module):
    name = "fakes"

    def __init__(self, base: Path) -> None:
        self.worktrees = FakeWorktreeManager(base)
        self.agents = FakeAgentManager(self.worktrees)
        self.memory = FakeMemoryService()
        self.limits = FakeLimitService()
        self.release = {"dev": False}

    async def setup(self, ctx: AppContext) -> None:
        ctx.services.register(AgentManager, self.agents)  # type: ignore[type-abstract]
        ctx.services.register(WorktreeManager, self.worktrees)  # type: ignore[type-abstract]
        ctx.services.register(MemoryService, self.memory)  # type: ignore[type-abstract]
        ctx.services.register(LimitService, self.limits)  # type: ignore[type-abstract]

    async def start(self, ctx: AppContext) -> None:
        self.agents.tool_registry = ctx.services.get(ToolRegistry)  # type: ignore[type-abstract]


@pytest.fixture
def api(tmp_path: Path) -> Iterator[tuple[TestClient, TeamFakes]]:
    from engine_support import make_settings

    masker = Masker()
    ctx = build_context(make_settings(tmp_path / "home"), secrets=MemorySecretStore(masker), masker=masker)
    fakes = TeamFakes(tmp_path / "wt")
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


TEAM_JSON = {
    "members": [
        {"id": "lead", "name": "Lider", "role": "lead", "provider": "claude", "effort": "high"},
        {"id": "dev", "name": "Dev", "role": "worker", "parent_id": "lead", "provider": "codex", "effort": "medium"},
    ]
}


def test_team_templates_api(api: tuple[TestClient, TeamFakes]) -> None:
    client, _ = api
    teams = client.get("/api/engine/teams").json()
    assert [t["id"] for t in teams] == ["danismanli-ekip", "derin-ekip", "arayuz-test-ekibi", "hizli-ekip"]
    assert all(t["builtin"] and t["version"] == 1 for t in teams)
    builtin = client.get("/api/engine/teams/hizli-ekip").json()
    assert builtin["name"] == "Hızlı ekip" and builtin["spec"]["settings"]["test_max_rounds"] == 2
    for t in teams:
        report = client.post("/api/engine/teams/validate", json=t["spec"]).json()
        assert report == {"ok": True, "errors": [], "warnings": []}, t["id"]

    bad = {"members": [*TEAM_JSON["members"], {"id": "lead2", "name": "İkinci lider", "role": "lead"}]}
    report = client.post("/api/engine/teams/validate", json=bad).json()
    assert report["ok"] is False and report["errors"][0]["code"] == "multiple_leads"
    r = client.post("/api/engine/teams", json={"name": "Bozuk", "spec": bad})
    assert r.status_code == 422 and "Ekip geçersiz: Ekipte yalnız bir lider" in r.text
    r = client.post(
        "/api/engine/teams/validate", json={"members": [{"id": "x", "name": "X", "role": "lead", "provider": "gemini"}]}
    )
    assert r.status_code == 422

    r = client.post("/api/engine/teams", json={"name": "Web ekibi", "description": "İki kişi", "spec": TEAM_JSON})
    assert r.status_code == 201, r.text
    team = r.json()
    assert team["version"] == 1 and team["builtin"] is False and team["id"].startswith("team")
    r = client.put(f"/api/engine/teams/{team['id']}", json={"name": "Web ekibi v2"})
    assert r.status_code == 200 and r.json()["version"] == 2
    versions = client.get(f"/api/engine/teams/{team['id']}/versions").json()
    assert [v["version"] for v in versions] == [1, 2]
    assert client.get(f"/api/engine/teams/{team['id']}", params={"version": 1}).json()["name"] == "Web ekibi"
    assert client.get("/api/engine/teams").json()[-1]["name"] == "Web ekibi v2"
    r = client.put("/api/engine/teams/hizli-ekip", json={"name": "x"})
    assert r.status_code == 409 and "değiştirilemez" in r.text
    assert client.delete("/api/engine/teams/hizli-ekip").status_code == 409
    assert client.delete(f"/api/engine/teams/{team['id']}").status_code == 204
    assert client.get(f"/api/engine/teams/{team['id']}").status_code == 404
    assert client.get("/api/engine/teams/yok/versions").status_code == 404

    modes = client.get("/api/engine/modes").json()
    assert {"mode": "team", "label": "Ekip"}.items() <= next(m for m in modes if m["mode"] == "team").items()
    ws = client.post("/api/workspaces", json={"name": "Ekip modu"}).json()
    graph = client.get("/api/engine/modes/team", params={"workspace_id": ws["id"]}).json()
    assert [n["id"] for n in graph["nodes"]] == ["team", "boundary", "build", "review", "final"]
    assert graph["nodes"][0]["config"]["kind"] == "team"


def test_run_team_view_and_member_messages(api: tuple[TestClient, TeamFakes], git_repo: Path) -> None:
    client, fakes = api

    async def lead(s: FakeSession, _m: str) -> str:
        r = await s.call("team_delegate", {"member_id": "dev", "title": "Form", "instructions": "Formu yap"})
        assert not r.is_error, r.content
        await s.call("team_wait", {})
        await s.call("team_finish", {"summary": "Form tamam."})
        return "ok"

    async def dev(s: FakeSession, message: str) -> str:
        if s.turn_index == 0:
            while not fakes.release["dev"]:  # noqa: ASYNC110 - set from the test thread, not this loop
                await asyncio.sleep(0.01)
            fakes.worktrees.touch(s.req.worktree_id or "", "form.py")
            return "Form yapıldı."
        return "Mesaj alındı." if "Kullanıcıdan mesaj" in message else "Teşekkürler."

    fakes.agents.on(lead, label_contains="Lider")  # type: ignore[arg-type]
    fakes.agents.on(dev, label_contains="Dev")  # type: ignore[arg-type]
    ws = client.post("/api/workspaces", json={"name": "Ekip API"}).json()
    client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)})
    team = spec(member("lead", "Lider", "lead"), member("dev", "Dev", "worker", "lead", provider="codex"))
    r = client.post(
        "/api/engine/tasks",
        json={
            "workspace_id": ws["id"],
            "title": "Form",
            "prompt": "Kayıt formu",
            "graph": team_graph(team).model_dump(mode="json"),
        },
    )
    assert r.status_code == 201, r.text
    task_id = r.json()["task"]["id"]
    run_id = poll(lambda: client.get(f"/api/engine/tasks/{task_id}").json()["task"]["current_run_id"])

    def running_view() -> dict[str, Any] | None:
        resp = client.get(f"/api/engine/runs/{run_id}/team")
        if resp.status_code != 200:
            return None
        body = resp.json()
        working = any(m["member_id"] == "dev" and m["status"] == "working" for m in body["members"])
        return body if working and any(a["status"] == "running" for a in body["assignments"]) else None

    live = poll(running_view)
    assert live["active"] is True and live["status"] == "running" and live["node_id"] == "team"
    assert live["team_name"] == "Özel ekip"
    members = {m["member_id"]: m for m in live["members"]}
    assert members["lead"]["status"] == "waiting" and members["dev"]["status"] == "working"
    assert members["dev"]["session_id"] and members["dev"]["worktree_id"]
    assert members["dev"]["current_assignment_id"] == live["assignments"][0]["id"]
    assert members["dev"]["provider"] == "codex" and members["dev"]["parent_id"] == "lead"
    assignment = live["assignments"][0]
    for key in ("id", "run_id", "node_id", "from_member", "to_member", "title", "instructions", "depends_on", "status"):
        assert key in assignment, key
    assert assignment["kind"] == "work" and assignment["from_member"] == "lead"

    steer = client.post(f"/api/engine/runs/{run_id}/team/members/lead/message", json={"text": "Acele", "mode": "steer"})
    assert steer.status_code == 200 and steer.json()["delivered"] == "steer"
    queued = client.post(f"/api/engine/runs/{run_id}/team/members/dev/message", json={"text": "Testleri ekle"})
    assert queued.json()["delivered"] == "queued"
    assert client.post(f"/api/engine/runs/{run_id}/team/members/yok/message", json={"text": "x"}).status_code == 404
    assert client.post(f"/api/engine/runs/{run_id}/team/members/dev/message", json={"text": " "}).status_code == 422
    fakes.release["dev"] = True

    def done() -> dict[str, Any] | None:
        detail = client.get(f"/api/engine/tasks/{task_id}").json()
        return detail if detail["task"]["status"] == "completed" else None

    poll(done)
    final = client.get(f"/api/engine/runs/{run_id}/team").json()
    assert final["active"] is False and final["status"] == "completed" and final["summary"] == "Form tamam."
    assert final["assignments"][0]["result_summary"] == "Mesaj alındı."
    assert client.get(f"/api/engine/runs/{run_id}/team", params={"node_id": "yok"}).status_code == 404
    direct = client.post(f"/api/engine/runs/{run_id}/team/members/dev/message", json={"text": "Sağ ol"})
    assert direct.json()["delivered"] == "direct"
    assert client.get("/api/engine/runs/run_yok/team").status_code == 404
    events = client.get("/api/events", params={"run_id": run_id, "types": "team.*", "limit": 1000}).json()["events"]
    assert {"team.started", "team.assignment.created", "team.finished", "team.message"} <= {e["type"] for e in events}
