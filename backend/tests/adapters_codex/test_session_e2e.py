"""End-to-end: CodexAdapter + CodexSession over a real subprocess (the fake app-server)."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

import pytest

from aistudio.adapters.codex import schema_tools
from aistudio.adapters.codex.session import CodexSession
from aistudio.contracts.agents import (
    AgentErrorEv,
    AgentState,
    Boundaries,
    FileChanged,
    Message,
    MessageDelta,
    SandboxLevel,
    SessionEnded,
    SessionSpec,
    SessionStarted,
    StatusChanged,
    Thinking,
    ThinkingDelta,
    ToolCall,
    ToolKind,
    ToolResultEv,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.core.errors import Conflict, NotFound, Unavailable

from .conftest import FakeToolHost, Harness, MakeHarness, Permissions, RecordingSink, eventually, load_scenario
from .schema_check import validate_def, validate_message

SCHEMA = schema_tools.load_committed()


def spec_for(workdir: Path, **kw: Any) -> SessionSpec:
    return SessionSpec(provider="codex", cwd=str(workdir), **kw)


async def start(
    h: Harness,
    spec: SessionSpec,
    *,
    sink: RecordingSink | None = None,
    tools: FakeToolHost | None = None,
    permissions: Permissions | None = None,
) -> tuple[CodexSession, RecordingSink, FakeToolHost, Permissions]:
    sink = sink or RecordingSink()
    tools = tools or FakeToolHost()
    permissions = permissions or Permissions()
    handle = await h.adapter.start(spec, transport=h.transport, sink=sink, tools=tools, permissions=permissions)
    assert isinstance(handle, CodexSession)
    return handle, sink, tools, permissions


def assert_client_traffic_valid(h: Harness) -> None:
    """Every message our adapter sent must validate against the committed schema."""
    from aistudio.adapters.codex import protocol as p

    for entry in h.client_log():
        msg = entry["recv"]
        if entry["respondsTo"]:
            spec = p.SERVER_REQUESTS.get(entry["respondsTo"])
            if spec is not None and spec.result is not None and "result" in msg:
                assert validate_def(SCHEMA, spec.result.schema_name, msg["result"]) == [], entry
        elif "id" in msg:
            assert validate_message(SCHEMA, "ClientRequest", msg) == [], msg
        else:
            assert validate_message(SCHEMA, "ClientNotification", msg) == [], msg


# --------------------------------------------------------------------------- full turn


async def test_full_turn_with_approvals_tools_usage_and_limits(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("full_turn")
    spec = spec_for(workdir, model="gpt-5.5", effort="high", system_append="Hafıza: PEP8 kullan.")
    session, sink, tools, perms = await start(h, spec)
    assert session.native_id == "019a7a10-0000-7000-8000-00000000a001"
    assert session.state == AgentState.idle

    turn_id = await session.send("Testleri çalıştır")
    result = await session.wait_turn(turn_id, timeout=10)
    assert result.status == "success"
    assert result.text == "Testler geçti."

    # --- thread/start params
    (init,) = h.sent("initialize")
    assert init["params"]["capabilities"]["experimentalApi"] is True
    assert h.sent("initialized")
    (ts,) = h.sent("thread/start")
    params = ts["params"]
    assert params["cwd"] == str(workdir)
    assert params["model"] == "gpt-5.5"
    assert params["sandbox"] == "workspace-write"
    assert params["approvalPolicy"] == "untrusted"
    assert params["approvalsReviewer"] == "user"
    assert params["config"]["model_reasoning_effort"] == "high"
    assert params["config"]["sandbox_workspace_write"] == {"network_access": True, "writable_roots": []}
    assert params["developerInstructions"].startswith("Hafıza: PEP8 kullan.")
    assert [t["name"] for t in params["dynamicTools"]] == ["memory_read", "deploy_request"]
    assert params["dynamicTools"][0]["inputSchema"]["properties"]["query"]["type"] == "string"

    # --- normalized events
    started = sink.of(SessionStarted)[0]
    assert started.native_id == session.native_id and started.cli_version == "0.160.0" and started.model == "gpt-5.5"
    assert sink.states()[0] == AgentState.starting
    (ts_ev,) = sink.of(TurnStarted)
    assert ts_ev.turn_id == turn_id and ts_ev.input == "Testleri çalıştır"
    assert [d.text for d in sink.of(ThinkingDelta)] == ["Testleri çalıştırmalıyım"]
    assert sink.of(Thinking)[0].text == "Testleri çalıştırmalıyım"

    calls = {c.call_id: c for c in sink.of(ToolCall)}
    assert calls["call_cmd1"].kind == ToolKind.command
    assert calls["call_cmd1"].summary == "npm test çalıştırılıyor"
    assert calls["call_patch1"].kind == ToolKind.file_edit
    assert calls["call_patch1"].summary == "2 dosya düzenleniyor"
    assert calls["call_tool1"].kind == ToolKind.studio and calls["call_tool1"].tool == "memory_read"
    assert calls["call_tool1"].input == {"query": "conventions"}
    assert len(sink.of(ToolCall)) == 3  # dynamic tool reported once (from the request)

    results = {r.call_id: r for r in sink.of(ToolResultEv)}
    assert results["call_cmd1"].output == "ok 1 tests\n" and results["call_cmd1"].exit_code == 0
    assert not results["call_cmd1"].is_error
    assert not results["call_patch1"].is_error
    assert results["call_tool1"].output == "memory_read: kod stili PEP8"
    changes = sink.of(FileChanged)
    assert [(c.path, c.change) for c in changes] == [("src/app.ts", "modify"), ("README.md", "add")]
    assert changes[0].diff and "+b" in changes[0].diff

    # approvals reached the permission handler with Turkish summaries
    cmd_req, file_req = perms.requests
    assert cmd_req.kind == ToolKind.command and cmd_req.command == "/bin/zsh -lc 'npm test'"
    assert cmd_req.summary == "npm test komutunu çalıştırmak istiyor"
    assert cmd_req.reason == "Testleri çalıştırmak için"
    assert file_req.kind == ToolKind.file_edit
    assert file_req.paths == ["src/app.ts", "README.md"]
    assert file_req.summary == "2 dosyada değişiklik yapmak istiyor"
    assert [r["result"]["decision"] for r in h.responses_to("item/commandExecution/requestApproval")] == ["accept"]
    assert [r["result"]["decision"] for r in h.responses_to("item/fileChange/requestApproval")] == ["accept"]
    (tool_resp,) = h.responses_to("item/tool/call")
    assert tool_resp["result"] == {
        "contentItems": [{"type": "inputText", "text": "memory_read: kod stili PEP8"}],
        "success": True,
    }
    assert tools.calls == [("memory_read", {"query": "conventions"})]

    # usage: per-turn delta from the first update's base (total - last)
    usages = sink.of(Usage)
    assert len(usages) == 2
    last = usages[-1]
    # base = total1 - last1 = (1200-700 input, 200-200 cached, ...) -> input 500, cached 0
    assert last.cache_read_tokens == 500
    assert last.input_tokens == (2000 - 500) - (500 - 0)
    assert last.context_window == 258400 and last.context_used == 800 + 450
    completed = sink.of(TurnCompleted)[0]
    assert completed.status == "success" and completed.result_text == "Testler geçti."
    assert completed.usage is not None and completed.usage.duration_ms == 1234
    assert completed.usage.cache_read_tokens == 500

    # limits
    (windows,) = sink.limit_batches
    by_name = {w.window: w for w in windows}
    assert by_name["five_hour"].label == "5 saat" and by_name["five_hour"].status == "ok"
    assert by_name["seven_day"].label == "Haftalık" and by_name["seven_day"].status == "warning"
    assert by_name["seven_day"].window_minutes == 10080

    # message streaming
    assert [d.text for d in sink.of(MessageDelta)] == ["Testler ", "geçti."]
    assert sink.of(Message)[-1].text == "Testler geçti."

    # status transitions
    states = sink.states()
    for expected in (
        AgentState.thinking,
        AgentState.running_tool,
        AgentState.waiting_permission,
        AgentState.responding,
        AgentState.idle,
    ):
        assert expected in states
    waiting = [e for e in sink.events if isinstance(e, StatusChanged) and e.state == AgentState.waiting_permission]
    assert waiting[0].detail == "npm test komutunu çalıştırmak istiyor"
    assert states[-1] == AgentState.idle
    order = sink.types()
    assert order.index("TurnStarted") < order.index("ToolCall") < order.index("TurnCompleted")

    assert_client_traffic_valid(h)
    await session.close()
    assert sink.of(SessionEnded)[-1].reason == "closed"
    assert session.state == AgentState.done


async def test_denied_approvals_are_declined(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("full_turn")
    perms = Permissions(allow=False)
    session, sink, _tools, _ = await start(h, spec_for(workdir), permissions=perms)
    result = await session.wait_turn(await session.send("dene"), timeout=10)
    assert result.status == "success"
    assert [r["result"]["decision"] for r in h.responses_to("item/commandExecution/requestApproval")] == ["decline"]
    assert [r["result"]["decision"] for r in h.responses_to("item/fileChange/requestApproval")] == ["decline"]
    results = {r.call_id: r for r in sink.of(ToolResultEv)}
    assert results["call_cmd1"].is_error and results["call_cmd1"].output == "Komut reddedildi."
    assert results["call_patch1"].is_error
    assert sink.of(FileChanged) == []
    await session.close()


async def test_advisor_is_read_only_without_mutating_tools(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("full_turn")
    spec = spec_for(workdir, role="advisor", boundaries=Boundaries(network=False))
    session, sink, _tools, perms = await start(h, spec)
    await session.wait_turn(await session.send("incele"), timeout=10)
    params = h.sent("thread/start")[0]["params"]
    assert params["sandbox"] == "read-only"
    assert [t["name"] for t in params["dynamicTools"]] == ["memory_read"]
    assert params["config"]["web_search"] == "disabled"
    assert "sandbox_workspace_write" not in params["config"]
    assert "advisor" in params["developerInstructions"]
    # the file change was declined without asking the policy; the command was asked
    assert [r.kind for r in perms.requests] == [ToolKind.command]
    assert [r["result"]["decision"] for r in h.responses_to("item/fileChange/requestApproval")] == ["decline"]
    assert sink.of(FileChanged) == []
    await session.close()


async def test_boundaries_map_to_sandbox_network_and_instructions(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("queue")
    b = Boundaries(
        sandbox=SandboxLevel.full,
        network=False,
        forbidden_paths=[".env"],
        readonly_paths=["migrations/**"],
        denied_commands=["rm -rf"],
    )
    session, _sink, _tools, _ = await start(h, spec_for(workdir, boundaries=b, extra_dirs=["/tmp/shared"]))
    params = h.sent("thread/start")[0]["params"]
    assert params["sandbox"] == "danger-full-access"
    assert params["approvalPolicy"] == "untrusted"
    instr = params["developerInstructions"]
    assert ".env" in instr and "migrations/**" in instr and "rm -rf" in instr and "Network access is disabled" in instr
    await session.close()

    h2 = make_harness("queue")
    session2, _s, _t, _ = await start(h2, spec_for(workdir, extra_dirs=["/tmp/shared"]))
    params2 = h2.sent("thread/start")[0]["params"]
    assert params2["config"]["sandbox_workspace_write"] == {"network_access": True, "writable_roots": ["/tmp/shared"]}
    await session2.close()


async def test_environment_is_complete_and_scrubbed(make_harness: MakeHarness, workdir: Path) -> None:
    fake_key = "sk-" + "proj-" + "x" * 24
    h = make_harness(
        "queue",
        extra_env={"OPENAI_API_KEY": fake_key, "SSH_AUTH_SOCK": "/tmp/agent.sock", "KEEP_ME": "1"},
    )
    session, _sink, _tools, _ = await start(h, spec_for(workdir, env={"AISTUDIO_SESSION": "s1"}))
    rec = h.transport.spawned[0]
    assert rec.argv[-1] == "app-server" and rec.cwd == str(workdir)
    assert rec.env is not None
    assert "OPENAI_API_KEY" not in rec.env and "SSH_AUTH_SOCK" not in rec.env
    assert rec.env["KEEP_ME"] == "1" and rec.env["AISTUDIO_SESSION"] == "s1"
    assert rec.env["PATH"].split(":")[0] == os.path.dirname(sys.executable)
    await session.close()


# --------------------------------------------------------------------------- steer / interrupt / failure


async def test_steer_interrupt_failure_and_recovery(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("steer_interrupt")
    session, sink, _tools, _ = await start(h, spec_for(workdir))

    # turn 1: steer into the running turn
    t1 = await session.send("Uzun bir iş yap")
    await sink.wait_for(lambda: bool(sink.of(MessageDelta)))
    await session.steer("Kısa tut")
    r1 = await session.wait_turn(t1, timeout=10)
    assert r1.status == "success" and r1.text == "Yönlendirme alındı."
    (steer,) = h.sent("turn/steer")
    assert steer["params"]["expectedTurnId"] == t1
    assert steer["params"]["input"] == [{"type": "text", "text": "Kısa tut", "text_elements": []}]
    assert any(isinstance(e, Message) and e.role == "user" and e.text == "Kısa tut" for e in sink.events)

    # turn 2: interrupt
    t2 = await session.send("Bir şey düşün")
    await sink.wait_for(lambda: session.state == AgentState.thinking and len(sink.of(TurnStarted)) == 2)
    await session.interrupt()
    r2 = await session.wait_turn(t2, timeout=10)
    assert r2.status == "interrupted"
    assert h.sent("turn/interrupt")[0]["params"] == {"threadId": session.native_id, "turnId": t2}
    assert session.state == AgentState.interrupted
    await session.interrupt()  # no active turn: no-op (the real server would never answer)

    # turn 3: retrying error then a failed turn
    t3 = await session.send("Tekrar")
    r3 = await session.wait_turn(t3, timeout=10)
    assert r3.status == "error" and r3.error == "You've hit your usage limit."
    errs = sink.of(AgentErrorEv)
    assert errs[0].retryable and errs[0].code == "responseStreamDisconnected"
    assert errs[0].message.startswith("Codex yeniden deniyor: Reconnecting... 1/5")
    assert session.state == AgentState.error

    # turn 4: the session recovers
    r4 = await session.wait_turn(await session.send("Hazır mısın?"), timeout=10)
    assert r4.status == "success" and r4.text == "Tekrar hazırım."
    assert [c.status for c in sink.of(TurnCompleted)] == ["success", "interrupted", "error", "success"]
    assert_client_traffic_valid(h)
    await session.close()


async def test_steer_without_active_turn_starts_a_turn(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("queue")
    session, sink, _tools, _ = await start(h, spec_for(workdir))
    await session.steer("Yeni iş")
    result = await session.wait_turn(timeout=10)
    assert result.status == "success"
    assert h.sent("turn/steer") == []
    assert sink.of(TurnStarted)[0].input == "Yeni iş"
    await session.close()


async def test_messages_sent_during_a_turn_are_queued(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("queue")
    session, sink, _tools, _ = await start(h, spec_for(workdir))
    a = await session.send("A")
    b = await session.send("B")
    c = await session.send("C")
    assert b.startswith("queued_") and c.startswith("queued_")
    rc = await session.wait_turn(c, timeout=10)
    rb = await session.wait_turn(b, timeout=10)
    ra = await session.wait_turn(a, timeout=10)
    assert (ra.text, rb.text, rc.text) == ("Birinci bitti.", "İkinci bitti.", "Üçüncü bitti.")
    assert [t.input for t in sink.of(TurnStarted)] == ["A", "B", "C"]
    assert rb.turn_id != b  # the result carries the real Codex turn id
    with pytest.raises(NotFound):
        await session.wait_turn("nope", timeout=1)
    await session.close()


async def test_interrupt_drops_queued_messages(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("queue")
    session, sink, _tools, _ = await start(h, spec_for(workdir))
    a = await session.send("A")
    b = await session.send("B")
    await session.interrupt()
    assert (await session.wait_turn(b, timeout=5)).status == "interrupted"
    assert (await session.wait_turn(a, timeout=5)).status == "interrupted"
    await asyncio.sleep(0.2)
    assert [t.input for t in sink.of(TurnStarted)] == ["A"]
    await session.close()


async def test_wait_turn_without_turns(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("queue")
    session, _sink, _tools, _ = await start(h, spec_for(workdir))
    with pytest.raises(Conflict):
        await session.wait_turn()
    await session.close()
    await session.close()  # idempotent
    with pytest.raises(Unavailable):
        await session.send("kapalı")


# --------------------------------------------------------------------------- process death / robustness


async def test_process_crash_ends_session_with_error(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("crash")
    session, sink, _tools, _ = await start(h, spec_for(workdir))
    turn = await session.send("çök")
    result = await session.wait_turn(turn, timeout=10)
    assert result.status == "error"
    assert result.error is not None and "çıkış kodu 101" in result.error
    await sink.wait_for(lambda: bool(sink.of(SessionEnded)))
    ended = sink.of(SessionEnded)[0]
    assert ended.reason == "error" and ended.exit_code == 101
    err = next(e for e in sink.of(AgentErrorEv) if e.code == "process_exited")
    assert "fake panic" in err.message
    assert sink.of(TurnCompleted)[-1].status == "error"
    assert session.state == AgentState.error
    with pytest.raises(Unavailable):
        await session.send("tekrar")
    await session.close()  # no-op after death


async def test_malformed_lines_unknown_and_foreign_notifications_are_ignored(
    make_harness: MakeHarness, workdir: Path
) -> None:
    h = make_harness("malformed")
    session, sink, _tools, _ = await start(h, spec_for(workdir))
    result = await session.wait_turn(await session.send("devam"), timeout=10)
    assert result.status == "success" and result.text == "Hâlâ çalışıyorum."
    assert sink.of(MessageDelta) == []  # the sub-agent thread's delta was filtered out
    assert session._conn is not None and session._conn.malformed_lines >= 3
    await session.close()


async def test_permissions_withdrawn_requests_and_misc_server_requests(
    make_harness: MakeHarness, workdir: Path
) -> None:
    h = make_harness("extras")
    gate = asyncio.Event()

    def allow(req: Any) -> bool:
        return req.tool == "request_permissions"

    perms = Permissions(allow=allow)
    session, sink, tools, _ = await start(h, spec_for(workdir), permissions=perms)

    original_call = perms.__call__

    async def gated(req: Any) -> Any:
        if req.tool == "shell":  # the server withdraws this one; never answer it
            perms.requests.append(req)
            await gate.wait()
        return await original_call(req)

    session._permissions = gated
    result = await session.wait_turn(await session.send("izinler"), timeout=10)
    assert result.status == "success" and result.text == "Bitti."

    perm_req = next(r for r in perms.requests if r.tool == "request_permissions")
    assert perm_req.summary.startswith("Ek izin istiyor: ağ erişimi; yazma:")
    (perm_resp,) = h.responses_to("item/permissions/requestApproval")
    assert perm_resp["result"]["permissions"]["network"] == {"enabled": True}
    assert perm_resp["result"]["scope"] == "turn"
    # withdrawn approval: handler cancelled, no response sent, state back to thinking
    assert h.responses_to("item/commandExecution/requestApproval") == []
    (ask,) = h.responses_to("item/tool/requestUserInput")
    assert ask["result"] == {"answers": {}}
    (now,) = h.responses_to("currentTime/read")
    assert isinstance(now["result"]["currentTimeAt"], int)
    (refresh,) = h.responses_to("account/chatgptAuthTokens/refresh")
    assert refresh["error"]["code"] == -32601
    deploy, ns = h.responses_to("item/tool/call")
    assert deploy["result"]["success"] is True  # mutating tools are exposed to writers
    assert ns["result"]["success"] is False  # namespaced tools are not ours
    assert ns["result"]["contentItems"][0]["text"] == "Unknown or not permitted tool: other.memory_read"
    assert tools.calls == [("deploy_request", {})]
    shell_req = next(r for r in perms.requests if r.tool == "shell")
    idx = next(i for i, e in enumerate(sink.events) if isinstance(e, StatusChanged) and e.detail == shell_req.summary)
    assert any(isinstance(e, StatusChanged) and e.state == AgentState.thinking for e in sink.events[idx:])
    assert_client_traffic_valid(h)
    await session.close()


async def test_permissions_denied_grants_nothing(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("extras")
    session, sink, _tools, _ = await start(h, spec_for(workdir), permissions=Permissions(allow=False))
    await session.wait_turn(await session.send("izinler"), timeout=10)
    (perm_resp,) = h.responses_to("item/permissions/requestApproval")
    assert perm_resp["result"]["permissions"] == {}
    assert any(isinstance(e, Message) and e.text == "İzin yok." for e in sink.events)
    await session.close()


# --------------------------------------------------------------------------- resume / fork


async def test_resume_existing_thread(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("history")
    tid = "019a7a10-0000-7000-8000-00000000b001"
    session, sink, _tools, _ = await start(h, spec_for(workdir, resume_native_id=tid, title="Devam"))
    assert session.native_id == tid
    (resume,) = h.sent("thread/resume")
    assert resume["params"]["threadId"] == tid and resume["params"]["excludeTurns"] is True
    assert resume["params"]["approvalPolicy"] == "untrusted"
    assert "dynamicTools" not in resume["params"]
    assert h.sent("thread/start") == [] and h.sent("thread/name/set") == []
    assert sink.of(SessionStarted)[0].native_id == tid
    result = await session.wait_turn(await session.send("devam et"), timeout=10)
    assert result.text == "Kaldığım yerden devam ediyorum."
    assert_client_traffic_valid(h)
    await session.close()


async def test_resume_unknown_thread_raises_not_found(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("history")
    sink = RecordingSink()
    with pytest.raises(NotFound):
        await start(h, spec_for(workdir, resume_native_id="019a0000-0000-7000-8000-000000000000"), sink=sink)
    assert sink.of(AgentErrorEv)[0].code == "start_failed"
    assert sink.states()[-1] == AgentState.error
    await eventually(lambda: all(p._p.returncode is not None for p in h.transport.processes))


async def test_fork_creates_new_thread_and_names_it(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness("history")
    tid = "019a7a10-0000-7000-8000-00000000b001"
    session, _sink, _tools, _ = await start(h, spec_for(workdir, resume_native_id=tid, fork=True, title="Deneme dalı"))
    assert session.native_id == "019a7a10-0000-7000-8000-00000000c001"
    assert h.sent("thread/fork")[0]["params"]["threadId"] == tid
    assert h.sent("thread/name/set")[0]["params"] == {"threadId": session.native_id, "name": "Deneme dalı"}
    await session.close()


async def test_start_failure_when_app_server_exits(make_harness: MakeHarness, workdir: Path) -> None:
    h = make_harness({"failStart": "error: unexpected argument"})
    sink = RecordingSink()
    with pytest.raises(Unavailable) as exc:
        await start(h, spec_for(workdir), sink=sink)
    assert "unexpected argument" in exc.value.message
    assert sink.of(SessionEnded) == []


async def test_unhandled_scenario_keys_do_not_break_start(make_harness: MakeHarness, workdir: Path) -> None:
    data = load_scenario("queue")
    data["model"] = "gpt-5.5-codex"
    h = make_harness(data)
    session, sink, _tools, _ = await start(h, spec_for(workdir))
    assert sink.of(SessionStarted)[0].model == "gpt-5.5-codex"
    await session.close()
