"""Run control: cancellation, restart/resume, checkpoints, limit policies, concurrency and studio tools."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from engine_support import FINDINGS_PASS, EngineEnv, build_env, wait_for, writes

from aistudio.contracts.agents import AgentState
from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.contracts.flows import (
    AgentNodeConfig,
    FlowEdge,
    FlowGraph,
    FlowMode,
    FlowNode,
    FlowSettings,
    GateKind,
    GateNodeConfig,
    ParallelNodeConfig,
)
from aistudio.contracts.limits import LimitPolicy
from aistudio.contracts.tools import ToolContext
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.services import ServiceRegistry
from aistudio.engine.modes import build_mode_graph


def _node(node_id: str, **kw: Any) -> FlowNode:
    return FlowNode(id=node_id, label=node_id, config=AgentNodeConfig.model_validate(kw))


async def test_cancel_during_agent_turn_interrupts_session(env: EngineEnv) -> None:
    started = asyncio.Event()

    async def hang(_s: Any, _m: str) -> str:
        started.set()
        await asyncio.sleep(30)
        return "never"

    env.agents.on(hang, node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    await asyncio.wait_for(started.wait(), 5)
    await env.engine.cancel(run_id)
    run = await env.wait_run(run_id)
    assert run.status == "cancelled"
    assert run.nodes[-1].status == "cancelled"
    session = env.agents.by_node("dev")[0]
    assert session.interrupted
    t = await env.engine.get_task(task.id)
    assert t.status == "cancelled"
    assert "run.cancelled" in [ev.type for ev in await env.events(run_id)]


async def test_cancel_while_waiting_for_approval_cancels_it(env: EngineEnv) -> None:
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    approval = await env.next_approval(ApprovalKind.final)
    await env.wait_node(run_id, "final", ("waiting",))
    await env.wait_run(run_id, ("waiting",))
    assert (await env.engine.get_task(task.id)).status == "waiting"
    cancelled = await env.engine.cancel_task(task.id)
    assert cancelled.status == "cancelled"
    assert (await env.approvals.get(approval.id)).status == ApprovalStatus.cancelled


async def test_cancel_queued_task_and_finished_run_conflict(env: EngineEnv) -> None:
    from aistudio.core.errors import Conflict

    task = await env.create(FlowMode.single, start=False)
    assert task.status == "draft"
    assert (await env.engine.cancel_task(task.id)).status == "cancelled"
    with pytest.raises(Conflict, match="sona ermiş"):
        await env.engine.cancel_task(task.id)


async def _restart(
    env: EngineEnv, ctx: AppContext, git_repo: Path, tmp_path: Path, *, while_down: Any = None
) -> EngineEnv:
    """Simulate a studiod restart: stop the engine (state stays in the DB) and build a fresh one."""
    await env.engine.shutdown()
    if while_down is not None:
        while_down()
    new_ctx = AppContext(
        settings=ctx.settings,
        db=ctx.db,
        events=ctx.events,
        masker=ctx.masker,
        secrets=ctx.secrets,
        store=ctx.store,
        services=ServiceRegistry(),
    )
    return await build_env(new_ctx, git_repo, tmp_path, fakes=env)


async def test_restart_resumes_running_agent_node(
    env: EngineEnv, ctx: AppContext, git_repo: Path, tmp_path: Path
) -> None:
    gate = asyncio.Event()

    async def respond(session: Any, message: str) -> str:
        if len(session.messages) == 1:
            await gate.wait()  # the CLI dies with studiod in this turn
        env.worktrees.touch(session.req.worktree_id, "a.py")
        return "bitti"

    env.agents.on(respond, node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    await env.wait_node(run_id, "dev", ("running",))

    async def session_recorded() -> bool | None:
        run = await env.engine.get_run(run_id)
        return True if any(x.session_ids for x in run.nodes if x.node_id == "dev") else None

    await wait_for(session_recorded)
    session = env.agents.by_node("dev")[0]

    def cli_died() -> None:
        # the CLI process died with studiod: its in-flight turn is gone
        env.agents.handles[session.id].set_state(AgentState.idle)

    env2 = await _restart(env, ctx, git_repo, tmp_path, while_down=cli_died)
    try:
        run = await env2.engine.get_run(run_id)
        assert run.status in ("running", "waiting")
        await env2.decide(ApprovalKind.final)
        run = await env2.wait_run(run_id)
        assert run.status == "completed"
        # the same session was re-attached and asked to continue
        assert session.id in env.agents.handle_calls
        assert len(env.agents.by_node("dev")) == 1
        assert session.messages[1].startswith("AI Studio yeniden başlatıldı")
        assert "run.resumed" in [ev.type for ev in await env2.events(run_id)]
        assert [x.attempt for x in run.nodes if x.node_id == "dev"] == [1]
    finally:
        gate.set()
        await env2.engine.shutdown()


async def test_restart_reattaches_live_turn_and_pending_approval(
    env: EngineEnv, ctx: AppContext, git_repo: Path, tmp_path: Path
) -> None:
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    approval = await env.next_approval(ApprovalKind.final)
    env2 = await _restart(env, ctx, git_repo, tmp_path)
    try:
        # same approval is still the one the resumed node waits for
        await env2.approvals.decide(approval.id, approve=True)
        run = await env2.wait_run(run_id)
        assert run.status == "completed"
        finals = [x for x in run.nodes if x.node_id == "final"]
        assert len(finals) == 1 and finals[0].status == "passed"
        pending = await env2.approvals.list(status=ApprovalStatus.pending)
        assert pending == []
    finally:
        await env2.engine.shutdown()


async def test_checkpoint_restore_resumes_from_node(env: EngineEnv) -> None:
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    first_final = await env.next_approval(ApprovalKind.final)
    checkpoints = await env.engine.list_checkpoints(run_id)
    after_dev = next(c for c in checkpoints if c.node_id == "dev")
    assert after_dev.gitops_checkpoint_id is not None

    run = await env.engine.restore_checkpoint(run_id, after_dev.id)
    assert run.status == "running"
    assert env.worktrees.restored == [after_dev.gitops_checkpoint_id]
    assert env.memory.restored == ["mem0001"]
    assert (await env.approvals.get(first_final.id)).status == ApprovalStatus.cancelled
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    nodes = [x.node_id for x in run.nodes]
    assert nodes.count("dev") == 1  # dev was not re-run
    assert nodes.count("boundary") == 2 and nodes.count("build") == 2
    assert "checkpoint.restored" in [ev.type for ev in await env.events(run_id)]


async def test_limit_switch_provider(env: EngineEnv) -> None:
    env.limits.exhaust("claude", resets_at=utcnow() + timedelta(hours=2))
    graph = FlowGraph(
        nodes=[_node("dev", provider="claude", model="opus")],
        settings=FlowSettings(limit_policy=LimitPolicy(on_exhausted="switch_provider")),
    )
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    session = env.agents.by_node("dev")[0]
    assert session.provider == "codex" and session.req.spec.model is None
    assert run.nodes[0].data is not None and run.nodes[0].data["switched_from"] == "claude"
    assert len(await env.events(run.id, ["node.provider_switched"])) == 1


async def test_limit_switch_respects_cross_review_rule(env: EngineEnv) -> None:
    env.agents.add_profile("rev", "codex")
    env.limits.exhaust("claude")
    graph = FlowGraph(
        nodes=[
            _node("dev", provider="claude"),
            FlowNode(
                id="review",
                label="review",
                config=GateNodeConfig(gate=GateKind.cross_review, reviewer_profile_id="rev"),
            ),
        ],
        edges=[FlowEdge(id="e1", source="dev", target="review")],
        settings=FlowSettings(limit_policy=LimitPolicy(on_exhausted="switch_provider")),
    )
    env.agents.on(writes(env, "a.py"), node_id="dev")
    env.agents.on(FINDINGS_PASS, node_id="review")
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    # switching the author to codex would make the codex reviewer review its own provider: wait instead
    await env.wait_node(run_id, "dev", ("waiting",))
    assert not env.agents.by_node("dev")
    env.limits.restore("claude")
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert env.agents.by_node("dev")[0].provider == "claude"
    waits = await env.events(run_id, ["run.limit_wait"])
    assert len(waits) == 1 and waits[0].severity == "critical"


async def test_limit_queue_waits_for_reset(env: EngineEnv) -> None:
    def plan(_s: Any, _m: str) -> str:
        # the window fills up while the run is already going
        env.limits.exhaust("claude", resets_at=utcnow() + timedelta(minutes=5))
        return "plan"

    env.agents.on(plan, node_id="plan")
    env.agents.on(writes(env, "a.py"), node_id="dev")
    graph = FlowGraph(
        nodes=[_node("plan", provider="claude", writes=False), _node("dev", provider="claude")],
        edges=[FlowEdge(id="e", source="plan", target="dev")],
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    await env.wait_node(run_id, "dev", ("waiting",))
    await env.wait_run(run_id, ("waiting",))
    assert not env.agents.by_node("dev")
    env.limits.restore("claude")
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert env.agents.by_node("dev")[0].provider == "claude"


async def test_limit_ask_policy_budget_approval(env: EngineEnv) -> None:
    env.limits.exhaust("claude")
    graph = FlowGraph(
        nodes=[_node("dev", provider="claude")],
        settings=FlowSettings(limit_policy=LimitPolicy(on_exhausted="ask")),
    )
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    approval = await env.next_approval(ApprovalKind.budget)
    assert approval.payload["options"] == ["switch", "wait"]
    await env.decide(ApprovalKind.budget, payload={"action": "switch"})
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert env.agents.by_node("dev")[0].provider == "codex"


async def test_cross_review_same_provider_only_with_explicit_approval(env: EngineEnv) -> None:
    env.limits.exhaust("codex")
    graph = build_mode_graph(FlowMode.duo)
    graph.settings.limit_policy = LimitPolicy(on_exhausted="ask")
    graph.settings.gates.user_final = False
    env.agents.on(writes(env, "a.py"), node_id="dev")
    env.agents.on(FINDINGS_PASS, node_id="review")
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    approval = await env.next_approval(ApprovalKind.budget)
    assert approval.payload["options"][0] == "same_provider"
    await env.decide(ApprovalKind.budget, payload={"action": "same_provider"})
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    reviewer = env.agents.by_node("review")[0]
    assert reviewer.provider == "claude"
    gate = next(g for g in await env.engine.store.gate_results(run_id) if g.kind == "cross_review")
    assert gate.evidence["same_provider_approved_by"] == "user"


async def test_budget_exceeded_rejected_fails_node(env: EngineEnv) -> None:
    from aistudio.contracts.limits import Budget, BudgetCheck

    env.limits.budget["claude"] = BudgetCheck(ok=False, reason="5 saatlik pencerenin %20'si aşıldı.")
    graph = FlowGraph(
        nodes=[_node("dev", provider="claude")],
        settings=FlowSettings(limit_policy=LimitPolicy(on_exhausted="ask")),
    )
    task = await env.create(FlowMode.custom, graph=graph, budget=Budget(max_five_hour_percent=20))
    run_id = await env.run_of(task.id)
    approval = await env.next_approval(ApprovalKind.budget)
    assert "continue" in approval.payload["options"]
    await env.decide(ApprovalKind.budget, approve=False)
    run = await env.wait_run(run_id)
    assert run.status == "failed"
    assert run.nodes[0].error is not None and "bütçesi" in run.nodes[0].error


async def test_max_parallel_agents_is_respected(env: EngineEnv) -> None:
    target = {"n": 1}
    peak = asyncio.Event()

    async def slow(_s: Any, _m: str) -> str:
        # hold each turn until `target` sessions run at once (or briefly, when that can never happen)
        if env.agents.concurrent >= target["n"]:
            peak.set()
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(peak.wait(), 5 if target["n"] > 1 else 0.05)
        return "ok"

    env.agents.on(slow)
    graph = FlowGraph(
        nodes=[
            FlowNode(id="fork", label="fork", config=ParallelNodeConfig()),
            _node("a", writes=False),
            _node("b", writes=False),
            _node("c", writes=False),
        ],
        edges=[
            FlowEdge(id="1", source="fork", target="a"),
            FlowEdge(id="2", source="fork", target="b"),
            FlowEdge(id="3", source="fork", target="c"),
        ],
        settings=FlowSettings(max_parallel_agents=1),
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    assert env.agents.max_concurrent == 1

    env.agents.max_concurrent = 0
    target["n"] = 3
    peak.clear()
    graph.settings.max_parallel_agents = 3
    task2 = await env.create(FlowMode.custom, graph=graph)
    await env.wait_run(await env.run_of(task2.id))
    assert env.agents.max_concurrent == 3


async def test_studio_tools_inside_a_run(env: EngineEnv) -> None:
    async def agent(session: Any, _m: str) -> str:
        tctx = ToolContext(
            workspace_id=session.req.workspace_id,
            session_id=session.id,
            provider=session.provider,
            task_id=session.req.task_id,
            run_id=session.req.run_id,
            node_id=session.req.node_id,
            agent_label=session.req.label,
        )
        host = env.tools.bind(tctx)
        names = {s.name for s in host.specs()}
        assert {"ask_user", "report_status", "handoff", "evidence_submit"} <= names
        await host.call("report_status", {"status": "Testleri yazıyorum", "progress": 40})
        answer = await host.call("ask_user", {"question": "Hangi Python sürümü?", "options": ["3.12", "3.13"]})
        ev = await host.call(
            "evidence_submit", {"title": "Yerel test çıktısı", "content": "5 passed", "kind": "output"}
        )
        assert not ev.is_error
        await host.call("handoff", {"to": "İnceleyen", "reason": "Kod hazır"})
        env.worktrees.touch(session.req.worktree_id, "a.py")
        return f"Cevap: {answer.content}"

    env.agents.on(agent, node_id="dev")
    graph = FlowGraph(nodes=[_node("dev")])
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    question = await env.next_approval(ApprovalKind.question)
    assert question.payload["options"] == ["3.12", "3.13"]
    assert question.requested_by.startswith("agent:")
    await env.wait_node(run_id, "dev", ("waiting",))
    await env.decide(ApprovalKind.question, payload={"answer": "3.13"})
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert run.nodes[0].output == "Cevap: 3.13"
    evidence = await env.engine.store.evidence(run_id=run_id)
    agent_ev = [e for e in evidence if e.source == "agent"]
    assert len(agent_ev) == 1 and agent_ev[0].node_run_id == run.nodes[0].id
    assert "kapı kanıtı değildir" in agent_ev[0].label
    events = await env.events(run_id)
    types = [e.type for e in events]
    assert "node.progress" in types and "agent.handoff" in types and "evidence.submitted" in types
    handoff = next(e for e in events if e.type == "agent.handoff")
    assert handoff.payload["to"] == "İnceleyen" and handoff.payload["from"] == "dev"


async def test_evidence_submit_outside_run_is_rejected(env: EngineEnv) -> None:
    tool = env.tools.get("evidence_submit")
    result = await tool(
        ToolContext(workspace_id=env.workspace.id, session_id="s", provider="claude"), {"title": "x", "content": "y"}
    )
    assert result.is_error
