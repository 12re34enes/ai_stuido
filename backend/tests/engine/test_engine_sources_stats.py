"""Graph source precedence (explicit > studio > saved flow > mode) and agent performance history."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from engine_support import EngineEnv, build_env

from aistudio.contracts.agents import TurnResult
from aistudio.contracts.flows import AgentNodeConfig, FlowGraph, FlowMode, FlowNode
from aistudio.core.context import AppContext
from aistudio.engine.models import FlowCreate


def one(node_id: str, provider: str = "claude") -> FlowGraph:
    return FlowGraph(
        nodes=[
            FlowNode(
                id=node_id,
                label=node_id,
                config=AgentNodeConfig.model_validate({"provider": provider, "writes": False}),
            )
        ]
    )


async def _graph_ids(env: EngineEnv, task_id: str) -> list[str]:
    run = await env.engine.get_run(await env.run_of(task_id))
    return [n.id for n in run.graph.nodes]


async def test_graph_source_precedence(env: EngineEnv) -> None:
    env.studios.graphs["architecture"] = one("from_studio")
    flow = await env.engine.create_flow(
        FlowCreate(workspace_id=env.workspace.id, name="Kayıtlı", graph=one("from_flow"))
    )

    explicit = await env.create(FlowMode.duo, graph=one("explicit"), studio_id="architecture", flow_id=flow.id)
    assert await _graph_ids(env, explicit.id) == ["explicit"]

    studio = await env.create(FlowMode.duo, studio_id="architecture", flow_id=flow.id, inputs={"topic": "API"})
    assert await _graph_ids(env, studio.id) == ["from_studio"]
    assert env.studios.instantiated[-1] == ("architecture", {"topic": "API", "prompt": "README'ye kurulum bölümü ekle"})

    saved = await env.create(FlowMode.duo, flow_id=flow.id)
    assert await _graph_ids(env, saved.id) == ["from_flow"]

    mode = await env.create(FlowMode.duo)
    assert await _graph_ids(env, mode.id) == ["dev", "boundary", "build", "review", "final"]


async def test_studio_without_service_falls_back_to_mode(ctx: AppContext, git_repo: Path, tmp_path: Path) -> None:
    env = await build_env(ctx, git_repo, tmp_path, register=False)
    try:
        task = await env.create(FlowMode.single, studio_id="architecture")
        run = await env.engine.get_run(await env.run_of(task.id))
        assert [n.id for n in run.graph.nodes] == ["dev", "boundary", "build", "final"]
        warning = await env.events(types=["task.warning"])
        assert warning and "Stüdyo servisi hazır değil" in warning[0].payload["message"]
        # optional services absent: memory/limits are simply skipped, the missing agent manager is reported
        run = await env.wait_run(run.id)
        assert run.status == "failed" and "Ajan yöneticisi hazır değil" in (run.nodes[0].error or "")
    finally:
        await env.engine.shutdown()


async def test_workspace_default_provider_and_flow_settings(env: EngineEnv) -> None:
    from aistudio.workspaces.service import WorkspaceUpdate

    await env.workspaces.update(
        env.workspace.id,
        WorkspaceUpdate(
            settings={"engine": {"default_provider": "codex", "flow_settings": {"max_parallel_agents": 2}}}
        ),
    )
    graph = await env.engine.graph_for_mode(FlowMode.duo, workspace_id=env.workspace.id)
    dev = graph.node("dev").config
    assert isinstance(dev, AgentNodeConfig) and dev.provider == "codex"
    assert graph.node("review").label == "Çapraz inceleme (Claude)"
    assert graph.settings.max_parallel_agents == 2


async def test_agent_stats_and_recommendations(env: EngineEnv) -> None:
    def respond(session: Any, _m: str) -> Any:
        if session.provider == "codex" and session.req.task_id in failing:
            return TurnResult(turn_id="", status="error", error="hata")
        return "ok"

    failing: set[str] = set()
    env.agents.on(respond)
    for i in range(3):
        t = await env.create(FlowMode.custom, graph=one("work", "claude"), title=f"c{i}")
        await env.wait_run(await env.run_of(t.id))
    for i in range(3):
        t = await env.create(FlowMode.custom, graph=one("work", "codex"), title=f"x{i}", start=False)
        if i < 2:
            failing.add(t.id)
        await env.engine.start(t.id)
        await env.wait_run(await env.run_of(t.id))

    report = await env.engine.agent_stats(workspace_id=env.workspace.id)
    by_provider = {s.provider: s for s in report.stats}
    assert by_provider["claude"].node_runs == 3 and by_provider["claude"].success_rate == 1.0
    assert by_provider["codex"].failed == 2 and by_provider["codex"].success_rate == round(1 / 3, 3)
    assert by_provider["claude"].roles == {"writer": 3}
    assert by_provider["claude"].avg_duration_s is not None
    assert any("Claude daha başarılı" in r for r in report.recommendations)
