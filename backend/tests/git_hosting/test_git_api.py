from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import respx
from fastapi.testclient import TestClient
from gitfakes import GH_TOKEN, FakeEngine, set_remote

from aistudio.contracts.engine import FlowEngine
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]
API = "https://api.github.com"
REPO = f"{API}/repos/acme/widgets"


@pytest.fixture
def api(app_ctx: AppCtx, git_repo: Path) -> Any:
    client, ctx, _ = app_ctx
    set_remote(git_repo, "https://github.com/acme/widgets.git")
    ws = client.post("/api/workspaces", json={"name": "Ödeme"}).json()
    repo = client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)}).json()
    engine = FakeEngine(clock=utcnow)
    ctx.services.replace(FlowEngine, engine)  # type: ignore[type-abstract]
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{API}/user").respond(200, json={"login": "octo"}, headers={"x-oauth-scopes": "repo"})
        yield client, ctx, repo, engine, mock


def test_accounts_crud(api: Any) -> None:
    client, _, _, _, mock = api
    r = client.post("/api/git/accounts", json={"kind": "github", "token": GH_TOKEN})
    assert r.status_code == 201, r.text
    acc = r.json()
    assert acc["username"] == "octo" and "token" not in acc and GH_TOKEN not in r.text
    assert [a["id"] for a in client.get("/api/git/accounts").json()] == [acc["id"]]
    assert client.post(f"/api/git/accounts/{acc['id']}/verify").json()["scopes"] == ["repo"]
    mock.get(f"{API}/user/repos").respond(
        200,
        json=[
            {
                "full_name": "acme/widgets",
                "name": "widgets",
                "html_url": "https://github.com/acme/widgets",
                "private": True,
                "default_branch": "main",
            }
        ],
    )
    repos = client.get(f"/api/git/accounts/{acc['id']}/repos").json()
    assert repos[0]["full_name"] == "acme/widgets" and repos[0]["private"] is True
    assert client.delete(f"/api/git/accounts/{acc['id']}").status_code == 204
    assert client.get("/api/git/accounts").json() == []


def test_bad_token_is_a_turkish_422(api: Any) -> None:
    client, _, _, _, mock = api
    mock.get(f"{API}/user").respond(401, json={"message": "Bad credentials"})
    r = client.post("/api/git/accounts", json={"kind": "github", "token": GH_TOKEN})
    assert r.status_code == 422
    assert r.json()["error"]["message"] == "Belirteç geçersiz veya süresi dolmuş."


def test_repo_issues_pipelines_and_watch(api: Any) -> None:
    client, _, repo, engine, mock = api
    acc = client.post("/api/git/accounts", json={"kind": "github", "token": GH_TOKEN}).json()
    info = client.get(f"/api/git/repos/{repo['id']}").json()
    assert info["slug"] == "acme/widgets" and info["account_id"] == acc["id"] and info["pinned"] is False
    pinned = client.put(f"/api/git/repos/{repo['id']}/account", json={"account_id": acc["id"]}).json()
    assert pinned["pinned"] is True

    issue = {
        "number": 12,
        "title": "Fatura PDF'i bozuk",
        "body": "Ayrıntılar",
        "html_url": "https://github.com/acme/widgets/issues/12",
        "state": "open",
    }
    mock.get(f"{REPO}/issues").respond(200, json=[issue])
    mock.get(f"{REPO}/issues/12").respond(200, json=issue)
    assert [i["number"] for i in client.get(f"/api/git/repos/{repo['id']}/issues").json()] == [12]
    r = client.post(f"/api/git/repos/{repo['id']}/issues/12/task", json={"mode": "single"})
    assert r.status_code == 201, r.text
    assert r.json()["source"] == "issue" and engine.created[-1].mode == "single"

    mock.post(f"{REPO}/actions/workflows/deploy.yml/dispatches").respond(204)
    mock.get(f"{REPO}/actions/workflows/deploy.yml/runs").respond(
        200, json={"workflow_runs": [{"id": 31, "created_at": utcnow().isoformat()}]}
    )
    mock.get(f"{REPO}/actions/runs/31").respond(200, json={"id": 31, "name": "Deploy", "status": "queued"})
    run = client.post(f"/api/git/repos/{repo['id']}/pipelines", json={"ref": "main", "workflow": "deploy.yml"})
    assert run.status_code == 201 and run.json() == {"run_id": "31"}
    assert client.get(f"/api/git/repos/{repo['id']}/pipelines/31").json()["status"] == "queued"

    mock.get(f"{REPO}/actions/jobs/5/logs").respond(200, text="ok\nE boom")
    assert client.get(f"/api/git/repos/{repo['id']}/jobs/5/log").json() == {"job_id": "5", "log": "ok\nE boom"}

    mock.get(f"{REPO}/pulls/7").respond(
        200,
        json={
            "number": 7,
            "html_url": "https://github.com/acme/widgets/pull/7",
            "title": "T",
            "state": "closed",
            "merged": True,
            "head": {"ref": "f", "sha": "s"},
            "base": {"ref": "main"},
        },
    )
    w = client.post(f"/api/git/repos/{repo['id']}/pulls/7/watch", json={"autofix": True})
    assert w.status_code == 200 and w.json()["number"] == 7
    polled = client.post(f"/api/git/repos/{repo['id']}/pulls/7/watch/poll").json()
    assert polled["status"] == "stopped" and polled["stop_reason"] == "merged"
    assert [x["number"] for x in client.get("/api/git/watches").json()] == [7]
    assert client.delete(f"/api/git/repos/{repo['id']}/pulls/7/watch").status_code == 204
    assert client.get(f"/api/git/repos/{repo['id']}/pulls/99/watch").status_code == 404


def test_pr_comment_reply_tool_is_registered(api: Any) -> None:
    _, ctx, _, _, _ = api
    names = [s.name for s in ctx.services.get(ToolRegistry).all_specs()]  # type: ignore[type-abstract]
    assert "pr_comment_reply" in names
