"""Node implementations, dispatched by node kind."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from aistudio.contracts.flows import NodeKind
from aistudio.engine.nodes.base import NodeContext, NodeOutcome


async def run_node(nctx: NodeContext) -> NodeOutcome:
    from aistudio.engine.nodes.agent import run_advisor_node, run_agent_node
    from aistudio.engine.nodes.compare import run_compare_node
    from aistudio.engine.nodes.control import run_condition_node, run_join_node, run_parallel_node
    from aistudio.engine.nodes.gates import run_gate_node
    from aistudio.engine.nodes.ops import run_deploy_node, run_git_node, run_human_node, run_merge_node
    from aistudio.engine.nodes.synthesis import run_synthesis_node

    handlers: dict[NodeKind, Callable[[NodeContext], Awaitable[NodeOutcome]]] = {
        NodeKind.agent: run_agent_node,
        NodeKind.advisor: run_advisor_node,
        NodeKind.gate: run_gate_node,
        NodeKind.parallel: run_parallel_node,
        NodeKind.join_: run_join_node,
        NodeKind.compare: run_compare_node,
        NodeKind.condition: run_condition_node,
        NodeKind.synthesis: run_synthesis_node,
        NodeKind.merge: run_merge_node,
        NodeKind.git: run_git_node,
        NodeKind.deploy: run_deploy_node,
        NodeKind.human: run_human_node,
    }
    return await handlers[nctx.node.kind](nctx)


__all__ = ["NodeContext", "NodeOutcome", "run_node"]
