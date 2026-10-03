from __future__ import annotations

import time
from typing import Any

from fastapi.testclient import TestClient

from aistudio.contracts.memory import MemoryService
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]


def _wait(fn: Any, timeout: float = 5.0) -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition not met in time")


def test_memory_api_end_to_end(app_ctx: AppCtx) -> None:
    client, ctx, _ = app_ctx
    ws = client.post("/api/workspaces", json={"name": "Hafıza Testi"}).json()
    wid = ws["id"]
    # The workspace.created event initializes the repo in the background.
    root = ctx.settings.paths.memory_dir(ws["slug"])
    _wait(lambda: (root / "facts.md").is_file())

    docs = client.get(f"/api/memory/{wid}/docs").json()
    assert [d["path"] for d in docs] == ["facts.md", "boundaries.md", "decisions/README.md", "sessions/README.md"]
    slim = client.get(f"/api/memory/{wid}/docs", params={"content": "false"}).json()
    assert all(d["content"] == "" for d in slim)

    first_head = client.get(f"/api/memory/{wid}/head").json()["head"]
    r = client.put(
        f"/api/memory/{wid}/docs/facts.md",
        json={"content": "# Proje gerçekleri\n\n## Amaç\nTest.\n", "message": "Amaç eklendi"},
    )
    assert r.status_code == 200, r.text
    written = r.json()
    assert written["doc"]["content"].endswith("Test.\n")
    assert client.get(f"/api/memory/{wid}/head").json()["head"] == written["commit"]

    old = client.get(f"/api/memory/{wid}/docs/facts.md", params={"commit": first_head}).json()
    assert "Test." not in old["content"]

    history = client.get(f"/api/memory/{wid}/history", params={"path": "facts.md"}).json()
    assert [h["message"] for h in history] == ["Amaç eklendi", "Hafıza başlatıldı"]
    assert history[0]["actor"] == "user"

    diff = client.get(f"/api/memory/{wid}/diff", params={"base": first_head}).json()
    assert "+Test." in diff["diff"] and diff["head"] == written["commit"]

    bad = client.put(f"/api/memory/{wid}/docs/../x.md", json={"content": "x"})
    assert bad.status_code in (404, 422)
    not_md = client.put(f"/api/memory/{wid}/docs/notes.txt", json={"content": "x"})
    assert not_md.status_code == 422
    assert not_md.json()["error"]["message"].startswith("Hafıza belgeleri yalnız Markdown")
    assert client.get(f"/api/memory/{wid}/docs/decisions/yok.md").status_code == 404

    restored = client.post(f"/api/memory/{wid}/restore", json={"commit": first_head}).json()
    assert restored["head"] != written["commit"]
    assert "Test." not in client.get(f"/api/memory/{wid}/docs/facts.md").json()["content"]

    assert client.get(f"/api/memory/{wid}/boundaries").json()["sandbox"] == "workspace_write"
    context = client.get(f"/api/memory/{wid}/context", params={"role": "advisor"}).json()
    assert context["text"].startswith("# Ortak hafıza: Hafıza Testi") and context["chars"] <= 8000


def test_memory_proposal_approved_through_approvals_api(app_ctx: AppCtx) -> None:
    client, ctx, _ = app_ctx
    wid = client.post("/api/workspaces", json={"name": "Öneri"}).json()["id"]
    svc = ctx.services.get(MemoryService)  # type: ignore[type-abstract]

    async def propose() -> tuple[str, str | None]:
        p = await svc.propose(
            wid, path="decisions/2026-10-03-api.md", new_content="# REST\n\nREST seçildi.\n", rationale="Kurul"
        )
        return p.id, p.approval_id

    pid, approval_id = client.portal.call(propose)  # type: ignore[union-attr]
    pending = client.get(f"/api/memory/{wid}/proposals", params={"status": "pending"}).json()
    assert [p["id"] for p in pending] == [pid]
    inbox = client.get("/api/approvals", params={"workspace_id": wid}).json()
    assert inbox[0]["kind"] == "memory" and inbox[0]["payload"]["proposal_id"] == pid

    r = client.post(
        f"/api/approvals/{approval_id}/decision",
        json={"approve": True, "decision_payload": {"content": "# REST\n\nREST ve OpenAPI seçildi.\n"}},
    )
    assert r.status_code == 200, r.text
    rec = _wait(lambda: (p := client.get(f"/api/memory/{wid}/proposals/{pid}").json())["status"] == "applied" and p)
    assert rec["edited"] is True and rec["commit_sha"]
    doc = client.get(f"/api/memory/{wid}/docs/decisions/2026-10-03-api.md").json()
    assert doc["content"] == "# REST\n\nREST ve OpenAPI seçildi.\n"

    other = client.post("/api/workspaces", json={"name": "Başka"}).json()["id"]
    assert client.get(f"/api/memory/{other}/proposals/{pid}").status_code == 404


def test_memory_tools_registered(app_ctx: AppCtx) -> None:
    client, ctx, _ = app_ctx
    names = {t["name"] for t in client.get("/api/tools").json()}
    assert {"memory_read", "memory_propose"} <= names
    registry = ctx.services.get(ToolRegistry)  # type: ignore[type-abstract]
    assert registry.get("memory_read").spec.mutating is False
