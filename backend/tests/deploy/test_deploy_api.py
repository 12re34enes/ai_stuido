"""/api/deploy routes (all modules loaded)."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]
FINAL = {"succeeded", "failed", "rejected", "cancelled"}


def _wait(client: TestClient, deploy_id: str, statuses: set[str] = FINAL, timeout: float = 10) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    while True:
        run = client.get(f"/api/deploy/runs/{deploy_id}").json()
        if run["status"] in statuses:
            return run
        if time.monotonic() > deadline:
            raise AssertionError(run)
        time.sleep(0.02)


def _profile(client: TestClient, **kw: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "workspace_id": "ws_api",
        "name": "web",
        "kind": "command",
        "environment": "test",
        "config": {"command": "echo hi"},
    }
    body.update(kw)
    r = client.post("/api/deploy/profiles", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_profile_crud_and_validation(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    profile = _profile(client)
    assert client.get(f"/api/deploy/profiles/{profile['id']}").json()["name"] == "web"
    assert [p["id"] for p in client.get("/api/deploy/profiles", params={"workspace_id": "ws_api"}).json()] == [
        profile["id"]
    ]
    bad = client.post(
        "/api/deploy/profiles",
        json={"workspace_id": "ws_api", "name": "x", "kind": "ci", "environment": "test", "config": {}},
    )
    assert bad.status_code == 422 and "repo_id" in bad.json()["error"]["message"]
    ghost = client.post(
        "/api/deploy/profiles",
        json={
            "workspace_id": "ws_api",
            "name": "g",
            "kind": "ssh",
            "environment": "test",
            "config": {"host_ids": ["host_missing"], "script": "x"},
        },
    )
    assert ghost.status_code == 422
    r = client.patch(f"/api/deploy/profiles/{profile['id']}", json={"name": "web-2"})
    assert r.status_code == 200 and r.json()["name"] == "web-2"
    assert client.delete(f"/api/deploy/profiles/{profile['id']}").status_code == 204
    assert client.get(f"/api/deploy/profiles/{profile['id']}").status_code == 404


def test_run_history_and_rollback(app_ctx: AppCtx, tmp_path: Path) -> None:
    client, _, _ = app_ctx
    profile = _profile(client, config={"command": "echo step-one; exit 1"}, rollback={"command": "echo undo-done"})
    r = client.post(f"/api/deploy/profiles/{profile['id']}/run", json={"ref": "main", "summary": "deneme"})
    assert r.status_code == 202 and r.json()["status"] == "running"
    run = _wait(client, r.json()["id"])
    assert run["status"] == "failed" and run["rollback_available"] is True and "step-one" in run["log"]
    rb = client.post(f"/api/deploy/runs/{run['id']}/rollback")
    assert rb.status_code == 202
    rolled = _wait(client, rb.json()["id"])
    assert rolled["status"] == "succeeded" and rolled["rollback_of"] == run["id"] and "undo-done" in rolled["log"]
    history = client.get("/api/deploy/runs", params={"profile_id": profile["id"]}).json()
    assert [h["id"] for h in history] == [rolled["id"], run["id"]]
    assert all(h["log"] == "" for h in history)  # list view omits logs
    assert client.post(f"/api/deploy/runs/{run['id']}/cancel").status_code == 409


def test_production_run_waits_for_approval_and_can_be_cancelled(app_ctx: AppCtx, tmp_path: Path) -> None:
    client, _, _ = app_ctx
    marker = tmp_path / "prod"
    profile = _profile(client, name="prod", environment="production", config={"command": f"touch {marker}"})
    first = client.post(f"/api/deploy/profiles/{profile['id']}/run", json={"ref": "v9"}).json()
    pending_run = _wait(client, first["id"], {"pending_approval"})
    approval = client.get(f"/api/approvals/{pending_run['approval_id']}").json()
    assert approval["kind"] == "deploy" and approval["production"] is True and approval["severity"] == "critical"
    assert client.post(f"/api/deploy/profiles/{profile['id']}/run", json={}).status_code == 409
    cancelled = client.post(f"/api/deploy/runs/{first['id']}/cancel").json()
    assert cancelled["status"] == "cancelled" and not marker.exists()
    assert client.get(f"/api/approvals/{pending_run['approval_id']}").json()["status"] == "cancelled"

    second = client.post(f"/api/deploy/profiles/{profile['id']}/run", json={"ref": "v9"}).json()
    pending = _wait(client, second["id"], {"pending_approval"})
    decided = client.post(f"/api/approvals/{pending['approval_id']}/decision", json={"approve": True})
    assert decided.status_code == 200
    done = _wait(client, second["id"])
    assert done["status"] == "succeeded" and done["approved_by"] == "user" and marker.exists()
    prod_runs = client.get("/api/deploy/runs", params={"environment": "production"}).json()
    assert {r["status"] for r in prod_runs} == {"succeeded", "cancelled"}
