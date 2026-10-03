from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from gitops_helpers import commit, git, write

from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]


def _setup(client: TestClient, repo: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    ws = client.post("/api/workspaces", json={"name": "API Alanı"})
    assert ws.status_code == 201, ws.text
    r = client.post(f"/api/workspaces/{ws.json()['id']}/repos", json={"path": str(repo)})
    assert r.status_code == 201, r.text
    return ws.json(), r.json()


def _create(client: TestClient, repo_id: str, **extra: Any) -> dict[str, Any]:
    r = client.post("/api/gitops/worktrees", json={"repo_id": repo_id, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def test_worktree_endpoints(app_ctx: AppCtx, repo_path: Path) -> None:
    client, _, _ = app_ctx
    ws, repo = _setup(client, repo_path)
    wt = _create(client, repo["id"], label="claude", run_id="run_api")
    assert wt["branch"] == "aistudio/manual/claude-1" and wt["workspace_id"] == ws["id"]

    assert [w["id"] for w in client.get("/api/gitops/worktrees", params={"run_id": "run_api"}).json()] == [wt["id"]]
    assert client.get("/api/gitops/worktrees", params={"repo_id": "nope"}).json() == []
    assert client.get("/api/gitops/worktrees", params={"status": ["merged"]}).json() == []
    assert client.get(f"/api/gitops/worktrees/{wt['id']}").json()["path"] == wt["path"]
    missing = client.get("/api/gitops/worktrees/wt_missing")
    assert missing.status_code == 404 and missing.json()["error"]["code"] == "not_found"

    write(wt["path"], "api.txt", "api\n")
    assert client.get(f"/api/gitops/worktrees/{wt['id']}/changed-files").json() == ["api.txt"]
    diff = client.get(f"/api/gitops/worktrees/{wt['id']}/diff").json()
    assert [f["path"] for f in diff["files"]] == ["api.txt"] and diff["files"][0]["patch"]
    no_patch = client.get(f"/api/gitops/worktrees/{wt['id']}/diff", params={"include_patch": False}).json()
    assert no_patch["files"][0]["patch"] is None

    sha = client.post(f"/api/gitops/worktrees/{wt['id']}/commit", json={"message": "API commit"}).json()["sha"]
    assert sha == git(wt["path"], "rev-parse", "HEAD")
    assert client.post(f"/api/gitops/worktrees/{wt['id']}/commit", json={"message": "again"}).json() == {"sha": None}

    preview = client.get(f"/api/gitops/worktrees/{wt['id']}/merge-preview").json()
    assert preview["clean"] and preview["target_ref"] == "main"
    bad = client.post(f"/api/gitops/worktrees/{wt['id']}/merge", json={"strategy": "rebase"})
    assert bad.status_code == 422

    # The user's checkout is on main and clean -> fast-forward there.
    merged = client.post(f"/api/gitops/worktrees/{wt['id']}/merge", json={"strategy": "squash", "message": "API"})
    assert merged.status_code == 200 and merged.json()["merged"]
    assert Path(repo_path, "api.txt").exists()
    assert client.get(f"/api/gitops/worktrees/{wt['id']}").json()["status"] == "merged"

    # A dirty user checkout is refused with a Turkish 409.
    wt2 = _create(client, repo["id"])
    write(wt2["path"], "two.txt", "2\n")
    commit(wt2["path"], "two")
    write(repo_path, "README.md", "user edit\n")
    refused = client.post(f"/api/gitops/worktrees/{wt2['id']}/merge", json={})
    assert refused.status_code == 409 and "commit edilmemiş" in refused.json()["error"]["message"]

    assert client.delete(f"/api/gitops/worktrees/{wt['id']}").status_code == 204
    assert client.get(f"/api/gitops/worktrees/{wt['id']}").json()["status"] == "removed"
    write(wt2["path"], "dirty.txt", "x\n")
    assert client.delete(f"/api/gitops/worktrees/{wt2['id']}").status_code == 409
    assert client.delete(f"/api/gitops/worktrees/{wt2['id']}", params={"force": True}).status_code == 204


def test_push_abandon_cleanup_endpoints(app_ctx: AppCtx, repo_path: Path) -> None:
    client, _, _ = app_ctx
    _, repo = _setup(client, repo_path)
    bare = repo_path.parent / "remote.git"
    git(repo_path.parent, "init", "-q", "--bare", str(bare))
    git(repo_path, "remote", "add", "origin", str(bare))
    wt = _create(client, repo["id"])
    write(wt["path"], "p.txt", "p\n")
    head = commit(wt["path"], "push me")
    r = client.post(f"/api/gitops/worktrees/{wt['id']}/push", json={"remote_branch": "pr/1"})
    assert r.status_code == 204, r.text
    assert git(bare, "rev-parse", "refs/heads/pr/1") == head

    assert client.post(f"/api/gitops/worktrees/{wt['id']}/abandon").json()["status"] == "abandoned"
    report = client.post("/api/gitops/cleanup").json()
    assert report["removed"] == [] and report["errors"] == {}  # still within retention


def test_checkpoint_and_overlap_endpoints(app_ctx: AppCtx, repo_path: Path) -> None:
    client, _, _ = app_ctx
    _, repo = _setup(client, repo_path)
    a = _create(client, repo["id"], label="claude")
    b = _create(client, repo["id"], label="codex")
    write(a["path"], "same.txt", "a\n")
    write(b["path"], "same.txt", "b\n")

    overlaps = client.get("/api/gitops/overlaps").json()
    assert [(o["path"], sorted(o["worktree_ids"])) for o in overlaps] == [("same.txt", sorted([a["id"], b["id"]]))]
    assert client.get("/api/gitops/overlaps", params={"repo_id": "other"}).json() == []
    pair = client.get("/api/gitops/overlaps/check", params={"a": a["id"], "b": b["id"]}).json()
    assert pair["clean"] is False and pair["conflicts"] == ["same.txt"]
    detected = client.get("/api/events", params={"types": "conflict.detected"}).json()["events"]
    assert detected and detected[-1]["severity"] == "high"

    assert client.post("/api/gitops/checkpoints", json={"label": "x", "worktree_ids": []}).status_code == 422
    r = client.post("/api/gitops/checkpoints", json={"label": "önce", "worktree_ids": [a["id"]], "run_id": "run_cp"})
    assert r.status_code == 201, r.text
    cp = r.json()
    assert set(cp["refs"]) == {a["id"]}
    assert [c["id"] for c in client.get("/api/gitops/checkpoints", params={"run_id": "run_cp"}).json()] == [cp["id"]]
    assert client.get(f"/api/gitops/checkpoints/{cp['id']}").json()["label"] == "önce"

    write(a["path"], "after.txt", "later\n")
    restored = client.post(f"/api/gitops/checkpoints/{cp['id']}/restore")
    assert restored.status_code == 200
    assert not Path(a["path"], "after.txt").exists() and Path(a["path"], "same.txt").exists()
    assert client.post("/api/gitops/checkpoints/cp_missing/restore").status_code == 404


def test_branches_endpoint(app_ctx: AppCtx, repo_path: Path) -> None:
    client, _, _ = app_ctx
    _, repo = _setup(client, repo_path)
    git(repo_path, "branch", "feature/x")
    bare = repo_path.parent / "remote.git"
    git(repo_path.parent, "init", "-q", "--bare", str(bare))
    git(repo_path, "remote", "add", "origin", str(bare))
    git(repo_path, "push", "-q", "origin", "main")
    git(repo_path, "remote", "set-head", "origin", "main")
    _create(client, repo["id"])

    data = client.get(f"/api/gitops/repos/{repo['id']}/branches").json()
    assert data["default_branch"] == "main"
    local = {b["name"]: b for b in data["local"]}
    assert set(local) == {"main", "feature/x"}
    assert local["main"]["is_default"] and local["main"]["checked_out"] and not local["feature/x"]["checked_out"]
    assert [(b["name"], b["remote"]) for b in data["remote"]] == [("origin/main", "origin")]  # origin/HEAD skipped

    everything = client.get(f"/api/gitops/repos/{repo['id']}/branches", params={"include_aistudio": True}).json()
    assert "aistudio/manual/agent-1" in {b["name"] for b in everything["local"]}
    assert client.get("/api/gitops/repos/repo_missing/branches").status_code == 404
