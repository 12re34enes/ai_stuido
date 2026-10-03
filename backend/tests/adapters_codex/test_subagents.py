"""Codex sub-agents: live sub-agent threads on the session's app-server, collab/v2 items,
approvals inside sub-agents, shutdown and history import."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from aistudio.adapters.codex import protocol as p
from aistudio.adapters.codex.subagents import CodexSubagents, thread_name
from aistudio.contracts.agents import (
    AgentEventPayload,
    Message,
    MessageDelta,
    SessionSpec,
    SubagentCompleted,
    SubagentStarted,
    ToolCall,
    ToolResultEv,
    Usage,
)

from .conftest import MakeHarness, Permissions, RecordingSink, load_scenario

MAIN = "019a7a10-0000-7000-8000-00000000c001"
S1 = "019a7a10-5ab1-7000-8000-00000000c101"
S2 = "019a7a10-5ab2-7000-8000-00000000c102"
S3 = "019a7a10-5ab3-7000-8000-00000000c103"
S4 = "019a7a10-5ab4-7000-8000-00000000c104"


def merged_starts(events: list[AgentEventPayload]) -> dict[str, SubagentStarted]:
    """SubagentStarted is an upsert: later non-null fields win."""
    out: dict[str, SubagentStarted] = {}
    for e in events:
        if isinstance(e, SubagentStarted):
            prev = out.get(e.subagent_id)
            if prev is None:
                out[e.subagent_id] = e
            else:
                update = {k: v for k, v in e.model_dump().items() if v is not None}
                out[e.subagent_id] = prev.model_copy(update=update)
    return out


def tagged(events: list[AgentEventPayload], sid: str) -> list[AgentEventPayload]:
    return [
        e
        for e in events
        if getattr(e, "subagent_id", None) == sid and not isinstance(e, SubagentStarted | SubagentCompleted)
    ]


async def _start(make_harness: MakeHarness, workdir: Path, scenario: Any, perms: Permissions | None = None):
    h = make_harness(scenario)
    sink = RecordingSink()
    perms = perms or Permissions()
    from .conftest import FakeToolHost

    session = await h.adapter.start(
        SessionSpec(provider="codex", cwd=str(workdir)),
        transport=h.transport,
        sink=sink,
        tools=FakeToolHost(),
        permissions=perms,
    )
    return h, session, sink, perms


async def test_live_subagents_nested_parallel_v2_and_approvals(make_harness: MakeHarness, workdir: Path) -> None:
    h, session, sink, perms = await _start(make_harness, workdir, "subagents")
    try:
        result = await session.wait_turn(await session.send("alt ajanlarla çalış"), timeout=15)
        assert result.status == "success" and result.text == "Alt ajanlar bitti."

        def enriched() -> bool:
            starts = merged_starts(sink.events)
            return all(starts.get(s) is not None and starts[s].name for s in (S1, S2, S3, S4))

        await sink.wait_for(enriched)
    finally:
        await session.close()

    starts = merged_starts(sink.events)
    assert set(starts) == {S1, S2, S3, S4}
    s1, s2, s3, s4 = starts[S1], starts[S2], starts[S3], starts[S4]
    # names come from thread/read (role, else nickname) and v2 agent paths
    assert (s1.name, s2.name, s3.name, s4.name) == ("explorer", "worker", "Kepler", "reviewer")
    assert s1.parent_subagent_id is None and s1.parent_call_id == "call_spawn_1"
    assert s1.prompt == "Depoyu incele ve test komutlarını bul" and s1.model == "gpt-5.5-mini"
    assert s1.description == "Depoyu incele ve test komutlarını bul"
    assert s2.parent_call_id == "call_spawn_2" and s2.parent_subagent_id is None
    assert s3.parent_subagent_id == S1 and s3.parent_call_id == "call_spawn_3"  # nested
    assert s4.parent_call_id == "call_v2" and s4.parent_subagent_id is None

    completed = sink.of(SubagentCompleted)
    assert sorted(c.subagent_id for c in completed) == sorted([S1, S2, S3, S4])  # exactly once each
    by_id = {c.subagent_id: c for c in completed}
    assert by_id[S1].status == "success" and by_id[S1].result_text == "İki test dosyası var: a.test.ts, b.test.ts"
    s1_usage = by_id[S1].usage
    assert s1_usage is not None
    assert (s1_usage.input_tokens, s1_usage.cache_read_tokens, s1_usage.output_tokens) == (
        2000,
        1000,
        200,
    )
    assert by_id[S2].status == "error" and by_id[S2].result_text == "Model isteği başarısız oldu"
    assert by_id[S3].status == "success" and by_id[S3].result_text == "test, lint, build"
    assert by_id[S4].status == "success" and by_id[S4].result_text == "İnceleme bitti, sorun yok"

    # every sub-agent payload is tagged; main-thread payloads are not
    s1_payloads = tagged(sink.events, S1)
    assert any(isinstance(e, MessageDelta) and e.text == "Testleri arıyorum" for e in s1_payloads)
    calls = {c.call_id: c for c in sink.of(ToolCall)}
    assert calls["s1_cmd"].subagent_id == S1 and calls["call_spawn_3"].subagent_id == S1
    assert calls["call_spawn_1"].subagent_id is None
    assert (calls["call_spawn_1"].summary or "").startswith("Alt ajan başlatılıyor")
    assert calls["call_wait"].subagent_id is None
    results = {r.call_id: r for r in sink.of(ToolResultEv)}
    assert results["s1_cmd"].subagent_id == S1 and "a.test.ts" in results["s1_cmd"].output
    assert "hata verdi" in results["call_wait"].output
    assert [u for u in sink.of(Usage) if u.subagent_id is not None] == []  # only in SubagentCompleted
    s3_usage = by_id[S3].usage
    assert s3_usage is not None and s3_usage.input_tokens == 300 and s3_usage.subagent_id == S3
    main_messages = [m for m in sink.of(Message) if m.subagent_id is None]
    assert [m.text for m in main_messages] == ["Alt ajanlar bitti."]

    # the sub-agent is announced before anything it produced
    first_start = next(i for i, e in enumerate(sink.events) if isinstance(e, SubagentStarted) and e.subagent_id == S1)
    first_payload = next(i for i, e in enumerate(sink.events) if e in s1_payloads)
    assert first_start < first_payload

    # the approval inside the explorer reaches the handler with sub-agent context
    (req,) = perms.requests
    assert req.subagent_id == S1 and req.command == "/bin/zsh -lc 'npm test -- --list'"
    # enrichment used thread/read on the sub-agent threads
    read_ids = {m["params"]["threadId"] for m in h.sent("thread/read")}
    assert {S1, S2, S3} <= read_ids


async def test_running_subagents_are_interrupted_when_the_session_closes(
    make_harness: MakeHarness, workdir: Path
) -> None:
    scenario = load_scenario("subagents")
    script = scenario["turnScripts"][0]
    scenario["turnScripts"] = [[*script[:4], {"waitInterrupt": True}]]  # spawn S1, then hang
    _h, session, sink, _ = await _start(make_harness, workdir, scenario)
    await session.send("uzun iş")
    await sink.wait_for(lambda: any(isinstance(e, SubagentStarted) for e in sink.events))
    await session.close()
    (done,) = sink.of(SubagentCompleted)
    assert done.subagent_id == S1 and done.status == "interrupted"


async def test_history_import_replays_subagent_threads(make_harness: MakeHarness) -> None:
    h = make_harness("subagents_history")
    main = "019a7a10-0000-7000-8000-00000000d001"
    hs1, hs2, hs3 = (
        "019a7a10-5ab1-7000-8000-00000000d101",
        "019a7a10-5ab2-7000-8000-00000000d102",
        "019a7a10-5ab3-7000-8000-00000000d103",
    )
    payloads = await h.adapter.read_native_history(h.transport, main)
    starts = merged_starts(payloads)
    assert set(starts) == {hs1, hs2, hs3}
    assert starts[hs1].name == "explorer" and starts[hs1].parent_call_id == "h_spawn1"
    assert starts[hs2].parent_subagent_id == hs1 and starts[hs2].name == "Kepler"
    assert starts[hs3].parent_subagent_id is None and starts[hs3].prompt == "Belgeleri tara"
    done = {c.subagent_id: c for c in payloads if isinstance(c, SubagentCompleted)}
    assert done[hs1].status == "success" and done[hs1].result_text == "İki test dosyası var"
    assert done[hs2].status == "success" and done[hs2].result_text == "test, lint, build"
    assert done[hs3].status == "interrupted"  # never readable, never waited for
    hs1_calls = [e for e in payloads if isinstance(e, ToolCall) and e.subagent_id == hs1]
    assert [c.call_id for c in hs1_calls] == ["hs1_cmd", "hs1_spawn"]
    # the sub-agent's prompt is not repeated as a user message; its answer is tagged
    assert not any(isinstance(e, Message) and e.role == "user" and e.subagent_id for e in payloads)
    assert any(isinstance(e, Message) and e.subagent_id == hs2 and e.text == "test, lint, build" for e in payloads)
    # sub-agent work is replayed where it was spawned: before the parent's wait
    wait_index = next(i for i, e in enumerate(payloads) if isinstance(e, ToolCall) and e.call_id == "h_wait")
    hs1_last = max(i for i, e in enumerate(payloads) if getattr(e, "subagent_id", None) == hs1)
    assert hs1_last < wait_index
    # sub-agent threads are never listed as sessions of their own
    listed = await h.adapter.list_native_sessions(h.transport)
    assert [s.native_id for s in listed] == [main]


def _thread(tid: str, **kw: Any) -> p.Thread:
    return p.Thread.model_validate({"id": tid, "cwd": "/w", **kw})


def test_parallel_spawns_adopted_out_of_order_are_fixed_by_completion() -> None:
    subs = CodexSubagents("main")

    def spawn(call: str, status: str, receivers: list[str], prompt: str) -> p.CollabAgentToolCallItem:
        return p.CollabAgentToolCallItem(
            id=call,
            tool="spawnAgent",
            status=status,
            sender_thread_id="main",
            receiver_thread_ids=receivers,
            prompt=prompt,
        )

    subs.collab_started(spawn("c1", "inProgress", [], "birinci"), "main")
    subs.collab_started(spawn("c2", "inProgress", [], "ikinci"), "main")
    # the second spawn's thread starts first: FIFO adoption guesses wrong
    sub_b, started = subs.adopt("thread-b", activity=False)
    assert sub_b is not None and started[0].parent_call_id == "c1"
    fixed = subs.collab_completed(spawn("c2", "completed", ["thread-b"], "ikinci"), "main")
    assert [(s.subagent_id, s.parent_call_id, s.prompt) for s in fixed if isinstance(s, SubagentStarted)] == [
        ("thread-b", "c2", "ikinci")
    ]
    # the freed spawn goes to the next unknown thread
    sub_a, started_a = subs.adopt("thread-a", activity=False)
    assert sub_a is not None and started_a[0].parent_call_id == "c1" and started_a[0].prompt == "birinci"
    # a bare status change of an unrelated thread is not adopted without a pending spawn
    assert subs.adopt("thread-x", activity=False) == (None, [])
    assert subs.adopt("main", activity=True) == (None, [])


def test_agent_states_resume_and_names() -> None:
    subs = CodexSubagents("main")
    subs.adopt("t1", activity=True)
    assert subs.agent_state("t1", {"status": "running"}) == []
    (done,) = subs.agent_state("t1", {"status": "completed", "message": "bitti"})
    assert done.status == "success" and done.result_text == "bitti"
    assert subs.agent_state("t1", {"status": "completed", "message": "bitti"}) == []  # once
    # new input to a finished sub-agent re-opens it
    (again,) = subs.turn_started("t1")
    assert again.subagent_id == "t1"
    (closed,) = subs.closed("t1")
    assert closed.status == "interrupted"
    assert thread_name(_thread("x", agentRole="default", agentNickname="Ada")) == "Ada"
    assert thread_name(_thread("x", agentRole="explorer", agentNickname="Ada")) == "explorer"
    assert thread_name(_thread("x", source={"subAgent": "review"})) == "review"
    assert thread_name(_thread("x")) is None
