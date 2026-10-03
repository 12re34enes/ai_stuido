"""``parallel``, ``join`` and ``condition`` nodes (pure control flow)."""

from __future__ import annotations

from aistudio.contracts.flows import ConditionNodeConfig, JoinNodeConfig
from aistudio.engine.nodes.base import NodeContext, NodeOutcome
from aistudio.engine.templates import evaluate


async def run_parallel_node(nctx: NodeContext) -> NodeOutcome:
    branches = [e.target for e in nctx.ex.topo.forward_out(nctx.node_id)]
    return NodeOutcome(status="passed", output=f"{len(branches)} dal başlatıldı.", data={"branches": branches})


async def run_join_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, JoinNodeConfig)
    ex = nctx.ex
    arrived = [e.source for e in ex.topo.forward_in(nctx.node_id) if ex.state.deliveries.get(e.id) == "live"]
    parts = []
    for src in arrived:
        out = ex.output_of(src).strip()
        if out:
            parts.append(f"## {ex.topo.nodes[src].label}\n{out}")
    return NodeOutcome(
        status="passed",
        output="\n\n".join(parts) or f"{len(arrived)} dal birleşti.",
        data={"sources": arrived, "mode": cfg.mode},
    )


async def run_condition_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, ConditionNodeConfig)
    value = evaluate(cfg.expression, await nctx.variables())
    branch = "true" if value else "false"
    return NodeOutcome(
        status="passed",
        output="Koşul doğru." if value else "Koşul yanlış.",
        data={"expression": cfg.expression, "value": value},
        branch=branch,
    )
