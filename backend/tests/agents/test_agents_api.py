"""/api/agents endpoints through the full app (every module loaded), with fake adapters."""

from __future__ import annotations

from pathlib import Path

import pytest
from agents_fakes import FakeAdapter, native_info
from fastapi.testclient import TestClient

from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.contracts.agents import AdapterRegistry, Message, SessionStarted
from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]
Api = tuple[TestClient, AppContext, FakeAdapter, FakeAdapter, str, Path]


@pytest.fixture
def api(app_ctx: AppCtx, git_repo: Path) -> Api:
    client, ctx, _ = app_ctx
    registry = ctx.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry, AdapterRegistryImpl)
    claude, codex = FakeAdapter("claude"), FakeAdapter("codex")
    registry.replace(claude)
    registry.replace(codex)
    ws = client.post("/api/workspaces", json={"name": "API Testi"}).json()
    return client, ctx, claude, codex, ws["id"], git_repo


def test_profiles_crud_and_builtin_defaults(
    api: tuple[TestClient, AppContext, FakeAdapter, FakeAdapter, str, Path],
) -> None:
    client, _, _, _, ws_id, _ = api
    profiles = client.get("/api/agents/profiles").json()
    builtin = [p for p in profiles if p["builtin"]]
    assert len(builtin) == 8
    assert {p["name"] for p in builtin} >= {"Claude Yazar", "Codex İnceleyen", "Claude Danışman", "Codex Planlayıcı"}
    advisor = next(p for p in builtin if p["id"] == "prf_claude_advisor")
    assert advisor["role"] == "advisor" and advisor["boundaries"]["sandbox"] == "read_only"

    r = client.post(
        "/api/agents/profiles",
        json={"workspace_id": ws_id, "name": "Hızlı Codex", "provider": "codex", "model": "gpt-x", "role": "writer"},
    )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    assert r.json()["builtin"] is False

    r = client.patch(f"/api/agents/profiles/{pid}", json={"model": None, "instructions": "Kısa yaz."})
    assert r.status_code == 200 and r.json()["model"] is None and r.json()["instructions"] == "Kısa yaz."
    scoped = client.get("/api/agents/profiles", params={"workspace_id": ws_id, "include_global": False}).json()
    assert [p["id"] for p in scoped] == [pid]
    assert client.patch(f"/api/agents/profiles/{pid}", json={"name": "  "}).status_code == 422

    assert client.delete("/api/agents/profiles/prf_claude_writer").status_code == 409
    assert client.delete(f"/api/agents/profiles/{pid}").status_code == 204
    assert client.get(f"/api/agents/profiles/{pid}").status_code == 404
    assert client.patch("/api/agents/profiles/prf_claude_writer", json={"effort": "high"}).json()["effort"] == "high"


def test_session_lifecycle(api: Api) -> None:
    client, _, claude, _, ws_id, repo = api
    body = {
        "workspace_id": ws_id,
        "profile_id": "prf_claude_writer",
        "spec": {"provider": "claude", "cwd": str(repo)},
        "task_id": "task_api",
    }
    r = client.post("/api/agents/sessions", json=body)
    assert r.status_code == 201, r.text
    s = r.json()
    assert s["state"] == "idle" and s["live"] is True and s["label"] == "Claude Yazar" and s["native_id"]
    sid = s["id"]

    assert [x["id"] for x in client.get("/api/agents/sessions", params={"workspace_id": ws_id}).json()] == [sid]
    assert [x["id"] for x in client.get("/api/agents/sessions", params={"active_only": True}).json()] == [sid]
    turn = client.post(f"/api/agents/sessions/{sid}/send", json={"text": "selam"}).json()["turn_id"]
    client.portal.call(claude.last.wait_turn, turn)  # type: ignore[union-attr]
    assert client.post(f"/api/agents/sessions/{sid}/steer", json={"text": "daha kısa"}).status_code == 204
    assert claude.last.steered == ["daha kısa"]
    assert client.post(f"/api/agents/sessions/{sid}/interrupt").status_code == 204
    assert client.post(f"/api/agents/sessions/{sid}/send", json={"text": "  "}).status_code == 422

    got = client.get(f"/api/agents/sessions/{sid}").json()
    assert got["last_usage"]["input_tokens"] == 10 and got["task_id"] == "task_api"
    closed = client.post(f"/api/agents/sessions/{sid}/close").json()
    assert closed["state"] == "done" and closed["live"] is False

    events = client.get("/api/events", params={"session_id": sid, "types": "agent.*"}).json()["events"]
    assert {"agent.session.created", "agent.turn.completed", "agent.session.ended"} <= {e["type"] for e in events}

    assert client.get("/api/agents/sessions/ses_missing").status_code == 404
    bad = client.post("/api/agents/sessions", json={**body, "workspace_id": "ws_missing"})
    assert bad.status_code == 404
    assert client.post("/api/agents/sessions", json={"workspace_id": ws_id}).status_code == 422


def test_health_discover_and_import(api: Api) -> None:
    client, _, claude, codex, ws_id, repo = api
    health = client.get("/api/agents/health").json()
    assert [(h["provider"], h["installed"]) for h in health] == [("claude", True), ("codex", True)]

    claude.native_sessions = [native_info("claude", "n1", cwd=str(repo), title="Terminal oturumu")]
    claude.history["n1"] = [
        SessionStarted(native_id="n1", cwd=str(repo)),
        Message(message_id="m1", role="user", text="merhaba"),
    ]
    codex.native_sessions = [native_info("codex", "n2", cwd="/elsewhere", title="Codex")]
    found = client.get("/api/agents/discover").json()
    assert {f["native_id"] for f in found} == {"n1", "n2"}
    assert all(f["imported_session_id"] is None for f in found)
    only_repo = client.get("/api/agents/discover", params={"cwd": str(repo)}).json()
    assert [f["native_id"] for f in only_repo] == ["n1"]

    r = client.post("/api/agents/import", json={"workspace_id": ws_id, "session": only_repo[0]})
    assert r.status_code == 201, r.text
    imported = r.json()
    assert imported["origin"] == "imported" and imported["live"] is False and imported["title"] == "Terminal oturumu"
    found = client.get("/api/agents/discover", params={"cwd": str(repo)}).json()
    assert found[0]["imported_session_id"] == imported["id"]

    events = client.get("/api/events", params={"session_id": imported["id"]}).json()["events"]
    assert [e["type"] for e in events] == [
        "agent.session.created",
        "agent.session.started",
        "agent.message",
        "agent.session.imported",
    ]
    # Unknown host: the remote module answers 404 (503 only when the remote module is absent).
    assert client.get("/api/agents/discover", params={"host_id": "host_x"}).status_code == 404
