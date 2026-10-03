"""CLI-native subagents (Agent/Task tool): tracker, live stream via the fake CLI, history replay."""

from __future__ import annotations

import asyncio
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from aistudio.adapters.claude.config import LaunchOptions, build_argv
from aistudio.adapters.claude.history import project_dir_name
from aistudio.adapters.claude.subagents import SubagentTracker, parse_task_notification
from aistudio.contracts.agents import (
    AgentEventPayload,
    Message,
    PermissionDecision,
    SessionSpec,
    SubagentCompleted,
    SubagentStarted,
    Thinking,
    ToolCall,
    ToolResultEv,
    TurnCompleted,
    Usage,
)

from .helpers import (
    FIXTURES,
    FakeToolHost,
    LocalTestTransport,
    RecordingSink,
    ScriptedPermissions,
    load_fixture_scenario,
    make_adapter,
    read_log,
)


def merged_starts(events: list[AgentEventPayload]) -> dict[str, SubagentStarted]:
    """SubagentStarted is an upsert: later non-null fields win."""
    out: dict[str, SubagentStarted] = {}
    for e in events:
        if isinstance(e, SubagentStarted):
            prev = out.get(e.subagent_id)
            update = {k: v for k, v in e.model_dump().items() if v is not None}
            out[e.subagent_id] = prev.model_copy(update=update) if prev else e
    return out


async def until(predicate: Callable[[], bool], timeout: float = 10.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)


async def _start(tmp_path: Path, scenario: dict[str, Any], perms: ScriptedPermissions | None = None):
    adapter, log = make_adapter(tmp_path, scenario)
    sink = RecordingSink()
    perms = perms or ScriptedPermissions()
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    session = await adapter.start(
        SessionSpec(provider="claude", cwd=str(work)),
        transport=LocalTestTransport(home=str(tmp_path / "home")),
        sink=sink,
        tools=FakeToolHost(),
        permissions=perms,
    )
    return session, sink, perms, log


# --------------------------------------------------------------------------- live stream


async def test_live_subagents_parallel_nested_permission_error_and_background(tmp_path: Path) -> None:
    session, sink, perms, log = await _start(tmp_path, load_fixture_scenario("scenario_subagents.json"))
    try:
        result = await session.wait_turn(await session.send("Alt ajanlarla incele"), timeout=20)
        assert result.status == "success" and result.text == "Alt ajanlar çalışıyor."
        # the background subagent finishes after the turn (system/task_notification)
        await until(lambda: any(isinstance(e, SubagentCompleted) and e.subagent_id == "toolu_bg" for e in sink.events))
    finally:
        await session.close()

    argv = read_log(log)[0]["argv"]
    assert "--forward-subagent-text" in argv

    starts = merged_starts(sink.events)
    assert set(starts) == {"toolu_explore", "toolu_fail", "toolu_nested", "toolu_bg"}
    explore = starts["toolu_explore"]
    assert (explore.name, explore.description, explore.parent_subagent_id, explore.parent_call_id) == (
        "Explore",
        "Testleri bul",
        None,
        "toolu_explore",
    )
    assert explore.prompt and explore.prompt.startswith("Depodaki test dosyalarını bul")
    assert explore.model == "claude-haiku-4-5"  # learned from the subagent's first frame
    assert starts["toolu_fail"].name == "general-purpose"  # from system/task_started
    nested = starts["toolu_nested"]
    assert nested.parent_subagent_id == "toolu_explore" and nested.model == "claude-haiku-4-5"  # alias resolved
    assert starts["toolu_bg"].name == "code-reviewer"

    done = {c.subagent_id: c for c in sink.of(SubagentCompleted)}
    assert len(sink.of(SubagentCompleted)) == 4  # once each
    ex = done["toolu_explore"]
    assert ex.status == "success" and ex.result_text == "İki test dosyası var: a.test.ts, b.test.ts"
    assert ex.usage is not None
    # summed over the subagent's own API calls (the CLI's totals cover only the last call)
    assert (ex.usage.input_tokens, ex.usage.output_tokens, ex.usage.cache_read_tokens, ex.usage.cache_write_tokens) == (
        4500,
        105,
        3000,
        100,
    )
    assert (ex.usage.context_used, ex.usage.duration_ms, ex.usage.turns) == (3025, 4200, 3)
    assert done["toolu_nested"].status == "success" and done["toolu_nested"].result_text == "test, lint, build"
    assert done["toolu_fail"].status == "error" and "529" in (done["toolu_fail"].result_text or "")
    bg = done["toolu_bg"]
    assert bg.status == "success" and bg.result_text == "İnceleme tamam: sorun yok."
    assert bg.usage is not None and (bg.usage.context_used, bg.usage.duration_ms) == (2050, 9000)
    # the background agent outlives its turn
    turn_done = next(i for i, e in enumerate(sink.events) if isinstance(e, TurnCompleted))
    assert sink.events.index(bg) > turn_done
    assert all(sink.events.index(done[s]) < turn_done for s in ("toolu_explore", "toolu_fail", "toolu_nested"))

    # payloads produced inside are tagged; the nested agent's own frames carry its id
    thinking = [t for t in sink.of(Thinking) if t.subagent_id == "toolu_explore"]
    assert [t.text for t in thinking] == ["Önce testleri listelemeliyim."]
    calls = {c.call_id: c for c in sink.of(ToolCall)}
    assert calls["toolu_sub_bash"].subagent_id == "toolu_explore"
    assert calls["toolu_nested"].subagent_id == "toolu_explore"
    assert (
        calls["toolu_explore"].subagent_id is None
        and calls["toolu_explore"].summary == "Alt ajan çalışıyor: Testleri bul"
    )
    results = {r.call_id: r for r in sink.of(ToolResultEv)}
    assert results["toolu_sub_bash"].subagent_id == "toolu_explore" and results["toolu_sub_bash"].exit_code == 0
    assert results["toolu_nested"].subagent_id == "toolu_explore"
    messages = {(m.subagent_id, m.text) for m in sink.of(Message)}
    assert {
        (None, "Alt ajanları başlatıyorum."),
        ("toolu_explore", "Testleri arıyorum."),
        ("toolu_nested", "test, lint, build"),
        ("toolu_bg", "İnceleme tamam: sorun yok."),
    } <= messages
    live = [u for u in sink.of(Usage) if u.subagent_id is not None]
    # running totals per subagent API call are live-only (partial); per-task sums skip them
    assert live and all(u.partial for u in live)
    explore_live = [u for u in live if u.subagent_id == "toolu_explore"]
    assert explore_live and explore_live[-1].input_tokens <= (ex.usage.input_tokens if ex.usage else 0)
    main_usage = [u for u in sink.of(Usage) if u.subagent_id is None]
    assert main_usage and main_usage[-1].input_tokens == 10  # the turn's own usage is untouched

    # announced before anything it produced
    first_start = next(
        i for i, e in enumerate(sink.events) if isinstance(e, SubagentStarted) and e.subagent_id == "toolu_explore"
    )
    first_tagged = next(
        i
        for i, e in enumerate(sink.events)
        if getattr(e, "subagent_id", None) == "toolu_explore" and not isinstance(e, SubagentStarted)
    )
    assert first_start < first_tagged

    # the permission request inside the explorer carries its subagent id
    (req,) = perms.requests
    assert req.tool == "Bash" and req.subagent_id == "toolu_explore"


async def test_permission_denied_inside_subagent_is_a_tagged_error(tmp_path: Path) -> None:
    perms = ScriptedPermissions(lambda r: PermissionDecision(allow=False, reason="politika", decided_by="policy"))
    session, sink, perms, _ = await _start(tmp_path, load_fixture_scenario("scenario_subagents.json"), perms)
    try:
        await session.wait_turn(await session.send("x"), timeout=20)
    finally:
        await session.close()
    (req,) = perms.requests
    assert req.subagent_id == "toolu_explore"
    denied = next(r for r in sink.of(ToolResultEv) if r.call_id == "toolu_sub_bash")
    assert denied.is_error and denied.subagent_id == "toolu_explore"


def _agent_frame(msg_id: str, block: dict[str, Any], parent: str | None) -> dict[str, Any]:
    return {
        "op": "emit",
        "msg": {
            "type": "assistant",
            "message": {"id": msg_id, "model": "claude-sonnet-4-5", "content": [block], "usage": {"input_tokens": 5}},
            "parent_tool_use_id": parent,
            "session_id": "$SESSION",
        },
    }


async def test_interrupted_turn_interrupts_foreground_subagents(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [
                _agent_frame(
                    "m1",
                    {
                        "type": "tool_use",
                        "id": "toolu_a",
                        "name": "Task",
                        "input": {"description": "Uzun iş", "prompt": "p"},
                    },
                    None,
                ),
                _agent_frame("s1", {"type": "text", "text": "çalışıyorum"}, "toolu_a"),
                {"op": "wait_interrupt", "timeout": 10, "then": [{"op": "result"}]},
            ]
        ]
    }
    session, sink, _, _ = await _start(tmp_path, scenario)
    try:
        turn = await session.send("başla")
        await until(lambda: any(isinstance(e, Message) and e.subagent_id == "toolu_a" for e in sink.events))
        await session.interrupt()
        result = await session.wait_turn(turn, timeout=10)
    finally:
        await session.close()
    assert result.status == "interrupted"
    (done,) = sink.of(SubagentCompleted)
    assert done.subagent_id == "toolu_a" and done.status == "interrupted" and done.result_text == "çalışıyorum"


async def test_process_exit_ends_background_subagents(tmp_path: Path) -> None:
    scenario = {
        "turns": [
            [
                _agent_frame(
                    "m1",
                    {
                        "type": "tool_use",
                        "id": "toolu_bg",
                        "name": "Agent",
                        "input": {"description": "Arka plan", "prompt": "p", "run_in_background": True},
                    },
                    None,
                ),
                {
                    "op": "emit",
                    "msg": {
                        "type": "user",
                        "message": {
                            "content": [
                                {
                                    "type": "tool_result",
                                    "tool_use_id": "toolu_bg",
                                    "content": "Async agent launched successfully.",
                                }
                            ]
                        },
                        "parent_tool_use_id": None,
                    },
                },
                {"op": "result"},
            ]
        ]
    }
    session, sink, _, _ = await _start(tmp_path, scenario)
    await session.wait_turn(await session.send("başla"), timeout=10)
    assert sink.of(SubagentCompleted) == []  # still running in the background
    await session.close()
    (done,) = sink.of(SubagentCompleted)
    assert done.subagent_id == "toolu_bg" and done.status == "interrupted"


def test_forward_subagent_text_flag_is_optional() -> None:
    spec = SessionSpec(provider="claude", cwd="/w")
    assert "--forward-subagent-text" in build_argv(["claude"], spec, session_id="s")
    off = build_argv(["claude"], spec, session_id="s", options=LaunchOptions(forward_subagent_text=False))
    assert "--forward-subagent-text" not in off


# --------------------------------------------------------------------------- tracker


def test_tracker_background_task_lifecycle_and_permission_lookup() -> None:
    t = SubagentTracker()
    (started,) = t.spawned(
        {"id": "toolu_1", "name": "Agent", "input": {"description": "d", "prompt": "p" * 5000, "model": "sonnet"}},
        parent=None,
    )
    assert started.prompt is not None and len(started.prompt) <= 2000 and started.model == "sonnet"
    assert t.permission_subagent(None, "agent-x") == "toolu_1"  # the only running one
    assert t.task_started({"task_id": "bash1", "tool_use_id": "toolu_bash", "task_type": "local_bash"}) == []
    renamed = t.task_started(
        {
            "task_id": "agent-x",
            "tool_use_id": "toolu_1",
            "task_type": "local_agent",
            "subagent_type": "Plan",
            "is_backgrounded": True,
        }
    )
    assert [s.name for s in renamed] == ["Plan"]
    t.spawned({"id": "toolu_2", "name": "Agent", "input": {"description": "e", "prompt": "q"}}, parent="toolu_1")
    assert t.permission_subagent(None, "agent-x") == "toolu_1"  # by agent id now
    assert t.permission_subagent(None, "unknown") is None  # two running: no guess
    t.note_call("toolu_inner", "toolu_2")
    assert t.permission_subagent("toolu_inner", None) == "toolu_2"
    assert (
        t.tool_result(
            "toolu_1", is_error=False, output="", structured={"status": "async_launched", "agentId": "agent-x"}
        )
        == []
    )
    # foreground cleanup at turn end leaves the background agent alone
    (fg,) = t.finish("interrupted", foreground_only=True)
    assert fg.subagent_id == "toolu_2"
    (killed,) = t.task_updated({"task_id": "agent-x", "patch": {"status": "killed"}})
    assert killed.subagent_id == "toolu_1" and killed.status == "interrupted"
    assert t.running() == []
    # a resumed agent (SendMessage) is announced again
    (again,) = t.task_started({"task_id": "agent-x", "tool_use_id": "toolu_1", "task_type": "local_agent"})
    assert again.subagent_id == "toolu_1"


def test_task_notification_text_parsing() -> None:
    text = (
        "<task-notification>\n<task-id>abc</task-id>\n<tool-use-id>toolu_9</tool-use-id>\n"
        '<status>failed</status>\n<summary>Agent "x" failed</summary>\n'
        "<result>This agent's report was delivered to you as a message</result>\n"
        "<usage><subagent_tokens>120</subagent_tokens><tool_uses>3</tool_uses><duration_ms>50</duration_ms></usage>\n"
        "</task-notification>"
    )
    fields = parse_task_notification(text)
    assert fields is not None and fields["tool-use-id"] == "toolu_9" and fields["status"] == "failed"
    assert parse_task_notification("normal prompt") is None
    t = SubagentTracker()
    t.spawned({"id": "toolu_9", "name": "Agent", "input": {"description": "x", "prompt": "y"}}, parent=None)
    (done,) = t.text_notification(text)
    assert done.status == "error" and done.result_text == 'Agent "x" failed'  # harness note is not a result
    assert done.usage is not None and (done.usage.context_used, done.usage.duration_ms) == (120, 50)


# --------------------------------------------------------------------------- history


SESSION_ID = "5e550000-0000-4000-8000-00000000c1a0"
SESSION_CWD = "/Users/dev/projects/shop"


async def test_history_replays_subagent_transcripts(tmp_path: Path) -> None:
    home = tmp_path / "home"
    project = home / ".claude" / "projects" / project_dir_name(SESSION_CWD)
    shutil.copytree(FIXTURES / "session_subagents", project)
    adapter, _ = make_adapter(tmp_path, {})
    payloads = await adapter.read_native_history(LocalTestTransport(home=str(home)), SESSION_ID, cwd=SESSION_CWD)

    starts = merged_starts(payloads)
    assert set(starts) == {"toolu_h_explore", "toolu_h_nested", "toolu_h_bg"}
    assert starts["toolu_h_nested"].parent_subagent_id == "toolu_h_explore"
    assert starts["toolu_h_explore"].model == "claude-haiku-4-5"
    done = {c.subagent_id: c for c in payloads if isinstance(c, SubagentCompleted)}
    assert done["toolu_h_explore"].status == "success"
    assert done["toolu_h_explore"].result_text == "İki test dosyası var: a.test.ts, b.test.ts"
    assert done["toolu_h_nested"].result_text == "test, lint, build"
    bg = done["toolu_h_bg"]  # ended by the <task-notification> queued command, once
    assert bg.status == "success" and bg.result_text == "Sorun bulunmadı."
    assert bg.usage is not None and bg.usage.duration_ms == 8000
    assert len([c for c in payloads if isinstance(c, SubagentCompleted)]) == 3

    # the explorer's transcript is spliced in before its result
    explore_calls = [c.call_id for c in payloads if isinstance(c, ToolCall) and c.subagent_id == "toolu_h_explore"]
    assert explore_calls == ["toolu_hx_bash", "toolu_h_nested"]
    result_index = next(
        i for i, e in enumerate(payloads) if isinstance(e, ToolResultEv) and e.call_id == "toolu_h_explore"
    )
    inside = [
        i
        for i, e in enumerate(payloads)
        if getattr(e, "subagent_id", None) == "toolu_h_explore"
        and not isinstance(e, SubagentStarted | SubagentCompleted)
    ]
    assert max(inside) < result_index < payloads.index(done["toolu_h_explore"])
    assert any(
        isinstance(e, ToolCall) and e.call_id == "toolu_hb_read" and e.subagent_id == "toolu_h_bg" for e in payloads
    )
    # prompts of subagents and task notifications are not turns; inline sidechains are skipped
    turns = [e for e in payloads if type(e).__name__ == "TurnStarted"]
    assert [t.input for t in turns] == ["Testleri alt ajanlarla incele", "Teşekkürler"]  # type: ignore[attr-defined]
    assert not any(isinstance(e, Message) and "eski biçim" in e.text for e in payloads)
    # main-turn usage counts the main agent only
    first_turn = next(e for e in payloads if isinstance(e, TurnCompleted))
    assert first_turn.usage is not None and first_turn.usage.input_tokens == 20 + 30 + 40 + 50
