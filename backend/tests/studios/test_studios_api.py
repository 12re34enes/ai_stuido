from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from aistudio.contracts.studios import StudioService
from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]


def test_studios_api(app_ctx: AppCtx, git_repo: Path) -> None:
    client, ctx, _ = app_ctx
    assert ctx.services.has(StudioService)  # type: ignore[type-abstract]

    studios = client.get("/api/studios").json()
    assert [s["id"] for s in studios] == [
        "architecture",
        "market-analysis",
        "design",
        "database",
        "code-review",
        "debugging",
        "documentation",
        "proposal",
    ]
    review = client.get("/api/studios/code-review").json()
    assert review["name"] == "Kod inceleme" and review["version"] == 1

    # Save an edited copy as a new version (POST) and again via PUT.
    review["name"] = "Kod inceleme (sıkı)"
    r = client.post("/api/studios", json={"studio": review, "note": "Daha sıkı"})
    assert r.status_code == 201, r.text
    assert r.json()["version"] == 2 and r.json()["builtin"] is False
    review["description"] = "Güncellendi"
    r = client.put("/api/studios/code-review", json={"studio": review})
    assert r.status_code == 200 and r.json()["version"] == 3
    mismatch = client.put("/api/studios/design", json={"studio": review})
    assert mismatch.status_code == 422

    versions = client.get("/api/studios/code-review/versions").json()
    assert [v["version"] for v in versions] == [3, 2, 1]
    assert client.get("/api/studios/code-review", params={"version": 1}).json()["name"] == "Kod inceleme"
    assert client.get("/api/studios/yok").status_code == 404

    ws = client.post("/api/workspaces", json={"name": "Stüdyo API"}).json()
    repo = client.post(f"/api/workspaces/{ws['id']}/repos", json={"path": str(git_repo)}).json()
    r = client.post(
        "/api/studios/code-review/instantiate",
        json={"workspace_id": ws["id"], "inputs": {"target": "main..feature", "repo": repo["name"]}},
    )
    assert r.status_code == 200, r.text
    graph = r.json()
    assert graph["inputs"]["repo"] == repo["id"] and graph["inputs"]["post_pr_comment"] == "Hayır"
    nodes = {n["id"]: n for n in graph["nodes"]}
    assert nodes["review_claude"]["config"]["repo_ids"] == [repo["id"]]

    missing = client.post("/api/studios/code-review/instantiate", json={"workspace_id": ws["id"], "inputs": {}})
    assert missing.status_code == 422
    assert missing.json()["error"]["details"]["errors"]["target"] == "“İncelenecek değişiklik” alanı zorunlu."

    # Without a deploy module the database studio cannot verify the test environment: fail closed.
    db = client.post(
        "/api/studios/database/instantiate",
        json={
            "workspace_id": ws["id"],
            "inputs": {"change": "x", "repo": repo["id"], "test_deploy_profile": "dp_1"},
        },
    )
    assert db.status_code == 422

    valid = client.post("/api/studios/validate", json={"graph": client.get("/api/studios/debugging").json()["graph"]})
    assert valid.json()["ok"] is True
    broken = client.post(
        "/api/studios/validate",
        json={
            "graph": {
                "nodes": [{"id": "a", "label": "A", "config": {"kind": "agent"}}],
                "edges": [{"id": "e", "source": "a", "target": "b"}],
            }
        },
    )
    body = broken.json()
    assert body["ok"] is False and body["errors"][0]["code"] == "unknown_edge_node"
    assert body["errors"][0]["message"].startswith("Bağlantı bilinmeyen")

    studio_check = client.post("/api/studios/validate-studio", json=client.get("/api/studios/design").json())
    assert studio_check.json() == {"ok": True, "errors": [], "warnings": []}
