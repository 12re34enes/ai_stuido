#!/usr/bin/env python3
"""AI Studio demo: the real studiod with fake Claude/Codex CLIs and seeded sample data.

Lets you explore the whole UI without installed or logged-in CLIs (and without spending quota):

    make demo            # studiod demo on :8765 + web UI on http://localhost:1420

Everything lives in .aistudio-demo/ (wiped on each start). Agents are the scripted fake CLIs from
the backend test suite, so their "work" is canned; every other module (engine, gates, gitops,
memory, approvals, limits, remote, deploy, alerts) is real.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import demo_team  # sibling module: scripts/dev is sys.path[0] when run as a script
import httpx
import uvicorn

ROOT = Path(__file__).resolve().parents[2]
HOME = ROOT / ".aistudio-demo"
PORT = int(os.environ.get("AISTUDIO_PORT", "8765"))
WEB_PORT = int(os.environ.get("AISTUDIO_WEB_PORT", "1420"))
TOKEN = "dev-token"
FAKE_CLAUDE = ROOT / "backend" / "tests" / "adapters_claude" / "fake_claude.py"
FAKE_CODEX = ROOT / "backend" / "tests" / "adapters_codex" / "fake_app_server.py"
CLAUDE_FIXTURE = ROOT / "fixtures" / "claude" / "scenario_full_turn.json"

PLAN = {
    "summary": "Limit çubuklarını üst çubuğa ekle; Claude ve Codex için 5 saatlik ve haftalık pencere.",
    "steps": [
        {
            "title": "LimitBar bileşeni",
            "detail": "Yay animasyonlu dolum, %70/%90 renk eşikleri.",
            "files": ["src/ui/LimitBar.tsx"],
        },
        {"title": "Üst çubuğa bağla", "detail": "/api/limits + limit.* olayları.", "files": ["src/shell/TopBar.tsx"]},
        {"title": "Testler", "detail": "Eşik ve sıfırlanma geri sayımı testleri.", "files": ["src/ui/limits.test.ts"]},
    ],
    "risks": ["Boştayken Claude limitleri yalnız son bilinen değerle gösterilir."],
}


def claude_scenario() -> dict[str, Any]:
    """Rich first turn (thinking, tool calls, permission, edit, rate limit) from the fixture, then
    turns whose answer carries a plan JSON so planners, writers and testers all get a sane reply."""
    base = json.loads(CLAUDE_FIXTURE.read_text())
    text = (
        "Değişikliği yaptım: LimitBar bileşeni eklendi ve üst çubuğa bağlandı. Testler geçti.\n\n"
        f"```json\n{json.dumps(PLAN, ensure_ascii=False)}\n```"
    )
    turn = [
        {
            "op": "emit",
            "msg": {
                "type": "assistant",
                "message": {
                    "id": "msg_demo",
                    "type": "message",
                    "role": "assistant",
                    "model": "claude-opus-5-5",
                    "content": [{"type": "text", "text": text}],
                    "stop_reason": "end_turn",
                    "usage": {"input_tokens": 1800, "output_tokens": 420},
                },
                "parent_tool_use_id": None,
                "session_id": "$SESSION",
                "uuid": "a-demo",
            },
        },
        {"op": "result", "result": text},
    ]
    base["model"] = "claude-opus-5-5"
    # Rich fixture turn first (tool calls, permission, edit, Claude rate limits), then plan-carrying turns.
    base["turns"] = [*base["turns"], turn, turn, turn, turn, turn]
    # Team members and the subagent demo session pick their own script by system prompt.
    base["by_system_prompt"] = {**demo_team.claude_team_overrides(), **demo_team.claude_subagent_override()}
    return base


def codex_scenario() -> dict[str, Any]:
    now = int(time.time())
    text = (
        "İnceleme tamam. Eşik mantığı doğru, testler kapsamlı; engelleyici bulgu yok.\n\n"
        '```json\n{"verdict": "pass", "summary": "Engelleyici sorun yok.", "findings": '
        '[{"severity": "low", "file": "src/ui/LimitBar.tsx", "line": 42, '
        '"message": "Renk eşikleri sabit yerine token olabilir."}]}\n```'
    )
    turn = [
        {"item": {"type": "agentMessage", "id": "msg_r", "text": "", "phase": "final_answer"}, "phase": "started"},
        {"item": {"type": "agentMessage", "id": "msg_r", "text": text, "phase": "final_answer"}, "phase": "completed"},
    ]
    window = {"limitId": "codex", "limitName": None, "credits": None, "planType": "plus", "rateLimitReachedType": None}
    limits = {
        **window,
        "primary": {"usedPercent": 18, "windowDurationMins": 300, "resetsAt": now + 3 * 3600 + 1260},
        "secondary": {"usedPercent": 64, "windowDurationMins": 10080, "resetsAt": now + 2 * 86400 + 4 * 3600},
    }
    return {
        "version": "0.160.0",
        "login": "chatgpt",
        "threadId": "thr_demo",
        "model": "gpt-5.5-codex",
        "rateLimits": {"rateLimits": limits, "rateLimitsByLimitId": {"codex": limits}},
        "turnScripts": [turn] * 8,
        "byInstructions": demo_team.codex_team_overrides(),
    }


def make_repo() -> Path:
    repo = HOME / "repos" / "odeme-servisi"
    (repo / "src" / "ui").mkdir(parents=True)
    (repo / "README.md").write_text("# Ödeme servisi\n\nKart ve havale ödemelerini işleyen servis.\n")
    (repo / "src" / "app.ts").write_text("const a = 1;\nexport default a;\n")
    (repo / "src" / "ui" / "LimitBar.tsx").write_text("export function LimitBar() {\n  return null;\n}\n")
    for args in (
        ["init", "-b", "main"],
        ["add", "."],
        ["-c", "user.email=demo@aistudio.local", "-c", "user.name=AI Studio Demo", "commit", "-m", "İlk sürüm"],
    ):
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)
    return repo


def make_sqlite() -> Path:
    path = HOME / "data" / "odeme-test.db"
    path.parent.mkdir(parents=True)
    con = sqlite3.connect(path)
    con.executescript(
        "CREATE TABLE odemeler (id INTEGER PRIMARY KEY, tutar REAL, para_birimi TEXT, durum TEXT);"
        "INSERT INTO odemeler (tutar, para_birimi, durum) VALUES (149.90,'TRY','tamamlandi'),"
        "(2400,'TRY','beklemede'),(19.99,'EUR','tamamlandi'),(780,'TRY','iade');"
    )
    con.commit()
    con.close()
    return path


async def wait_for(fn: Any, timeout: float = 60.0, what: str = "") -> Any:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = await fn()
        if value:
            return value
        await asyncio.sleep(0.25)
    raise TimeoutError(f"demo seed: timed out waiting for {what}")


async def seed(api: httpx.AsyncClient) -> None:
    ws = (await api.post("/workspaces", json={"name": "Ödeme servisi", "color": "#C96442"})).json()
    repo = (await api.post(f"/workspaces/{ws['id']}/repos", json={"path": str(make_repo())})).json()
    await api.patch(f"/workspaces/repos/{repo['id']}", json={"commands": {"lint": "true", "test": "test -f README.md"}})
    await api.put(
        f"/memory/{ws['id']}/docs/facts.md",
        json={
            "content": "# Proje gerçekleri\n\n## Teknoloji\n\n- TypeScript + React arayüz, Python servisleri.\n"
            "- Ödemeler PostgreSQL'de, test ortamı SQLite.\n\n## Kurallar\n\n- Para tutarları kuruş "
            "cinsinden tamsayı tutulur.\n- Production'a doğrudan yazma yok; her değişiklik deploy ile.\n",
            "message": "Proje gerçekleri güncellendi",
        },
    )

    async def auto_approve_tools() -> None:
        for a in (await api.get("/approvals", params={"kind": "tool_permission"})).json():
            await api.post(f"/approvals/{a['id']}/decision", json={"approve": True})

    # 1) İkili task, driven to completion.
    duo = (
        await api.post(
            "/engine/tasks",
            json={
                "workspace_id": ws["id"],
                "title": "Limit çubuklarını üst çubuğa ekle",
                "prompt": "Üst çubuğa Claude ve Codex için 5 saatlik ve haftalık limit çubukları ekle. "
                "%70 ve %90'da renk değişsin, sıfırlanmaya geri sayım göstersin.",
                "mode": "duo",
            },
        )
    ).json()["task"]

    async def duo_done() -> bool:
        await auto_approve_tools()
        for a in (await api.get("/approvals", params={"task_id": duo["id"], "kind": "final"})).json():
            await api.post(f"/approvals/{a['id']}/decision", json={"approve": True, "note": "Güzel olmuş."})
        task = (await api.get(f"/engine/tasks/{duo['id']}")).json()["task"]
        if task["status"] in ("failed", "cancelled"):
            raise RuntimeError(f"demo duo task {task['status']}")
        return task["status"] == "completed"

    await wait_for(duo_done, what="duo task")

    # 2) Hat (pipeline) task, left waiting on the plan approval.
    hat = (
        await api.post(
            "/engine/tasks",
            json={
                "workspace_id": ws["id"],
                "title": "İade akışına kısmi iade desteği",
                "prompt": "İade servisine kısmi iade desteği ekle; tutar doğrulaması ve denetim kaydı olsun.",
                "mode": "pipeline",
            },
        )
    ).json()["task"]

    async def plan_waiting() -> bool:
        await auto_approve_tools()
        return bool((await api.get("/approvals", params={"task_id": hat["id"], "kind": "plan"})).json())

    await wait_for(plan_waiting, what="pipeline plan approval")

    # 3) Connections: hosts (test + production), a real SQLite database, a deploy profile.
    await api.post(
        "/remote/hosts",
        json={
            "name": "staging-api",
            "hostname": "10.0.4.12",
            "username": "deploy",
            "environment": "test",
            "permission_level": "limited",
            "auth": "agent",
        },
    )
    await api.post(
        "/remote/hosts",
        json={
            "name": "prod-db-1",
            "hostname": "10.0.9.3",
            "username": "readonly",
            "environment": "production",
            "permission_level": "read",
            "auth": "agent",
        },
    )
    await api.post(
        "/remote/db-profiles",
        json={
            "name": "Ödemeler (test)",
            "kind": "sqlite",
            "database": str(make_sqlite()),
            "environment": "test",
            "permission_level": "read",
        },
    )
    await api.post(
        "/deploy/profiles",
        json={
            "workspace_id": ws["id"],
            "name": "Staging deploy",
            "kind": "command",
            "environment": "test",
            "config": {"command": "echo deploy tamam"},
        },
    )
    # 4) Ekip: a saved team template and a team task driven to completion (real merges).
    await api.post(
        "/engine/teams",
        json={
            "workspace_id": ws["id"],
            "name": "Ödeme ekibi",
            "description": "Danışman, lider, üç geliştirici, iki alt ajan ve iki test ajanı.",
            "spec": demo_team.TEAM_SPEC,
        },
    )
    team_task = (
        await api.post(
            "/engine/tasks",
            json={"workspace_id": ws["id"], **demo_team.TEAM_TASK, "mode": "team", "team": demo_team.TEAM_SPEC},
        )
    ).json()["task"]

    async def team_done() -> bool:
        await auto_approve_tools()
        for a in (await api.get("/approvals", params={"task_id": team_task["id"], "kind": "final"})).json():
            await api.post(f"/approvals/{a['id']}/decision", json={"approve": True, "note": "Ekip iyi iş çıkardı."})
        task = (await api.get(f"/engine/tasks/{team_task['id']}")).json()["task"]
        if task["status"] in ("failed", "cancelled"):
            raise RuntimeError(f"demo team task {task['status']}: {task.get('error')}")
        return task["status"] == "completed"

    await wait_for(team_done, timeout=180, what="team task")

    # 5) A plain session whose CLI spawns its own (native) subagents.
    session = (
        await api.post(
            "/agents/sessions",
            json={
                "workspace_id": ws["id"],
                "label": "Araştırma ajanı",
                "spec": {"provider": "claude", "cwd": repo["path"], "system_append": demo_team.SUBAGENT_KEY + "."},
                "initial_prompt": "Test kapsamını çıkar: test dosyalarını bul, eksik senaryoları listele ve bir özet yaz.",
            },
        )
    ).json()

    async def subagents_settled() -> bool:
        await auto_approve_tools()
        subs = (await api.get(f"/agents/sessions/{session['id']}/subagents")).json()
        return bool(subs) and all(sub["status"] != "running" for sub in subs)

    await wait_for(subagents_settled, timeout=60, what="native subagents")

    with contextlib.suppress(Exception):
        await api.post("/limits/refresh")


async def main() -> None:
    sys.path.insert(0, str(ROOT / "backend" / "src"))
    from aistudio.adapters.claude.adapter import ClaudeAdapter
    from aistudio.adapters.codex.adapter import CodexAdapter
    from aistudio.agents.registry import AdapterRegistryImpl
    from aistudio.bootstrap import build_app, build_context
    from aistudio.contracts.agents import AdapterRegistry
    from aistudio.core.config import Paths, Settings
    from aistudio.security.masking import Masker
    from aistudio.security.secrets import MemorySecretStore

    shutil.rmtree(HOME, ignore_errors=True)
    HOME.mkdir(parents=True)
    scenarios = HOME / "scenarios"
    scenarios.mkdir()
    (scenarios / "claude.json").write_text(json.dumps(claude_scenario(), ensure_ascii=False))
    (scenarios / "codex.json").write_text(json.dumps(codex_scenario(), ensure_ascii=False))

    settings = Settings(
        paths=Paths(HOME / "home"),
        port=PORT,
        dev=True,
        dev_token=TOKEN,
        allowed_origins=("tauri://localhost", f"http://localhost:{WEB_PORT}", f"http://127.0.0.1:{WEB_PORT}"),
    )
    masker = Masker()
    ctx = build_context(settings, secrets=MemorySecretStore(masker), masker=masker)
    app, _ = build_app(ctx, token=TOKEN)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, log_level="warning"))
    serve = asyncio.create_task(server.serve())
    while not server.started:  # noqa: ASYNC110 (uvicorn exposes no startup event)
        await asyncio.sleep(0.05)

    registry = ctx.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry, AdapterRegistryImpl)
    registry.replace(
        ClaudeAdapter(
            binary=["env", f"FAKE_CLAUDE_SCENARIO={scenarios / 'claude.json'}", sys.executable, str(FAKE_CLAUDE)]
        )
    )
    registry.replace(
        CodexAdapter(
            command=["env", f"FAKE_CODEX_SCENARIO={scenarios / 'codex.json'}", sys.executable, str(FAKE_CODEX)]
        )
    )
    (settings.paths.home / "runtime.json").write_text(json.dumps({"port": PORT, "pid": 0}))

    async def raise_on_error(response: httpx.Response) -> None:
        if response.is_error:
            await response.aread()
            raise RuntimeError(
                f"demo seed: {response.request.method} {response.request.url} -> "
                f"{response.status_code} {response.text[:300]}"
            )

    async with httpx.AsyncClient(
        base_url=f"http://127.0.0.1:{PORT}/api",
        headers={"Authorization": f"Bearer {TOKEN}"},
        timeout=30,
        event_hooks={"response": [raise_on_error]},
    ) as api:
        print("AI Studio demo: örnek veriler yükleniyor…", flush=True)
        await seed(api)
    print(f"AI Studio demo hazır → http://localhost:{WEB_PORT}  (studiod :{PORT}, durdurmak için Ctrl+C)", flush=True)
    await serve


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
