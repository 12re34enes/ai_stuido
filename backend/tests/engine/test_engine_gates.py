"""Gates and the non-agent node kinds: boundary check, build/test evidence, cross review rules, merge,
git, deploy, human, condition, join and disabled gates."""

from __future__ import annotations

from typing import Any

from engine_support import FINDINGS_PASS, EngineEnv, findings_json, writes

from aistudio.contracts.agents import Boundaries
from aistudio.contracts.approvals import ApprovalKind
from aistudio.contracts.common import Environment
from aistudio.contracts.flows import (
    AgentNodeConfig,
    ConditionNodeConfig,
    DeployNodeConfig,
    FlowEdge,
    FlowGraph,
    FlowMode,
    FlowNode,
    FlowSettings,
    GateKind,
    GateNodeConfig,
    GateToggles,
    GitNodeConfig,
    HumanNodeConfig,
    JoinNodeConfig,
    MergeNodeConfig,
    NodeConfig,
    ParallelNodeConfig,
)
from aistudio.engine.modes import build_mode_graph


def n(node_id: str, config: NodeConfig, label: str | None = None) -> FlowNode:
    return FlowNode(id=node_id, label=label or node_id, config=config)


def e(src: str, dst: str, cond: str = "default") -> FlowEdge:
    return FlowEdge(id=f"{src}-{dst}-{cond}", source=src, target=dst, condition=cond)  # type: ignore[arg-type]


def dev(provider: str = "claude", **kw: Any) -> AgentNodeConfig:
    return AgentNodeConfig.model_validate({"provider": provider, **kw})


def gate(kind: GateKind, **kw: Any) -> GateNodeConfig:
    return GateNodeConfig.model_validate({"gate": kind, **kw})


async def test_boundary_violation_fails_then_agent_reverts(env: EngineEnv) -> None:
    env.memory.bounds = Boundaries(forbidden_paths=["secrets/"], readonly_paths=["/migrations/**"])

    def respond(session: Any, _m: str) -> str:
        wid = session.req.worktree_id
        if len(session.messages) == 1:
            env.worktrees.touch(wid, "src/app.py", "secrets/token.txt", "migrations/001.sql")
        else:
            assert "secrets/token.txt" in session.last_message  # feedback lists the violations
            env.worktrees.revert(wid, "secrets/token.txt", "migrations/001.sql")
        return "tamam"

    env.agents.on(respond, node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    violations = await env.events(run_id, ["boundary.violation"])
    assert len(violations) == 1 and violations[0].severity == "critical"
    kinds = {v["path"]: v["kind"] for v in violations[0].payload["violations"]}
    assert kinds == {"secrets/token.txt": "forbidden", "migrations/001.sql": "readonly"}
    gates = [g for g in await env.engine.store.gate_results(run_id) if g.kind == "boundary_check"]
    assert [g.status for g in gates] == ["failed", "passed"]
    # the dev session received the workspace boundaries as CLI-level restrictions too
    assert "secrets/" in env.agents.by_node("dev")[0].req.spec.boundaries.forbidden_paths


async def test_boundary_violation_without_loop_fails_run(env: EngineEnv) -> None:
    env.memory.bounds = Boundaries(forbidden_paths=["*.pem"])
    env.agents.on(writes(env, "keys/server.pem"), node_id="dev")
    graph = FlowGraph(
        nodes=[n("dev", dev()), n("boundary", gate(GateKind.boundary_check))], edges=[e("dev", "boundary")]
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "failed"
    assert (await env.engine.get_task(task.id)).status == "failed"


async def test_denied_command_in_command_log_is_a_violation(env: EngineEnv) -> None:
    env.memory.bounds = Boundaries(denied_commands=["git push*"])

    async def respond(session: Any, _m: str) -> str:
        await env.ctx.events.append(
            "agent.tool.call",
            {"call_id": "1", "tool": "Bash", "kind": "command", "input": {"command": "git push origin main"}},
            session_id=session.id,
        )
        env.worktrees.touch(session.req.worktree_id, "a.py")
        return "ok"

    env.agents.on(respond, node_id="dev")
    graph = FlowGraph(
        nodes=[n("dev", dev()), n("boundary", gate(GateKind.boundary_check))], edges=[e("dev", "boundary")]
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "failed"
    g = (await env.engine.store.gate_results(run.id))[0]
    assert g.evidence["violations"][0]["kind"] == "denied_command"


async def test_build_test_failure_evidence_is_studiod_output_and_masked(env: EngineEnv) -> None:
    token = "ghp_" + "A1b2C3d4" * 5  # built at runtime: never a literal secret in the repo
    outputs = {
        ("pytest -q", 1): (1, f"FAILED test_x.py::test_a - AssertionError\nTOKEN={token}\n"),
    }
    env.worktrees.command_script = lambda _w, cmd, i: outputs.get((cmd, i), (0, "ok"))
    env.agents.on(writes(env, "x.py", reply="Bütün testler geçti!"), node_id="dev")
    task = await env.create(FlowMode.single)
    run_id = await env.run_of(task.id)
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    builds = [g for g in await env.engine.store.gate_results(run_id) if g.kind == "build_test"]
    assert [g.status for g in builds] == ["failed", "passed"]
    failed_cmd = next(c for c in builds[0].evidence["commands"] if c["name"] == "test")
    assert failed_cmd["exit_code"] == 1 and failed_cmd["command"] == "pytest -q"
    assert "AssertionError" in failed_cmd["output_tail"]
    assert token not in failed_cmd["output_tail"] and "[gizli]" in failed_cmd["output_tail"]
    assert builds[0].evidence["runner"] == "studiod"
    # the feedback to the author contains the failing output, not the agent's claim
    second = env.agents.by_node("dev")[0].messages[1]
    assert "pytest -q" in second and "AssertionError" in second and token not in second
    evidence = await env.engine.store.evidence(run_id=run_id)
    cmd_evidence = [ev for ev in evidence if ev.kind == "command"]
    assert all(ev.source == "gate" for ev in cmd_evidence)
    assert any("çıkış kodu 1" in ev.title for ev in cmd_evidence)


async def test_build_test_without_commands_is_skipped(env: EngineEnv) -> None:
    from aistudio.contracts.workspaces import RepoCommands
    from aistudio.workspaces.service import RepoUpdate

    await env.workspaces.update_repo(env.repo.id, RepoUpdate(commands=RepoCommands()))
    env.engine.rt.ctx  # noqa: B018
    env.agents.on(writes(env, "x.py"), node_id="dev")
    graph = FlowGraph(nodes=[n("dev", dev()), n("build", gate(GateKind.build_test))], edges=[e("dev", "build")])
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    g = (await env.engine.store.gate_results(run.id))[0]
    assert g.status == "skipped" and "komutu yok" in g.summary


async def test_cross_review_uses_other_provider_than_author(env: EngineEnv) -> None:
    env.agents.add_profile("rev-codex", "codex", instructions="Sert incele.")
    graph = FlowGraph(
        nodes=[
            n("dev", dev("codex")),
            n("review", gate(GateKind.cross_review, reviewer_profile_id="rev-codex")),
        ],
        edges=[e("dev", "review")],
    )
    # static validation rejects a same-provider reviewer profile
    report = await env.engine.validate(graph)
    assert not report.ok and report.errors[0].code == "cross_review_provider"

    # at runtime the author may end up on the reviewer's provider (e.g. limit switch): the rule still holds
    graph2 = FlowGraph(
        nodes=[n("dev", dev()), n("review", gate(GateKind.cross_review, reviewer_profile_id="rev-codex"))],
        edges=[e("dev", "review")],
    )
    env.agents.on(writes(env, "a.py"), node_id="dev")
    env.agents.on(FINDINGS_PASS, node_id="review")
    task = await env.create(FlowMode.custom, graph=graph2)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    reviewer = env.agents.by_node("review")[0]
    assert reviewer.provider == "codex" and reviewer.req.profile_id == "rev-codex"
    assert "Sert incele." in reviewer.req.spec.system_append

    # author on codex -> reviewer forced to claude even though the profile is codex
    env2_graph = FlowGraph(
        nodes=[n("dev", dev("codex")), n("review", gate(GateKind.cross_review))],
        edges=[e("dev", "review")],
    )
    task2 = await env.create(FlowMode.custom, graph=env2_graph)
    run2 = await env.wait_run(await env.run_of(task2.id))
    assert run2.status == "completed"
    reviewer2 = next(s for s in env.agents.by_node("review") if s.req.run_id == run2.id)
    assert reviewer2.provider == "claude"


async def test_cross_review_unreadable_findings_fails_node(env: EngineEnv) -> None:
    env.agents.on(writes(env, "a.py"), node_id="dev")
    env.agents.on("Bence iyi görünüyor.", node_id="review")
    graph = FlowGraph(nodes=[n("dev", dev()), n("review", gate(GateKind.cross_review))], edges=[e("dev", "review")])
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "failed"
    review = next(x for x in run.nodes if x.node_id == "review")
    assert review.error is not None and "okunamadı" in review.error
    # one retry turn asked for the JSON block
    assert len(env.agents.by_node("review")[0].messages) == 2


async def test_cross_review_blocking_severities_config(env: EngineEnv) -> None:
    env.agents.on(writes(env, "a.py"), node_id="dev")
    env.agents.on(findings_json(("medium", "Yorum eksik")), node_id="review")
    graph = FlowGraph(
        nodes=[n("dev", dev()), n("review", gate(GateKind.cross_review, blocking_severities=["critical"]))],
        edges=[e("dev", "review")],
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    review = next(x for x in run.nodes if x.node_id == "review")
    assert review.data is not None and review.data["findings"][0]["severity"] == "medium"


async def test_merge_conflict_resolved_by_agent_then_gates_and_approval(env: EngineEnv) -> None:
    def author(session: Any, _m: str) -> str:
        wid = session.req.worktree_id
        env.worktrees.touch(wid, "app.py")
        env.worktrees.conflicts[wid] = ["app.py"]
        return "yazıldı"

    def resolver(session: Any, message: str) -> str:
        assert "git merge main" in message and "app.py" in message
        env.worktrees.conflicts.pop(session.req.worktree_id, None)
        return "çakışma çözüldü"

    env.agents.on(author, node_id="dev")
    env.agents.on(resolver, node_id="merge")
    graph = FlowGraph(
        nodes=[n("dev", dev()), n("merge", MergeNodeConfig(require_approval=True, strategy="merge"))],
        edges=[e("dev", "merge")],
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    approval = await env.next_approval(ApprovalKind.merge)
    assert approval.payload["conflicts_resolved"] is True
    assert approval.payload["merges"][0]["files"] == ["app.py"]
    assert "+yeni" in approval.payload["merges"][0]["patch"]
    await env.decide(ApprovalKind.merge)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert env.worktrees.merges[0]["strategy"] == "merge"
    assert (await env.events(run_id, ["conflict.detected"]))[0].payload["conflicts"] == ["app.py"]
    gates = await env.engine.store.gate_results(run_id)
    assert {g.kind for g in gates} == {"boundary_check", "build_test"}
    assert all(g.evidence.get("conflict_resolution") for g in gates)
    merge_node = next(x for x in run.nodes if x.node_id == "merge")
    assert merge_node.data is not None and merge_node.data["merge_commits"] == ["m0001"]


async def test_merge_conflict_without_agent_fails(env: EngineEnv) -> None:
    def author(session: Any, _m: str) -> str:
        env.worktrees.touch(session.req.worktree_id, "app.py")
        env.worktrees.conflicts[session.req.worktree_id] = ["app.py"]
        return "ok"

    env.agents.on(author, node_id="dev")
    graph = FlowGraph(
        nodes=[n("dev", dev()), n("merge", MergeNodeConfig(resolve_conflicts_with_agent=False))],
        edges=[e("dev", "merge")],
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "failed"
    merge_node = next(x for x in run.nodes if x.node_id == "merge")
    assert merge_node.error is not None and "çakışma" in merge_node.error


async def test_git_push_branch_template_and_open_pr_with_watch(env: EngineEnv) -> None:
    env.agents.on(writes(env, "fix.py"), node_id="dev")
    graph = FlowGraph(
        nodes=[
            n("dev", dev()),
            n("push", GitNodeConfig(action="push", push_branch_template="{{ input.push_branch }}")),
            n("pr", GitNodeConfig(action="open_pr", title_template="Düzeltme: {{ task.title }}", draft=True)),
        ],
        edges=[e("dev", "push"), e("push", "pr")],
    )
    task = await env.create(FlowMode.custom, graph=graph, inputs={"push_branch": "feature/pr-12"})
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    assert env.worktrees.pushes[0]["remote_branch"] == "feature/pr-12"
    assert env.worktrees.pushes[1]["remote_branch"] is None  # PR pushes the worktree's own branch
    pr = env.hosting.prs[0]
    assert pr["title"] == "Düzeltme: Kurulum belgesi" and pr["draft"] is True and pr["base"] == "main"
    assert "## Görev" in pr["body"]
    assert env.hosting.watched == [(env.repo.id, 1, task.id, True)]
    pr_node = next(x for x in run.nodes if x.node_id == "pr")
    assert pr_node.output == "Düzeltme: Kurulum belgesi: https://git.example/pr/1"


async def test_deploy_approval_is_production_locked_and_deploy_runs(env: EngineEnv) -> None:
    env.deploy.add_profile("prod", Environment.production)
    env.agents.on(writes(env, "x.py"), node_id="dev")
    graph = FlowGraph(
        nodes=[
            n("dev", dev()),
            n("merge", MergeNodeConfig(require_approval=False)),
            n("deploy_ok", gate(GateKind.deploy_approval)),
            n("deploy", DeployNodeConfig(profile_id="prod")),
        ],
        edges=[e("dev", "merge"), e("merge", "deploy_ok"), e("deploy_ok", "deploy")],
        settings=FlowSettings(gates=GateToggles(user_final=False)),
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    approval = await env.next_approval(ApprovalKind.deploy)
    assert approval.production is True and approval.severity == "critical"
    assert approval.payload["profiles"][0]["environment"] == "production"
    await env.decide(ApprovalKind.deploy)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert env.deploy.deploys == [{"profile_id": "prod", "ref": "m0001", "actor": "engine", "task_id": task.id}]


async def test_deploy_failure_fails_run(env: EngineEnv) -> None:
    env.deploy.add_profile("test", Environment.test)
    env.deploy.fail = True
    env.agents.on(writes(env, "x.py"), node_id="dev")
    graph = FlowGraph(
        nodes=[n("dev", dev()), n("deploy", DeployNodeConfig(profile_id="test"))], edges=[e("dev", "deploy")]
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "failed"


async def test_human_node_decision_payload_becomes_data(env: EngineEnv) -> None:
    graph = FlowGraph(
        nodes=[
            n(
                "ask",
                HumanNodeConfig(
                    instructions="Staging ortamında {{ task.title }} için duman testi yap.",
                    input_schema={"type": "object", "properties": {"ok": {"type": "boolean"}}},
                ),
                label="Elle kontrol",
            ),
            n("after", dev(writes=False, prompt_template="Sonuç: {{ nodes.ask.data.ok }}")),
        ],
        edges=[e("ask", "after")],
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    approval = await env.next_approval(ApprovalKind.custom)
    assert approval.title == "Elle kontrol"
    assert approval.summary == "Staging ortamında Kurulum belgesi için duman testi yap."
    assert approval.payload["input_schema"]["properties"]["ok"]["type"] == "boolean"
    await env.decide(ApprovalKind.custom, payload={"ok": True, "text": "Her şey yolunda"})
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    human = next(x for x in run.nodes if x.node_id == "ask")
    assert human.data is not None and human.data["ok"] is True and human.output == "Her şey yolunda"
    assert env.agents.by_node("after")[0].messages[0] == "Sonuç: True"


async def test_condition_loop_and_exhaustion(env: EngineEnv) -> None:
    counter = {"n": 0}

    def respond(_s: Any, _m: str) -> str:
        counter["n"] += 1
        return "HAZIR" if counter["n"] >= 3 else "devam"

    env.agents.on(respond, node_id="work")
    graph = FlowGraph(
        nodes=[
            n("work", dev(writes=False)),
            n("check", ConditionNodeConfig(expression="'HAZIR' in nodes.work.output", max_loops=3)),
            n("done", dev(writes=False, prompt_template="bitti")),
        ],
        edges=[e("work", "check"), e("check", "done", "true"), e("check", "work", "false")],
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    assert [x.data["value"] for x in run.nodes if x.node_id == "check" and x.data] == [False, False, True]

    counter["n"] = -100
    task2 = await env.create(FlowMode.custom, graph=graph)
    run2 = await env.wait_run(await env.run_of(task2.id))
    assert run2.status == "failed"
    assert len(await env.events(run2.id, ["gate.loop_exhausted"])) == 1


async def test_join_any_continues_with_first_branch_and_cancels_the_other(env: EngineEnv) -> None:
    import asyncio

    release = asyncio.Event()

    async def slow(_s: Any, _m: str) -> str:
        await release.wait()
        return "yavaş"

    env.agents.on("hızlı", node_id="fast")
    env.agents.on(slow, node_id="slow")
    graph = FlowGraph(
        nodes=[
            n("fork", ParallelNodeConfig()),
            n("fast", dev(writes=False)),
            n("slow", dev(writes=False)),
            n("join", JoinNodeConfig(mode="any")),
            n("next", dev(writes=False, prompt_template="{{ nodes.join.output }}")),
        ],
        edges=[e("fork", "fast"), e("fork", "slow"), e("fast", "join"), e("slow", "join"), e("join", "next")],
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    release.set()
    assert run.status == "completed"
    statuses = {x.node_id: x.status for x in run.nodes}
    assert statuses["slow"] == "cancelled"
    assert "hızlı" in env.agents.by_node("next")[0].messages[0]
    assert env.agents.by_node("slow")[0].interrupted


async def test_disabled_gates_are_recorded_as_skipped(env: EngineEnv) -> None:
    graph = build_mode_graph(FlowMode.duo)
    graph.settings.gates = GateToggles(build_test=False, cross_review=False, user_final=False)
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    statuses = {x.node_id: x.status for x in run.nodes}
    assert statuses == {
        "dev": "passed",
        "boundary": "passed",
        "build": "skipped",
        "review": "skipped",
        "final": "skipped",
    }
    gates = await env.engine.store.gate_results(run.id)
    assert {g.kind: g.status for g in gates} == {
        "boundary_check": "passed",
        "build_test": "skipped",
        "cross_review": "skipped",
        "user_final": "skipped",
    }
    assert not env.worktrees.commands


async def test_custom_command_gate(env: EngineEnv) -> None:
    env.worktrees.command_script = lambda _w, cmd, _i: (0, "lint ok") if cmd == "make check" else (1, "x")
    env.agents.on(writes(env, "a.py"), node_id="dev")
    graph = FlowGraph(
        nodes=[n("dev", dev()), n("check", gate(GateKind.custom_command, command="make check"))],
        edges=[e("dev", "check")],
    )
    task = await env.create(FlowMode.custom, graph=graph)
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    g = (await env.engine.store.gate_results(run.id))[0]
    assert g.kind == "custom_command" and g.evidence["runs"][0]["exit_code"] == 0


async def test_agent_error_fails_without_loop_and_retry_node_recovers(env: EngineEnv) -> None:
    from aistudio.contracts.agents import TurnResult

    attempts = {"n": 0}

    def flaky(session: Any, _m: str) -> Any:
        attempts["n"] += 1
        if attempts["n"] == 1:
            return TurnResult(turn_id="", status="error", error="CLI çöktü")
        env.worktrees.touch(session.req.worktree_id, "a.py")
        return "ok"

    env.agents.on(flaky, node_id="dev")
    graph = FlowGraph(nodes=[n("dev", dev()), n("build", gate(GateKind.build_test))], edges=[e("dev", "build")])
    task = await env.create(FlowMode.custom, graph=graph)
    run_id = await env.run_of(task.id)
    run = await env.wait_run(run_id)
    assert run.status == "failed"
    dev_node = next(x for x in run.nodes if x.node_id == "dev")
    assert dev_node.error is not None and "CLI çöktü" in dev_node.error
    await env.engine.retry_node(run_id, "dev")
    run = await env.wait_run(run_id, ("completed",))
    assert [x.status for x in run.nodes if x.node_id == "dev"] == ["failed", "passed"]
    assert (await env.engine.get_task(task.id)).status == "completed"
    types = [ev.type for ev in await env.events(run_id)]
    assert "run.reopened" in types and "node.retry" in types


async def test_writer_without_worktree_manager_is_unavailable(ctx: Any, git_repo: Any, tmp_path: Any) -> None:
    from engine_support import build_env

    env = await build_env(ctx, git_repo, tmp_path, register=False)
    from aistudio.contracts.agents import AgentManager

    ctx.services.register(AgentManager, env.agents)  # type: ignore[type-abstract]
    try:
        graph = FlowGraph(nodes=[n("dev", dev())])
        task = await env.create(FlowMode.custom, graph=graph)
        run = await env.wait_run(await env.run_of(task.id))
        assert run.status == "failed"
        assert run.nodes[0].error is not None and "Worktree yöneticisi hazır değil" in run.nodes[0].error
        # without an agent manager the node reports that instead
        graph2 = FlowGraph(nodes=[n("adv", dev(writes=False))])
        ctx.services._items.pop(AgentManager)
        task2 = await env.create(FlowMode.custom, graph=graph2)
        run2 = await env.wait_run(await env.run_of(task2.id))
        assert run2.nodes[0].error is not None and "Ajan yöneticisi hazır değil" in run2.nodes[0].error
    finally:
        await env.engine.shutdown()
