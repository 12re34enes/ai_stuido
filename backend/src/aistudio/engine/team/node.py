"""``team`` node: runs a team (spec §25) and hands the lead's integrated worktree to the next nodes."""

from __future__ import annotations

from aistudio.contracts.flows import TeamNodeConfig
from aistudio.engine.nodes.base import NodeContext, NodeOutcome
from aistudio.engine.team.runtime import TeamRun


async def run_team_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, TeamNodeConfig)
    nctx.rt.agents()  # fail fast (Turkish Unavailable) when no agent manager is registered
    nctx.rt.worktrees()
    team = await TeamRun.open(nctx, cfg)
    return await team.run()
