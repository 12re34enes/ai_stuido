from __future__ import annotations

import time
from pathlib import Path

from fastapi.testclient import TestClient

from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]


def test_backup_api_create_list_restore(app_ctx: AppCtx, tmp_path: Path) -> None:
    client, ctx, _ = app_ctx
    ws = client.post("/api/workspaces", json={"name": "API Yedek"}).json()
    memory_root = ctx.settings.paths.memory_dir(ws["slug"])
    deadline = time.monotonic() + 5
    while not (memory_root / "facts.md").exists():  # initialized by the workspace.created listener
        assert time.monotonic() < deadline
        time.sleep(0.02)

    settings = client.get("/api/backup/settings").json()
    assert settings["interval_hours"] == 24 and settings["keep"] == 14
    target = tmp_path / "yedekler"
    r = client.put("/api/backup/settings", json={"dir": str(target), "keep": 3})
    assert r.status_code == 200 and r.json()["resolved_dir"] == str(target)
    bad = client.put("/api/backup/settings", json={"keep": 0})
    assert bad.status_code == 422

    r = client.post("/api/backup")
    assert r.status_code == 201, r.text
    backup = r.json()
    assert backup["workspaces"] == [ws["slug"]]
    assert Path(backup["path"]).parent == target

    listed = client.get("/api/backup").json()
    assert [b["name"] for b in listed] == [backup["name"]]
    manifest = client.get(f"/api/backup/{backup['name']}").json()
    assert {f["kind"] for f in manifest["files"]} == {"database", "memory"}
    assert client.get("/api/backup/aistudio-yok").status_code == 404

    client.post("/api/workspaces", json={"name": "Sonra Eklenen"})
    r = client.post(f"/api/backup/{backup['name']}/restore", json={"safety_backup": False})
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["restart_required"] is True and result["safety_backup"] is None
    assert [w["name"] for w in client.get("/api/workspaces").json()] == ["API Yedek"]
    assert client.get("/api/events/verify").json()["ok"] is True
