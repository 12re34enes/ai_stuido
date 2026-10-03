"""CLI-native subagents in the agents module: the per-session index (memory + agents_subagents),
permission requests from inside subagents, the stall watchdog, restart recovery, import and the
HTTP API."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from agents_fakes import AgentsEnv, FakeAdapter, native_info, wait_until_async
from fastapi.testclient import TestClient

from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.agents.subagents import SubagentCounts, SubagentIndex
from aistudio.contracts.agents import (
    AdapterRegistry,
    AgentState,
    Message,
    SessionRecord,
    SessionSpec,
    SessionStarted,
    StartSessionRequest,
    SubagentCompleted,
    SubagentStarted,
    ToolCall,
    ToolKind,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.contracts.approvals import ApprovalStatus
from aistudio.core.context import AppContext
from aistudio.core.events import EventFilter


async def start(env: AgentsEnv, **req: Any) -> SessionRecord:
    spec = SessionSpec(provider="claude", cwd=str(env.cwd))
    return await env.manager.start_session(StartSessionRequest(workspace_id=env.workspace_id, spec=spec, **req))


async def test_index_follows_subagent_payloads(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env)
    h = env.claude.last
    await h.wait_turn(await h.send("subagents"))

    subs = await env.manager.list_subagents(rec.id)
    assert [(s.subagent_id, s.depth, s.parent_subagent_id) for s in subs] == [("sa1", 0, None), ("sa2", 1, "sa1")]
    sa1, sa2 = subs
    assert (sa1.name, sa1.description, sa1.prompt, sa1.model, sa1.parent_call_id) == (
        "explorer",
        "Testleri bul",
        "Testleri bul ve listele",
        "sub-model",  # merged from the second (upsert) SubagentStarted
        "call-sa1",
    )
    assert sa1.status == "success" and sa1.finished_at is not None and sa1.finished_at >= sa1.started_at
    assert (sa1.tool_calls, sa1.input_tokens, sa1.output_tokens) == (2, 150, 40)  # Bash + nested Agent
    assert sa1.last_text == "Bitti: iki test"
    assert sa2.status == "error" and sa2.last_text == "olmadı" and sa2.tool_calls == 0

    # subagent usage never becomes the session's usage
    record = await env.manager.get(rec.id)
    assert record.last_usage is not None and record.last_usage.input_tokens == 10
    started = await env.ctx.events.query(EventFilter(session_id=rec.id, types=["agent.subagent.started"]))
    completed = await env.ctx.events.query(EventFilter(session_id=rec.id, types=["agent.subagent.completed"]))
    assert len(started) == 3 and len(completed) == 2
    assert started[0].payload["name"] == "explorer" and started[0].actor == f"agent:{rec.id}"


async def test_permission_inside_subagent_names_it(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env)
    h = env.claude.last
    turn = await h.send("subbash:npm install")

    async def has_pending() -> bool:
        return bool(await env.approvals.list(status=ApprovalStatus.pending))

    await wait_until_async(has_pending)
    (approval,) = await env.approvals.list(status=ApprovalStatus.pending)
    assert "Alt ajan (explorer): `npm install` komutunu çalıştırmak istiyor" in approval.title
    assert approval.payload["subagent_id"] == "sa1" and approval.payload["subagent_name"] == "explorer"
    assert "Alt ajan: explorer - Testleri bul" in (approval.summary or "")
    await env.approvals.decide(approval.id, approve=True)
    await h.wait_turn(turn)
    assert h.permission_results[-1].allow  # the request kept working through the normal policy
    (req_ev,) = await env.ctx.events.query(EventFilter(session_id=rec.id, types=["agent.permission.request"]))
    assert req_ev.payload["subagent_id"] == "sa1" and req_ev.payload["summary"].startswith("Alt ajan (explorer): ")
    assert (await env.manager.list_subagents(rec.id))[0].status == "running"


async def test_session_end_and_close_interrupt_running_subagents(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env)
    h = env.claude.last
    await h.send("subhang")

    async def running() -> bool:
        subs = await env.manager.list_subagents(rec.id)
        return bool(subs) and subs[0].status == "running" and subs[0].model == "sub-model"

    await wait_until_async(running)
    assert (await env.manager.subagents.counts([rec.id]))[rec.id].active == 1
    await h.end("completed")  # the CLI exits without reporting its subagents
    (sub,) = await env.manager.list_subagents(rec.id)
    assert sub.status == "interrupted" and sub.finished_at is not None

    rec2 = await start(env)
    h2 = env.claude.last
    await h2.send("subhang")

    async def running2() -> bool:
        return bool(await env.manager.list_subagents(rec2.id))

    await wait_until_async(running2)
    await env.manager.close(rec2.id)
    assert (await env.manager.list_subagents(rec2.id))[0].status == "interrupted"


async def test_subagent_activity_keeps_the_stall_watchdog_quiet(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env)
    h = env.claude.last
    await h.send("subhang")  # main turn stays running_tool while the subagent works

    async def is_running() -> bool:
        return (await env.manager.get(rec.id)).state == AgentState.running_tool

    await wait_until_async(is_running)
    live = env.manager._live[rec.id]
    live.last_activity = time.monotonic() - 3600
    await h.sink.emit(Message(message_id="sa1-x", text="hâlâ çalışıyorum", subagent_id="sa1"))
    assert await env.manager.check_stalls(1) == []  # subagent output counts as activity
    live.last_activity = time.monotonic() - 3600
    assert await env.manager.check_stalls(1) == [rec.id]


async def test_restart_recovery_marks_running_subagents_interrupted(agents_env: AgentsEnv) -> None:
    env = agents_env
    index = SubagentIndex(env.ctx.db)
    await index.apply("ses_old", SubagentStarted(subagent_id="x1", name="explorer"))
    await index.apply("ses_old", ToolCall(call_id="c", tool="Read", kind=ToolKind.file_read, subagent_id="x1"))
    await index.apply("ses_old", ToolCall(call_id="c2", tool="Read", kind=ToolKind.file_read))  # main thread: ignored
    fresh = SubagentIndex(env.ctx.db)  # a new studiod process
    assert await fresh.recover_after_restart() == 1
    (sub,) = await fresh.list("ses_old")
    assert sub.status == "interrupted" and sub.tool_calls == 1
    # a payload for a subagent whose start was never seen creates a placeholder
    await fresh.apply("ses_old", Message(message_id="m", text="merhaba", subagent_id="x2"))
    subs = {s.subagent_id: s for s in await fresh.list("ses_old")}
    assert subs["x2"].status == "running" and subs["x2"].last_text == "merhaba"
    # a resumed subagent goes back to running
    await fresh.apply("ses_old", SubagentStarted(subagent_id="x1"))
    assert {s.subagent_id: s.status for s in await fresh.list("ses_old")}["x1"] == "running"
    assert (await fresh.counts(["ses_old", "nope"])) == {"ses_old": SubagentCounts(total=2, active=2)}


async def test_import_builds_the_subagent_index(agents_env: AgentsEnv) -> None:
    env = agents_env
    history = [
        SessionStarted(native_id="nat-1", model="m", cwd=str(env.cwd)),
        TurnStarted(turn_id="t1", input="incele"),
        SubagentStarted(subagent_id="toolu_a", name="Explore", parent_call_id="toolu_a"),
        ToolCall(call_id="toolu_r", tool="Read", kind=ToolKind.file_read, subagent_id="toolu_a"),
        Usage(input_tokens=500, output_tokens=50, subagent_id="toolu_a"),
        SubagentCompleted(subagent_id="toolu_a", status="success", result_text="tamam"),
        SubagentStarted(subagent_id="toolu_b", name="general-purpose"),  # never finished in the transcript
        Usage(input_tokens=7, output_tokens=3),
        TurnCompleted(turn_id="t1", status="success", result_text="bitti"),
    ]
    env.claude.history["nat-1"] = history
    rec = await env.manager.import_native(env.workspace_id, native_info("claude", "nat-1", cwd=str(env.cwd), title="x"))
    subs = {s.subagent_id: s for s in await env.manager.list_subagents(rec.id)}
    assert (
        subs["toolu_a"].status == "success" and subs["toolu_a"].input_tokens == 500 and subs["toolu_a"].tool_calls == 1
    )
    assert subs["toolu_b"].status == "interrupted"
    assert rec.last_usage is not None and rec.last_usage.input_tokens == 7  # main usage only


def test_api_lists_subagents_and_counts(app_ctx: tuple[TestClient, AppContext, str], git_repo: Path) -> None:
    client, ctx, _ = app_ctx
    registry = ctx.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry, AdapterRegistryImpl)
    claude = FakeAdapter("claude")
    registry.replace(claude)
    registry.replace(FakeAdapter("codex"))
    ws = client.post("/api/workspaces", json={"name": "Alt ajan API"}).json()
    body = {"workspace_id": ws["id"], "spec": {"provider": "claude", "cwd": str(git_repo)}}
    s = client.post("/api/agents/sessions", json=body).json()
    assert (s["subagent_count"], s["active_subagents"]) == (0, 0)
    turn = client.post(f"/api/agents/sessions/{s['id']}/send", json={"text": "subagents"}).json()["turn_id"]
    client.portal.call(claude.last.wait_turn, turn)  # type: ignore[union-attr]

    r = client.get(f"/api/agents/sessions/{s['id']}/subagents")
    assert r.status_code == 200
    subs = r.json()
    assert [x["subagent_id"] for x in subs] == ["sa1", "sa2"]
    assert subs[1]["parent_subagent_id"] == "sa1" and subs[1]["depth"] == 1
    assert set(subs[0]) >= {
        "session_id",
        "subagent_id",
        "parent_subagent_id",
        "parent_call_id",
        "depth",
        "name",
        "description",
        "prompt",
        "status",
        "model",
        "started_at",
        "finished_at",
        "updated_at",
        "input_tokens",
        "output_tokens",
        "tool_calls",
        "last_text",
    }
    view = client.get(f"/api/agents/sessions/{s['id']}").json()
    assert (view["subagent_count"], view["active_subagents"]) == (2, 0)
    listed = client.get("/api/agents/sessions", params={"workspace_id": ws["id"]}).json()
    assert listed[0]["subagent_count"] == 2
    assert client.get("/api/agents/sessions/ses_nope/subagents").status_code == 404
