"""End-to-end: ClaudeAdapter + ClaudeSession driving the fake CLI through a local transport."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest

from aistudio.contracts.agents import (
    AgentErrorEv,
    AgentState,
    FileChanged,
    Message,
    MessageDelta,
    PermissionDecision,
    PermissionRequest,
    SessionEnded,
    SessionSpec,
    SessionStarted,
    Thinking,
    ThinkingDelta,
    ToolCall,
    ToolKind,
    ToolResultEv,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.core.errors import NotFound, Unavailable

from .helpers import (
    FakeToolHost,
    LocalTestTransport,
    RecordingSink,
    ScriptedPermissions,
    load_fixture_scenario,
    make_adapter,
    read_log,
)


def _spec(cwd: Path, **kw: Any) -> SessionSpec:
    return SessionSpec(provider="claude", cwd=str(cwd), **kw)


def _result(**kw: Any) -> dict[str, Any]:
    return {"op": "result", **kw}


def _text_frame(msg_id: str, text: str) -> dict[str, Any]:
    return {
        "op": "emit",
        "msg": {
            "type": "assistant",
            "message": {
                "id": msg_id,
                "role": "assistant",
                "model": "claude-sonnet-4-5",
                "content": [{"type": "text", "text": text}],
            },
            "parent_tool_use_id": None,
            "session_id": "$SESSION",
        },
    }


async def _start(tmp_path: Path, scenario: dict[str, Any], perms: ScriptedPermissions | None = None, **spec_kw: Any):
    adapter, log = make_adapter(tmp_path, scenario)
    sink = RecordingSink()
    tools = FakeToolHost()
    perms = perms or ScriptedPermissions()
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    transport = LocalTestTransport(home=str(tmp_path / "home"))
    session = await adapter.start(
        _spec(work, **spec_kw), transport=transport, sink=sink, tools=tools, permissions=perms
    )
    return adapter, session, sink, tools, perms, log, work


async def test_full_turn_allow(tmp_path: Path) -> None:
    adapter, session, sink, tools, perms, log, work = await _start(
        tmp_path, load_fixture_scenario("scenario_full_turn.json")
    )
    try:
        turn_id = await session.send("Testleri çalıştır ve app.ts'i düzelt")
        result = await session.wait_turn(turn_id, timeout=20)
    finally:
        await session.close()

    assert result.status == "success"
    assert result.text == "Bitti: testler geçti ve app.ts güncellendi."

    started = sink.of(SessionStarted)
    assert len(started) == 1 and started[0].native_id == session.native_id and started[0].cwd == str(work)
    assert sink.of(TurnStarted)[0].input == "Testleri çalıştır ve app.ts'i düzelt"

    # streaming deltas share message ids with the final blocks
    thinking_deltas = sink.of(ThinkingDelta)
    assert [d.text for d in thinking_deltas] == ["Testleri çalıştırmalıyım."]
    assert sink.of(Thinking)[0].message_id == thinking_deltas[0].message_id == "msg_01:0"
    deltas = sink.of(MessageDelta)
    assert "".join(d.text for d in deltas) == "Önce testleri çalıştırıyorum."
    messages = sink.of(Message)
    assert messages[0].message_id == deltas[0].message_id == "msg_01:1"
    assert messages[-1].text.startswith("Bitti")

    calls = {c.call_id: c for c in sink.of(ToolCall)}
    assert calls["toolu_bash"].kind == ToolKind.command
    assert calls["toolu_bash"].summary == "`npm test` çalıştırılıyor"
    assert calls["toolu_mem"].kind == ToolKind.studio
    assert calls["toolu_edit"].kind == ToolKind.file_edit
    assert calls["toolu_edit"].summary == "src/app.ts düzenleniyor"

    results = {r.call_id: r for r in sink.of(ToolResultEv)}
    assert results["toolu_bash"].exit_code == 0 and "3 passed" in results["toolu_bash"].output
    assert results["toolu_mem"].output == "memory:conventions.md" and not results["toolu_mem"].is_error
    assert tools.calls == [("memory_read", {"key": "conventions.md"})]

    changes = sink.of(FileChanged)
    assert len(changes) == 1
    assert changes[0].path == "src/app.ts" and changes[0].change == "modify"
    assert changes[0].diff is not None and "-const a = 1;" in changes[0].diff and "+const a = 2;" in changes[0].diff

    # permissions: Bash and Edit asked; ANSI stripped from the CLI's reason
    assert [r.tool for r in perms.requests] == ["Bash", "Edit"]
    bash_req = perms.requests[0]
    assert bash_req.command == "npm test"
    assert bash_req.summary == "`npm test` komutunu çalıştırmak istiyor"
    assert bash_req.reason == "Requires approval"
    assert bash_req.request_id.startswith("cli_")
    assert perms.requests[1].paths == ["src/app.ts"]

    # rate limit event -> windows (fraction -> percent)
    assert len(sink.limit_batches) == 1
    windows = {w.window: w for w in sink.limit_batches[0]}
    assert windows["five_hour"].used_percent == 82.0 and windows["five_hour"].status == "warning"
    assert windows["five_hour"].label == "5 saat"
    assert windows["seven_day"].used_percent == 41.0 and windows["seven_day"].status == "ok"

    usage = sink.of(Usage)[-1]
    assert usage.input_tokens == 87 and usage.output_tokens == 171
    assert usage.cache_read_tokens == 37200 and usage.reasoning_tokens == 12
    assert usage.context_window == 200000 and usage.turns == 4 and usage.duration_ms == 5400
    assert usage.context_used == 30 + 20 + 9500 + 15
    assert usage.api_equivalent_usd == pytest.approx(0.0421)
    completed = sink.of(TurnCompleted)
    assert completed[-1].turn_id == turn_id and completed[-1].status == "success" and completed[-1].usage == usage

    # status transitions over the turn
    states = sink.states()
    assert states[0] == AgentState.starting
    for expected in (
        AgentState.idle,
        AgentState.thinking,
        AgentState.responding,
        AgentState.running_tool,
        AgentState.waiting_permission,
        AgentState.done,
    ):
        assert expected in states
    idx_wait = states.index(AgentState.waiting_permission)
    assert states[idx_wait + 1] == AgentState.running_tool
    assert isinstance(sink.events[-1], type(sink.events[-1]))
    ended = sink.of(SessionEnded)
    assert len(ended) == 1 and ended[0].reason == "closed"

    entries = read_log(log)
    decisions = [e["decision"] for e in entries if "decision" in e]
    assert decisions[0] == {
        "behavior": "allow",
        "updatedInput": {"command": "npm test", "description": "Run tests"},
        "toolUseID": "toolu_bash",
    }
    # the CLI saw our tools over mcp_message
    init = next(e for e in entries if "mcp_initialized" in e)["mcp_initialized"]
    assert init["serverInfo"]["name"] == "studio" and init["protocolVersion"] == "2025-06-18"
    sent_users = [e["in"] for e in entries if "in" in e and e["in"].get("type") == "user"]
    assert sent_users[0]["message"] == {"role": "user", "content": "Testleri çalıştır ve app.ts'i düzelt"}
    assert sent_users[0]["session_id"] == session.native_id and sent_users[0]["uuid"]
    initialize = next(
        e["in"] for e in entries if "in" in e and e["in"].get("request", {}).get("subtype") == "initialize"
    )
    assert initialize["request"]["sdkMcpServers"] == ["studio"]
    # environment scrubbed: API key and nested-session markers removed
    env = entries[0]["env"]
    assert env["ANTHROPIC_API_KEY"] is None and env["CLAUDE_CODE_ENTRYPOINT"] == "sdk-py"
    assert adapter._live == {}  # forgotten after close


async def test_permission_deny_and_updated_input(tmp_path: Path) -> None:
    def decide(req: PermissionRequest) -> PermissionDecision:
        if req.tool == "Bash":
            return PermissionDecision(allow=False, reason="Politika: test komutları yasak", decided_by="policy")
        return PermissionDecision(
            allow=True,
            decided_by="user",
            updated_input={**req.input, "new_string": "const a = 3;"},
        )

    perms = ScriptedPermissions(decide)
    _, session, sink, _, _, log, _ = await _start(tmp_path, load_fixture_scenario("scenario_full_turn.json"), perms)
    try:
        await session.send("go")
        result = await session.wait_turn(timeout=20)
    finally:
        await session.close()
    assert result.status == "success"
    bash_result = next(r for r in sink.of(ToolResultEv) if r.call_id == "toolu_bash")
    assert bash_result.is_error and bash_result.exit_code is None
    decisions = [e["decision"] for e in read_log(log) if "decision" in e]
    assert decisions[0] == {"behavior": "deny", "message": "Politika: test komutları yasak", "toolUseID": "toolu_bash"}
    assert decisions[1]["behavior"] == "allow" and decisions[1]["updatedInput"]["new_string"] == "const a = 3;"
    # after a denial the agent goes back to thinking, not running_tool
    states = sink.states()
    assert states[states.index(AgentState.waiting_permission) + 1] == AgentState.thinking


async def test_permission_handler_error_denies(tmp_path: Path) -> None:
    def boom(_req: PermissionRequest) -> PermissionDecision:
        raise RuntimeError("policy down")

    _, session, _, _, _, log, _ = await _start(
        tmp_path, load_fixture_scenario("scenario_full_turn.json"), ScriptedPermissions(boom)
    )
    try:
        await session.send("go")
        await session.wait_turn(timeout=20)
    finally:
        await session.close()
    decisions = [e["decision"] for e in read_log(log) if "decision" in e]
    assert decisions and all(d["behavior"] == "deny" for d in decisions)
    assert "policy down" in decisions[0]["message"]


async def test_argv_new_session(tmp_path: Path) -> None:
    _, session, _, _, _, log, work = await _start(
        tmp_path, {"turns": []}, model="sonnet", effort="high", system_append="HAFIZA", extra_dirs=["/tmp/x"]
    )
    await session.close()
    argv = read_log(log)[0]["argv"]
    assert argv[:2] == ["-p", "--input-format"]
    assert argv[argv.index("--session-id") + 1] == session.native_id
    assert "--resume" not in argv
    assert argv[argv.index("--model") + 1] == "sonnet"
    assert argv[argv.index("--effort") + 1] == "high"
    assert argv[argv.index("--append-system-prompt") + 1] == "HAFIZA"
    assert argv[argv.index("--add-dir") + 1] == "/tmp/x"
    assert argv[argv.index("--permission-prompt-tool") + 1] == "stdio"
    assert "--include-partial-messages" in argv and "--verbose" in argv
    assert read_log(log)[0]["cwd"] == str(work)


async def test_resume_and_fork_argv(tmp_path: Path) -> None:
    old = "11111111-2222-4333-8444-555555555555"
    adapter, session, sink, _, _, log, _ = await _start(tmp_path, {"turns": []}, resume_native_id=old)
    assert session.native_id == old
    await session.close()
    argv = read_log(log)[0]["argv"]
    assert argv[argv.index("--resume") + 1] == old
    assert "--session-id" not in argv and "--fork-session" not in argv
    assert sink.of(SessionStarted)[0].native_id == old

    log.unlink()
    transport = LocalTestTransport(home=str(tmp_path / "home"))
    forked = await adapter.start(
        _spec(tmp_path / "work", resume_native_id=old, fork=True),
        transport=transport,
        sink=RecordingSink(),
        tools=FakeToolHost(),
        permissions=ScriptedPermissions(),
    )
    await forked.close()
    argv = read_log(log)[0]["argv"]
    assert argv[argv.index("--resume") + 1] == old
    assert "--fork-session" in argv
    assert argv[argv.index("--session-id") + 1] == forked.native_id != old


async def test_resume_rejects_invalid_id(tmp_path: Path) -> None:
    adapter, _ = make_adapter(tmp_path, {"turns": []})
    with pytest.raises(Exception, match="Geçersiz"):
        await adapter.start(
            _spec(tmp_path, resume_native_id="../../etc/passwd"),
            transport=LocalTestTransport(),
            sink=RecordingSink(),
            tools=FakeToolHost(),
            permissions=ScriptedPermissions(),
        )


async def test_interrupt(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [
                _text_frame("msg_1", "Uzun bir iş başlıyor"),
                {"op": "wait_interrupt", "timeout": 10, "then": [_result(result="")]},
            ],
            [_result(result="ikinci")],
        ]
    }
    _, session, sink, _, _, log, _ = await _start(tmp_path, scenario)
    try:
        turn_id = await session.send("uzun iş")
        for _ in range(100):
            if sink.of(Message):
                break
            await asyncio.sleep(0.02)
        await session.interrupt()
        result = await session.wait_turn(turn_id, timeout=10)
        assert result.status == "interrupted"
        assert AgentState.interrupted in sink.states()
        assert session.state == AgentState.idle
        # the session keeps working after an interrupt
        second = await session.send("devam")
        assert (await session.wait_turn(second, timeout=10)).text == "ikinci"
    finally:
        await session.close()
    assert any(e.get("interrupted") is True for e in read_log(log))
    await session.interrupt()  # no-op after close


async def test_queued_send_runs_after_current_turn(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [{"op": "sleep", "seconds": 0.3}, _result(result="bir")],
            [_result(result="iki")],
        ]
    }
    _, session, sink, _, _, _, _ = await _start(tmp_path, scenario)
    try:
        first = await session.send("1")
        second = await session.send("2")  # queued locally, not written yet
        assert [t.turn_id for t in session._queue] == [second]
        r1 = await session.wait_turn(first, timeout=10)
        r2 = await session.wait_turn(second, timeout=10)
    finally:
        await session.close()
    assert (r1.text, r2.text) == ("bir", "iki")
    assert [t.turn_id for t in sink.of(TurnStarted)] == [first, second]
    assert [t.turn_id for t in sink.of(TurnCompleted)] == [first, second]


async def test_steer_folded_into_running_turn(tmp_path: Path) -> None:
    scenario = {"turns": [[{"op": "fold", "wait": 5}, _result(result="yönlendirme alındı")]]}
    _, session, sink, _, _, log, _ = await _start(tmp_path, scenario)
    try:
        turn_id = await session.send("başla")
        await asyncio.sleep(0.1)
        await session.steer("bunun yerine README'yi düzelt")
        result = await session.wait_turn(turn_id, timeout=10)
    finally:
        await session.close()
    assert result.text == "yönlendirme alındı"
    assert len(sink.of(TurnStarted)) == 1  # no extra turn
    steer_msgs = [m for m in sink.of(Message) if m.role == "user"]
    assert steer_msgs and steer_msgs[0].text == "bunun yerine README'yi düzelt"
    written = [e["in"] for e in read_log(log) if "in" in e and e["in"].get("type") == "user"]
    assert written[1]["priority"] == "next"


async def test_steer_not_folded_becomes_own_turn(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [{"op": "sleep", "seconds": 0.4}, _result(result="ilk")],
            [_result(result="yönlendirme turu")],
        ]
    }
    _, session, sink, _, _, _, _ = await _start(tmp_path, scenario)
    try:
        first = await session.send("başla")
        await asyncio.sleep(0.1)
        await session.steer("şunu da yap")
        await session.wait_turn(first, timeout=10)
        for _ in range(200):
            if len(sink.of(TurnCompleted)) >= 2:
                break
            await asyncio.sleep(0.02)
    finally:
        await session.close()
    starts = sink.of(TurnStarted)
    assert len(starts) == 2 and starts[1].input == "şunu da yap"
    completed = sink.of(TurnCompleted)
    assert completed[1].turn_id == starts[1].turn_id and completed[1].result_text == "yönlendirme turu"


async def test_steer_without_running_turn_starts_turn(tmp_path: Path) -> None:
    _, session, sink, _, _, _, _ = await _start(tmp_path, {"turns": [[_result(result="ok")]]})
    try:
        await session.steer("merhaba")
        result = await session.wait_turn(timeout=10)
    finally:
        await session.close()
    assert result.text == "ok"
    assert sink.of(TurnStarted)[0].input == "merhaba"


async def test_process_crash_mid_turn(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [
                _text_frame("msg_1", "çalışıyorum"),
                {"op": "stderr", "text": "fatal: something exploded"},
                {"op": "exit", "code": 3},
            ]
        ]
    }
    _, session, sink, _, _, _, _ = await _start(tmp_path, scenario)
    turn_id = await session.send("çök")
    result = await session.wait_turn(turn_id, timeout=10)
    assert result.status == "error"
    assert result.error is not None and "çıkış kodu 3" in result.error and "something exploded" in result.error
    errors = sink.of(AgentErrorEv)
    assert errors and errors[-1].code == "process_exit"
    ended = sink.of(SessionEnded)
    assert len(ended) == 1 and ended[0].reason == "error" and ended[0].exit_code == 3
    assert session.state == AgentState.error
    assert "something exploded" in session.stderr_tail
    with pytest.raises(Unavailable):
        await session.send("tekrar")
    await session.close()  # idempotent after death


async def test_malformed_lines_are_skipped(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [
                {"op": "raw", "line": "this is not json"},
                {"op": "raw", "line": "[1, 2, 3]"},
                {"op": "raw", "line": ""},
                {"op": "emit", "msg": {"type": "brand_new_type", "x": 1}},
                _result(result="sağlam"),
            ]
        ]
    }
    _, session, _, _, _, _, _ = await _start(tmp_path, scenario)
    try:
        await session.send("x")
        result = await session.wait_turn(timeout=10)
    finally:
        await session.close()
    assert result.status == "success" and result.text == "sağlam"


async def test_error_results(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [_result(subtype="error_max_turns", is_error=True, result="")],
            [_result(subtype="error_during_execution", is_error=True, errors=["API Error: 500"], result="")],
            [
                {
                    "op": "emit",
                    "msg": {
                        "type": "assistant",
                        "error": "rate_limit",
                        "message": {
                            "id": "m",
                            "role": "assistant",
                            "model": "<synthetic>",
                            "content": [{"type": "text", "text": "Limit reached"}],
                        },
                        "parent_tool_use_id": None,
                    },
                },
                _result(is_error=True, result="Claude AI usage limit reached"),
            ],
        ]
    }
    _, session, sink, _, _, _, _ = await _start(tmp_path, scenario)
    try:
        r1 = await session.wait_turn(await session.send("a"), timeout=10)
        r2 = await session.wait_turn(await session.send("b"), timeout=10)
        r3 = await session.wait_turn(await session.send("c"), timeout=10)
    finally:
        await session.close()
    assert r1.status == "max_turns"
    assert r2.status == "error" and r2.error == "API Error: 500"
    assert r3.status == "error" and r3.error == "Claude AI usage limit reached"
    api_errors = [e for e in sink.of(AgentErrorEv) if e.code == "rate_limit"]
    assert api_errors and api_errors[0].retryable
    assert not [m for m in sink.of(Message) if m.text == "Limit reached"]


async def test_permission_cancelled_by_cli(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [
                {"op": "permission", "tool": "Bash", "input": {"command": "sleep 100"}, "cancel_after": 0.2},
                _result(result="iptal edildi"),
            ]
        ]
    }
    perms = ScriptedPermissions(delay=30)
    _, session, _, _, _, log, _ = await _start(tmp_path, scenario, perms)
    try:
        await session.send("x")
        result = await session.wait_turn(timeout=10)
    finally:
        await session.close()
    assert result.text == "iptal edildi"
    assert perms.cancelled == 1
    assert not [e for e in read_log(log) if "decision" in e]


async def test_start_failure_reports_stderr(tmp_path: Path) -> None:
    adapter, _ = make_adapter(tmp_path, {"startup": {"stderr": "No conversation found with session ID", "exit": 1}})
    sink = RecordingSink()
    with pytest.raises(Unavailable, match="No conversation found"):
        await adapter.start(
            _spec(tmp_path, resume_native_id="11111111-2222-4333-8444-555555555555"),
            transport=LocalTestTransport(),
            sink=sink,
            tools=FakeToolHost(),
            permissions=ScriptedPermissions(),
        )
    assert [e.code for e in sink.of(AgentErrorEv)] == ["start_failed"]
    assert not sink.of(SessionStarted) and not sink.of(SessionEnded)
    assert adapter._live == {}


async def test_spawn_failure(tmp_path: Path) -> None:
    from aistudio.adapters.claude import ClaudeAdapter

    adapter = ClaudeAdapter(binary=str(tmp_path / "does-not-exist"))
    with pytest.raises(Unavailable, match="başlatılamadı"):
        await adapter.start(
            _spec(tmp_path),
            transport=LocalTestTransport(),
            sink=RecordingSink(),
            tools=FakeToolHost(),
            permissions=ScriptedPermissions(),
        )


async def test_wait_turn_errors(tmp_path: Path) -> None:
    _, session, _, _, _, _, _ = await _start(tmp_path, {"turns": [[{"op": "sleep", "seconds": 2}, _result()]]})
    try:
        with pytest.raises(NotFound):
            await session.wait_turn()
        with pytest.raises(NotFound):
            await session.wait_turn("turn_nope")
        turn_id = await session.send("x")
        with pytest.raises(TimeoutError):
            await session.wait_turn(turn_id, timeout=0.05)
    finally:
        await session.close()
    # closing interrupted the running turn
    assert (await session.wait_turn(turn_id, timeout=1)).status in ("interrupted", "error")


async def test_control_request_passthrough(tmp_path: Path) -> None:
    _, session, _, _, _, _, _ = await _start(tmp_path, {"turns": []})
    try:
        rules = await session.control("list_permission_rules")
        assert "mcp__studio" in rules["state"]["rules"]["allow"]
        from aistudio.adapters.claude import ClaudeControlError

        with pytest.raises(ClaudeControlError, match="unsupported"):
            await session.control("does_not_exist")
    finally:
        await session.close()


async def test_close_during_turn_settles_queue(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [{"op": "wait_interrupt", "timeout": 10, "then": [_result(result="")]}],
            [_result(result="hiç çalışmamalı")],
        ]
    }
    _, session, sink, _, _, log, _ = await _start(tmp_path, scenario)
    first = await session.send("1")
    second = await session.send("2")
    await asyncio.sleep(0.1)
    await asyncio.gather(session.close(), session.close())
    r1 = await session.wait_turn(first, timeout=1)
    r2 = await session.wait_turn(second, timeout=1)
    assert r1.status == "interrupted"
    assert r2.status == "error" and r2.error == "Oturum kapatıldı"
    written = [e for e in read_log(log) if "in" in e and e["in"].get("type") == "user"]
    assert len(written) == 1  # the queued turn was never sent
    ended = sink.of(SessionEnded)
    assert len(ended) == 1 and ended[0].reason == "closed"
    assert sink.states()[-1] == AgentState.done


async def test_cli_initiated_turn_is_reported(tmp_path: Path) -> None:
    scenario = {
        "after_initialize": [
            _text_frame("msg_bg", "Arka plan görevi bitti, sonuca bakıyorum."),
            _result(result="arka plan"),
        ],
        "turns": [],
    }
    _, session, sink, _, _, _, _ = await _start(tmp_path, scenario)
    try:
        for _ in range(200):
            if sink.of(TurnCompleted):
                break
            await asyncio.sleep(0.02)
    finally:
        await session.close()
    started = sink.of(TurnStarted)
    completed = sink.of(TurnCompleted)
    assert len(started) == 1 and started[0].input == ""
    assert completed[0].turn_id == started[0].turn_id and completed[0].result_text == "arka plan"
