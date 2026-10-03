"""Team routes under ``/api/engine``: templates (``/teams``) and the live team of a run."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from fastapi import APIRouter, Response

from aistudio.contracts.teams import Team, TeamSpec
from aistudio.engine.team.models import (
    MemberMessageBody,
    MemberMessageResult,
    TeamCreate,
    TeamRunDetail,
    TeamUpdate,
    TeamValidationReport,
    TeamVersionInfo,
)

if TYPE_CHECKING:
    from aistudio.engine.service import FlowEngineImpl


def add_team_routes(r: APIRouter, get_engine: Callable[[], FlowEngineImpl]) -> None:
    @r.get("/teams", response_model=list[Team])
    async def list_teams(workspace_id: str | None = None) -> list[Team]:
        """Built-in templates first, then saved teams (latest version, newest first)."""
        return await get_engine().teams.catalog.list(workspace_id)

    @r.post("/teams", response_model=Team, status_code=201)
    async def create_team(body: TeamCreate) -> Team:
        return await get_engine().teams.catalog.create(body)

    @r.post("/teams/validate", response_model=TeamValidationReport)
    async def validate_team(spec: TeamSpec) -> TeamValidationReport:
        return get_engine().teams.catalog.validate(spec)

    @r.get("/teams/{team_id}", response_model=Team)
    async def get_team(team_id: str, version: int | None = None) -> Team:
        return await get_engine().teams.catalog.get(team_id, version)

    @r.put("/teams/{team_id}", response_model=Team)
    async def update_team(team_id: str, body: TeamUpdate) -> Team:
        """Saves a new version (built-in templates are read-only: 409)."""
        return await get_engine().teams.catalog.update(team_id, body)

    @r.delete("/teams/{team_id}", status_code=204)
    async def delete_team(team_id: str) -> Response:
        await get_engine().teams.catalog.delete(team_id)
        return Response(status_code=204)

    @r.get("/teams/{team_id}/versions", response_model=list[TeamVersionInfo])
    async def team_versions(team_id: str) -> list[TeamVersionInfo]:
        return await get_engine().teams.catalog.versions(team_id)

    @r.get("/runs/{run_id}/team", response_model=TeamRunDetail)
    async def run_team(run_id: str, node_id: str | None = None) -> TeamRunDetail:
        """The team of a run (``node_id`` picks one when the flow has several team nodes)."""
        return await get_engine().teams.run_view(run_id, node_id)

    @r.post("/runs/{run_id}/team/members/{member_id}/message", response_model=MemberMessageResult)
    async def message_member(run_id: str, member_id: str, body: MemberMessageBody) -> MemberMessageResult:
        return await get_engine().teams.message_member(run_id, member_id, body)
