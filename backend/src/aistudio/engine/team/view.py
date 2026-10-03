"""Build the ``TeamRunDetail`` API view from persisted (or live) team state."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from aistudio.contracts.teams import TeamSpec
from aistudio.engine.team.models import TeamAssignment, TeamMemberView, TeamRunDetail, TeamState


def build_view(
    *,
    run_id: str,
    node_id: str,
    spec: TeamSpec,
    state: TeamState,
    assignments: Iterable[TeamAssignment],
    meta: dict[str, Any],
    active: bool,
) -> TeamRunDetail:
    members: list[TeamMemberView] = []
    for m in spec.members:
        ms = state.members.get(m.id)
        worktree_id = next(iter(ms.worktrees.values()), None) if ms is not None else None
        members.append(
            TeamMemberView(
                member_id=m.id,
                status=ms.status if ms is not None else "idle",
                session_id=ms.session_id if ms is not None else None,
                worktree_id=worktree_id,
                current_assignment_id=ms.current_assignment_id if ms is not None else None,
                completed=ms.completed if ms is not None else 0,
                failed=ms.failed if ms is not None else 0,
                name=m.name,
                role=m.role.value,
                parent_id=m.parent_id,
                provider=(ms.provider if ms is not None and ms.provider else m.provider),
                model=(ms.model if ms is not None and ms.model else m.model),
                effort=(ms.effort if ms is not None and ms.effort else m.effort),
                switched_from=ms.switched_from if ms is not None else None,
            )
        )
    return TeamRunDetail(
        run_id=run_id,
        node_id=node_id,
        spec=spec,
        members=members,
        assignments=sorted(assignments, key=lambda a: a.seq),
        team_id=meta.get("team_id"),
        team_version=meta.get("team_version"),
        team_name=meta.get("team_name") or "",
        status=meta.get("status") or "running",
        summary=meta.get("summary"),
        error=meta.get("error"),
        attempt=state.attempt,
        active=active,
    )
