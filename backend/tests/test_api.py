from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel, field_validator

from aistudio.contracts.approvals import ApprovalKind, ApprovalRequest, ApprovalService
from aistudio.core.context import AppContext
from aistudio.core.errors import PermissionDenied

AppCtx = tuple[TestClient, AppContext, str]


def test_health_is_public(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    r = client.get("/health", headers={"Authorization": ""})
    assert r.status_code == 200 and r.json()["ok"] is True


def test_api_requires_token(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    assert client.get("/api/system", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/system").status_code == 200


def test_foreign_origin_rejected(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    assert client.get("/api/system", headers={"Origin": "https://evil.example"}).status_code == 403
    ok = client.get("/api/system", headers={"Origin": "tauri://localhost"})
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-origin"] == "tauri://localhost"


def test_all_modules_load(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    mods = client.get("/api/system").json()["modules"]
    assert {"workspaces", "approvals", "tools", "agents", "engine"} <= set(mods)


def test_workspace_crud_and_turkish_slug(app_ctx: AppCtx, git_repo: Path) -> None:
    client, _, _ = app_ctx
    r = client.post("/api/workspaces", json={"name": "Şirket Çalışması"})
    assert r.status_code == 201, r.text
    ws = r.json()
    assert ws["slug"] == "sirket-calismasi"
    dup = client.post("/api/workspaces", json={"name": "Şirket Çalışması"}).json()
    assert dup["slug"] == "sirket-calismasi-2"

    r = client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)})
    assert r.status_code == 201, r.text
    repo = r.json()
    assert repo["default_branch"] == "main" and repo["name"] == "repo"
    again = client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)})
    assert again.status_code == 409
    assert again.json()["error"]["message"] == "Bu repo zaten çalışma alanında."

    not_git = client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo.parent)})
    assert not_git.status_code == 422

    r = client.patch(f"/api/workspaces/repos/{repo['id']}", json={"commands": {"test": "pytest -q"}})
    assert r.json()["commands"]["test"] == "pytest -q"


def test_approval_flow_and_production_channel_rule(app_ctx: AppCtx) -> None:
    client, ctx, _ = app_ctx
    svc = ctx.services.get(ApprovalService)  # type: ignore[type-abstract]

    async def make(production: bool) -> str:
        a = await svc.request(
            ApprovalRequest(kind=ApprovalKind.remote_command, title="rm -rf /tmp/x", production=production)
        )
        return a.id

    prod_id = client.portal.call(make, True)  # type: ignore[union-attr]
    pending = client.get("/api/approvals").json()
    assert [a["id"] for a in pending] == [prod_id]

    async def decide_from_telegram() -> None:
        await svc.decide(prod_id, approve=True, channel="telegram", decided_by="channel:telegram")

    with pytest.raises(PermissionDenied):
        client.portal.call(decide_from_telegram)  # type: ignore[union-attr]

    r = client.post(f"/api/approvals/{prod_id}/decision", json={"approve": True, "note": "tamam"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    r = client.post(f"/api/approvals/{prod_id}/decision", json={"approve": False})
    assert r.status_code == 409


def test_approval_wait_unblocks_on_decision(app_ctx: AppCtx) -> None:
    client, ctx, _ = app_ctx
    svc = ctx.services.get(ApprovalService)  # type: ignore[type-abstract]

    async def scenario() -> str:
        a = await svc.request(ApprovalRequest(kind=ApprovalKind.plan, title="Planı onayla"))
        waiter = asyncio.create_task(svc.wait(a.id, timeout=5))
        await asyncio.sleep(0.05)
        await svc.decide(a.id, approve=False, note="eksik")
        done = await waiter
        return done.status.value

    assert client.portal.call(scenario) == "rejected"  # type: ignore[union-attr]


def test_websocket_replays_backlog_then_streams(app_ctx: AppCtx) -> None:
    client, ctx, token = app_ctx

    async def emit(t: str) -> int:
        return (await ctx.events.append(t, {"x": 1}, workspace_id="ws_x")).id

    first = client.portal.call(emit, "a.one")  # type: ignore[union-attr]
    client.portal.call(emit, "a.two")  # type: ignore[union-attr]
    with client.websocket_connect(f"/ws/events?token={token}&after={first - 1}&workspace_id=ws_x") as ws:
        msgs = [json.loads(ws.receive_text()) for _ in range(3)]
        assert [m["kind"] for m in msgs] == ["event", "event", "ready"]
        assert [m["event"]["type"] for m in msgs[:2]] == ["a.one", "a.two"]
        client.portal.call(emit, "a.three")  # type: ignore[union-attr]
        live = json.loads(ws.receive_text())
        assert live["event"]["type"] == "a.three"


def test_websocket_rejects_bad_token(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    from starlette.websockets import WebSocketDisconnect

    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect("/ws/events?token=nope", headers={"Authorization": "Bearer nope"}) as ws,
    ):
        ws.receive_text()


def test_settings_roundtrip(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    assert client.get("/api/settings").json()["safety.remote_production_approvals"] is False
    client.put("/api/settings/appearance.theme", json={"value": "dark"})
    assert client.get("/api/settings").json()["appearance.theme"] == "dark"


class _HourBody(BaseModel):
    hour: int

    @field_validator("hour")
    @classmethod
    def _check(cls, v: int) -> int:
        if not 0 <= v < 24:
            raise ValueError("saat 0-23 olmalı")
        return v


def test_validator_value_error_returns_422(app_ctx: AppCtx) -> None:
    """A model validator raising ValueError must produce a 422, not a 500."""
    client, _, _ = app_ctx
    app = client.app
    assert isinstance(app, FastAPI)

    async def endpoint(body: _HourBody) -> dict[str, int]:
        return {"hour": body.hour}

    app.add_api_route("/api/__test_validation", endpoint, methods=["POST"])
    r = client.post("/api/__test_validation", json={"hour": 99})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "validation_failed"
    assert "saat 0-23" in str(err["details"])
