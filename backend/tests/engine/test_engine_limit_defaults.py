"""Settings → Limitler defaults: `limits.default_budget` and `limits.on_exhausted`."""

from __future__ import annotations

from engine_support import EngineEnv, writes

from aistudio.contracts.common import Provider
from aistudio.contracts.flows import AgentNodeConfig, FlowGraph, FlowMode, FlowNode, FlowSettings
from aistudio.contracts.limits import Budget, BudgetCheck
from aistudio.workspaces.service import WorkspaceUpdate


def _graph(settings: FlowSettings | None = None) -> FlowGraph:
    node = FlowNode(id="dev", label="dev", config=AgentNodeConfig(provider="claude"))
    return FlowGraph(nodes=[node], settings=settings or FlowSettings())


def _record_budgets(env: EngineEnv) -> list[Budget]:
    seen: list[Budget] = []

    async def check_budget(provider: Provider, budget: Budget, *, task_id: str) -> BudgetCheck:
        seen.append(budget)
        return BudgetCheck(ok=True)

    env.limits.check_budget = check_budget  # type: ignore[method-assign]
    return seen


async def test_global_default_budget_applies_when_task_and_flow_set_none(env: EngineEnv) -> None:
    await env.ctx.store.set("limits.default_budget", {"max_turns": 7, "max_weekly_percent": None})
    seen = _record_budgets(env)
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.custom, graph=_graph())
    run = await env.wait_run(await env.run_of(task.id))
    assert run.status == "completed"
    assert seen and seen[0].max_turns == 7


async def test_flow_budget_wins_over_global_default(env: EngineEnv) -> None:
    await env.ctx.store.set("limits.default_budget", {"max_turns": 7})
    seen = _record_budgets(env)
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.custom, graph=_graph(FlowSettings(budget=Budget(max_duration_minutes=30))))
    await env.wait_run(await env.run_of(task.id))
    assert seen and seen[0].max_duration_minutes == 30 and seen[0].max_turns is None


async def test_no_budget_anywhere_skips_budget_checks(env: EngineEnv) -> None:
    seen = _record_budgets(env)
    env.agents.on(writes(env, "a.py"), node_id="dev")
    task = await env.create(FlowMode.custom, graph=_graph())
    await env.wait_run(await env.run_of(task.id))
    assert seen == []


async def test_mode_templates_use_global_policy_and_workspace_overrides_it(env: EngineEnv) -> None:
    graph = await env.engine.graph_for_mode(FlowMode.single, workspace_id=env.workspace.id)
    assert graph.settings.limit_policy.on_exhausted == "queue"

    await env.ctx.store.set("limits.on_exhausted", "switch_provider")
    graph = await env.engine.graph_for_mode(FlowMode.duo, workspace_id=env.workspace.id)
    assert graph.settings.limit_policy.on_exhausted == "switch_provider"

    await env.workspaces.update(
        env.workspace.id,
        WorkspaceUpdate(settings={"engine": {"flow_settings": {"limit_policy": {"on_exhausted": "ask"}}}}),
    )
    graph = await env.engine.graph_for_mode(FlowMode.single, workspace_id=env.workspace.id)
    assert graph.settings.limit_policy.on_exhausted == "ask"


async def test_invalid_global_values_fall_back_to_defaults(env: EngineEnv) -> None:
    await env.ctx.store.set("limits.on_exhausted", "explode")
    await env.ctx.store.set("limits.default_budget", {"max_turns": "çok"})
    assert (await env.engine.rt.default_limit_policy()).on_exhausted == "queue"
    assert await env.engine.rt.default_budget() == Budget()
