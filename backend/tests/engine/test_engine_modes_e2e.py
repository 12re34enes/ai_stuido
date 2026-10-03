"""End-to-end runs of the five built-in modes with fake agents and worktrees."""

from __future__ import annotations

import re
from typing import Any

from engine_support import FINDINGS_PASS, EngineEnv, findings_json, writes

from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.contracts.flows import FlowMode


async def test_single_mode_end_to_end(env: EngineEnv) -> None:
    env.agents.on(writes(env, "README.md", reply="README güncellendi; testler geçti."), node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    final = await env.next_approval(ApprovalKind.final)
    assert final.title.startswith("Son onay")
    assert final.run_id == run_id and final.task_id == task.id
    assert "Build/test kanıtı: geçti" in (final.summary or "")
    assert final.payload["diffstat"][0]["files"][0]["path"] == "README.md"
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id)
    assert run.status == "completed"

    latest = {n.node_id: n for n in run.nodes}
    assert [latest[n].status for n in ("dev", "boundary", "build", "final")] == ["passed"] * 4
    dev = latest["dev"]
    assert dev.data is not None and dev.data["changed_files"] == ["README.md"]
    assert dev.data["provider"] == "claude"
    assert dev.worktree_ids and dev.session_ids

    # studiod ran the repo commands itself, in the agent's worktree
    assert [c for _w, c in env.worktrees.commands] == ["ruff check", "pytest -q"]
    gates = await env.engine.store.gate_results(run_id)
    build = next(g for g in gates if g.kind == "build_test")
    assert build.status == "passed" and build.decided_by == "studiod"
    assert {c["name"] for c in build.evidence["commands"]} == {"lint", "test"}
    assert all("duration_ms" in c and c["exit_code"] == 0 for c in build.evidence["commands"])

    # the commit was made by studiod with a meaningful message
    assert env.worktrees.commits and "Kurulum belgesi" in env.worktrees.commits[0][1]

    task_after = await env.engine.get_task(task.id)
    assert task_after.status == "completed"
    assert task_after.quality_score is not None and task_after.quality_score > 90

    types = [e.type for e in await env.events(run_id)]
    for t in ("run.started", "node.started", "node.completed", "gate.passed", "checkpoint.created", "run.completed"):
        assert t in types, t
    checkpoints = await env.engine.list_checkpoints(run_id)
    assert {c.node_id for c in checkpoints} >= {"dev", "boundary", "build", "final"}
    assert checkpoints[0].refs and checkpoints[0].memory_commit == "mem0001"


async def test_duo_review_fails_twice_then_passes(env: EngineEnv) -> None:
    env.agents.on(writes(env, "app.py"), node_id="dev")
    reviews = iter(
        [
            findings_json(("high", "Girdi doğrulanmıyor"), ("low", "İsimlendirme")),
            findings_json(("critical", "SQL enjeksiyonu")),
            FINDINGS_PASS,
        ]
    )
    env.agents.on(lambda _s, _m: next(reviews), node_id="review")
    task = await env.create(FlowMode.duo)
    run_id = await env.run_of(task.id)
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id)
    assert run.status == "completed"

    dev_runs = [n for n in run.nodes if n.node_id == "dev"]
    review_runs = [n for n in run.nodes if n.node_id == "review"]
    assert [n.attempt for n in dev_runs] == [1, 2, 3]
    assert [n.status for n in review_runs] == ["failed", "failed", "passed"]

    # the author keeps its session and gets the blocking findings as feedback
    dev_sessions = env.agents.by_node("dev")
    assert len(dev_sessions) == 1
    msgs = dev_sessions[0].messages
    assert len(msgs) == 3
    assert "Girdi doğrulanmıyor" in msgs[1] and "tur 1" in msgs[1]
    assert "SQL enjeksiyonu" in msgs[2]

    # reviewer is the other provider, read-only, sees the diff and earlier findings
    review_sessions = env.agents.by_node("review")
    assert {s.provider for s in review_sessions} == {"codex"}
    assert review_sessions[0].req.spec.boundaries.sandbox == "read_only"
    assert "```diff" in review_sessions[0].messages[0]
    assert "Önceki turun bulguları" in review_sessions[0].messages[1]

    gates = [g for g in await env.engine.store.gate_results(run_id) if g.kind == "cross_review"]
    assert gates[0].evidence["author_provider"] == "claude"
    assert gates[0].evidence["reviewer_provider"] == "codex"
    assert gates[0].evidence["blocking_count"] == 1
    assert gates[0].decided_by == "agent:codex"
    loops = [e for e in await env.events(run_id, ["run.loop"])]
    assert [e.payload["round"] for e in loops] == [1, 2]
    detail = await env.engine.task_detail(task.id)
    assert detail.quality is not None
    rework = next(c for c in detail.quality.components if c.key == "rework")
    assert rework.raw["loops"] == 2


async def test_duo_loop_exhaustion_fails_run(env: EngineEnv) -> None:
    env.agents.on(writes(env, "app.py"), node_id="dev")
    env.agents.on(findings_json(("high", "Hâlâ hatalı")), node_id="review")
    task = await env.create(FlowMode.duo)
    run_id = await env.run_of(task.id)
    run = await env.wait_run(run_id)
    assert run.status == "failed"
    reviews = [n for n in run.nodes if n.node_id == "review"]
    assert len(reviews) == 4  # first attempt + max_rounds (3) loop-backs
    exhausted = await env.events(run_id, ["gate.loop_exhausted"])
    assert len(exhausted) == 1 and exhausted[0].severity == "high"
    assert exhausted[0].payload["max_rounds"] == 3
    final = [n for n in run.nodes if n.node_id == "final"]
    assert final and final[-1].status == "skipped"
    t = await env.engine.get_task(task.id)
    assert t.status == "failed"
    assert "Tur sınırı aşıldı" in ((await env.engine.task_detail(task.id)).error or "")


async def test_pipeline_with_plan_edit(env: EngineEnv) -> None:
    plan_reply = (
        "Plan:\n1. Modülü ekle\n2. Testleri yaz\n\n```json\n"
        '{"summary": "Modül + test", "steps": [{"title": "Modül", "detail": "x", "files": ["m.py"]}], "risks": []}\n```'
    )
    env.agents.on(plan_reply, node_id="plan")
    env.agents.on(writes(env, "m.py"), node_id="dev")
    env.agents.on(FINDINGS_PASS, node_id="review")
    env.agents.on(writes(env, "test_m.py", reply="Testler eklendi."), node_id="test")
    task = await env.create(FlowMode.pipeline)
    run_id = await env.run_of(task.id)

    plan_approval = await env.next_approval(ApprovalKind.plan)
    assert plan_approval.payload["structured"]["summary"] == "Modül + test"
    assert plan_approval.summary == "Modül + test"
    assert "```json" not in plan_approval.payload["plan"]
    await env.decide(ApprovalKind.plan, payload={"plan": "DÜZENLENMİŞ PLAN: önce testler"})
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id)
    assert run.status == "completed"

    dev_prompt = env.agents.by_node("dev")[0].messages[0]
    assert "DÜZENLENMİŞ PLAN: önce testler" in dev_prompt
    # the edited plan replaces the planner output for everything downstream
    review_prompt = env.agents.by_node("review")[0].messages[0]
    assert "DÜZENLENMİŞ PLAN" in review_prompt
    planner = env.agents.by_node("plan")[0]
    assert planner.req.spec.role == "planner" and planner.req.worktree_id is None
    assert planner.req.spec.boundaries.sandbox == "read_only"
    # the tester continues in the developer's worktree
    dev_wt = env.agents.by_node("dev")[0].req.worktree_id
    assert env.agents.by_node("test")[0].req.worktree_id == dev_wt
    build = next(g for g in await env.engine.store.gate_results(run_id) if g.kind == "build_test")
    assert build.evidence["commands"][0]["worktree_id"] == dev_wt
    plan_gate = next(g for g in await env.engine.store.gate_results(run_id) if g.kind == "plan_approval")
    assert plan_gate.evidence["edited"] is True and plan_gate.decided_by == "user"


async def test_pipeline_plan_rejection_loops_to_planner(env: EngineEnv) -> None:
    env.agents.on('Plan\n```json\n{"summary": "s", "steps": ["a"]}\n```', node_id="plan")
    env.agents.on(writes(env, "m.py"), node_id="dev")
    env.agents.on(FINDINGS_PASS, node_id="review")
    env.agents.on("ok", node_id="test")
    task = await env.create(FlowMode.pipeline)
    run_id = await env.run_of(task.id)
    await env.decide(ApprovalKind.plan, approve=False, note="Önce veritabanı şemasını planla")
    await env.decide(ApprovalKind.plan)
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    planner = env.agents.by_node("plan")
    assert len(planner) == 1 and len(planner[0].messages) == 2
    assert "Önce veritabanı şemasını planla" in planner[0].messages[1]


async def test_race_user_picks_winner(env: EngineEnv) -> None:
    env.agents.on(writes(env, "a.py", reply="A çözümü"), node_id="dev_a")
    env.agents.on(writes(env, "b.py", "b2.py", reply="B çözümü"), node_id="dev_b")
    task = await env.create(FlowMode.race)
    run_id = await env.run_of(task.id)
    choice = await env.next_approval(ApprovalKind.custom)
    assert choice.payload["type"] == "compare"
    candidates = {c["node_id"]: c for c in choice.payload["candidates"]}
    assert set(candidates) == {"dev_a", "dev_b"}
    assert candidates["dev_b"]["gates"]["build_test"]["status"] == "passed"
    assert candidates["dev_a"]["provider"] == "claude" and candidates["dev_b"]["provider"] == "codex"
    await env.decide(ApprovalKind.custom, payload={"winner": "dev_b"}, note="B daha kapsamlı")
    run = await env.wait_run(run_id)
    assert run.status == "completed"

    compare = next(n for n in run.nodes if n.node_id == "compare")
    assert compare.data is not None and compare.data["winner"] == "dev_b"
    wt_a = env.agents.by_node("dev_a")[0].req.worktree_id
    wt_b = env.agents.by_node("dev_b")[0].req.worktree_id
    assert env.worktrees.removed == [wt_a]  # loser abandoned
    assert [m["worktree_id"] for m in env.worktrees.merges] == [wt_b]  # winner merged
    assert env.worktrees.merges[0]["strategy"] == "squash"
    assert len(env.worktrees.commands) == 4  # build/test ran on both candidates


async def test_race_agent_judge(env: EngineEnv) -> None:
    from aistudio.engine.modes import build_mode_graph

    graph = build_mode_graph(FlowMode.race)
    compare = graph.node("compare")
    assert compare.config.kind == "compare"
    compare.config.judge = "agent"  # type: ignore[union-attr]
    env.agents.on(writes(env, "a.py"), node_id="dev_a")
    env.agents.on(writes(env, "b.py"), node_id="dev_b")
    env.agents.on('Karar\n```json\n{"winner": "dev_a", "rationale": "Daha sade"}\n```', node_id="compare")
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    node = next(n for n in run.nodes if n.node_id == "compare")
    assert node.data is not None
    assert node.data["winner"] == "dev_a" and node.data["rationale"] == "Daha sade"
    assert node.data["decided_by"].startswith("agent:")
    judge = env.agents.by_node("compare")[0]
    assert judge.req.spec.role == "judge" and "dev_b" in judge.messages[0]


async def test_council_decision_and_memory_proposal(env: EngineEnv) -> None:
    env.agents.on("Görüş A: monolit ile başla.", node_id="advisor_a")
    env.agents.on("Görüş B: servislere böl.", node_id="advisor_b")
    decision = (
        "# Monolit ile başlama kararı\n\n## Bağlam\nx\n\n## Seçenekler\ny\n\n## Karar\nMonolit.\n\n"
        "## Gerekçe\nz\n\n## Riskler\nr\n\n## Sonraki adımlar\ns"
    )

    def synth(session: Any, message: str) -> str:
        if session.req.spec.role == "advisor":  # devil's advocate turn
            return "Karşı tez: ölçeklenme riski."
        return decision

    env.agents.on(synth, node_id="synthesis")
    task = await env.create(FlowMode.council, prompt="Mimari: monolit mi mikroservis mi?")
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    node = next(n for n in run.nodes if n.node_id == "synthesis")
    assert node.output is not None and node.output.startswith("# Monolit ile başlama kararı")
    assert node.data is not None and node.data["counter_thesis"] == "Karşı tez: ölçeklenme riski."
    sessions = env.agents.by_node("synthesis")
    devil = next(s for s in sessions if s.req.spec.role == "advisor")
    synthesizer = next(s for s in sessions if s.req.spec.role == "synthesizer")
    assert devil.provider == "codex" and synthesizer.provider == "claude"
    assert "Görüş A" in synthesizer.messages[0] and "Karşı tez" in synthesizer.messages[0]
    for heading in ("## Bağlam", "## Seçenekler", "## Karar", "## Gerekçe", "## Riskler", "## Sonraki adımlar"):
        assert heading in synthesizer.messages[0]
    # advisors are read-only and keep their perspective
    advisor = env.agents.by_node("advisor_a")[0]
    assert advisor.req.spec.role == "advisor" and advisor.req.spec.boundaries.sandbox == "read_only"
    assert "Bakış açın" in advisor.messages[0]
    assert len(env.memory.proposals) == 1
    proposal = env.memory.proposals[0]
    assert re.fullmatch(r"decisions/\d{4}-\d{2}-\d{2}-monolit-ile-baslama-karari\.md", proposal.path)
    assert proposal.new_content.startswith("# Monolit")
    assert node.data["memory_path"] == proposal.path


async def test_council_decision_missing_sections_are_completed(env: EngineEnv) -> None:
    env.agents.on("A", node_id="advisor_a")
    env.agents.on("B", node_id="advisor_b")
    env.agents.on("Sadece karar: monolit.", node_id="synthesis")
    task = await env.create(FlowMode.council)
    run = await env.wait_run(await env.run_of(task.id))
    node = next(n for n in run.nodes if n.node_id == "synthesis")
    assert node.output is not None
    assert node.output.startswith("# Kurulum belgesi")
    assert "## Sonraki adımlar" in node.output
    # one extra turn asked the synthesizer to restructure
    synth = next(s for s in env.agents.by_node("synthesis") if s.req.spec.role == "synthesizer")
    assert len(synth.messages) == 2 and "eksik" in synth.messages[1]


async def test_final_rejection_loops_back_with_note(env: EngineEnv) -> None:
    env.agents.on(writes(env, "README.md"), node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    first = await env.decide(ApprovalKind.final, approve=False, note="Türkçe karakterleri düzelt")
    assert first.status == ApprovalStatus.rejected
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert "Türkçe karakterleri düzelt" in env.agents.by_node("dev")[0].messages[1]
