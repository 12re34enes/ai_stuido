"""Team templates: built-in (code) + saved (``engine_teams``, versioned like flows).

Events: ``team.template.saved`` {team_id, version, name}, ``team.template.deleted`` {team_id, name}.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from aistudio.contracts.teams import Team, TeamSpec
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, ValidationFailed
from aistudio.core.ids import new_id
from aistudio.engine.team.models import TeamCreate, TeamUpdate, TeamValidationReport, TeamVersionInfo
from aistudio.engine.team.store import Row, TeamStore
from aistudio.engine.team.templates import builtin_team, builtin_teams
from aistudio.engine.team.validation import first_error, validate_team

if TYPE_CHECKING:
    from aistudio.engine.runtime import EngineRuntime

BUILTIN_READONLY = "Hazır ekip şablonları değiştirilemez; kendi kopyanızı oluşturun."


def _team_from_rows(rows: list[Row]) -> Team:
    latest = rows[-1]
    return Team(
        id=latest["team_id"],
        workspace_id=latest["workspace_id"],
        name=latest["name"],
        description=latest["description"] or "",
        version=latest["version"],
        builtin=False,
        spec=TeamSpec.model_validate(latest["spec"] or {}),
        created_at=rows[0]["created_at"],
        updated_at=latest["created_at"],
    )


class TeamCatalog:
    def __init__(self, rt: EngineRuntime) -> None:
        self.rt = rt

    @property
    def store(self) -> TeamStore:
        return self.rt.team_store

    def validate(self, spec: TeamSpec) -> TeamValidationReport:
        return validate_team(spec)

    def ensure_valid(self, spec: TeamSpec) -> None:
        report = validate_team(spec)
        if not report.ok:
            raise ValidationFailed(
                f"Ekip geçersiz: {first_error(report)}",
                details={"errors": [e.model_dump() for e in report.errors]},
            )

    async def list(self, workspace_id: str | None = None) -> list[Team]:
        by_id: dict[str, list[Row]] = {}
        for row in await self.store.list_team_rows(workspace_id=workspace_id):
            by_id.setdefault(row["team_id"], []).append(row)
        saved = [_team_from_rows(rows) for rows in by_id.values()]
        saved.sort(key=lambda t: t.updated_at or t.created_at or utcnow(), reverse=True)
        return [*builtin_teams(), *saved]

    async def find(self, team_id: str) -> Team | None:
        builtin = builtin_team(team_id)
        if builtin is not None:
            return builtin
        rows = await self.store.team_rows(team_id)
        return _team_from_rows(rows) if rows else None

    async def get(self, team_id: str, version: int | None = None) -> Team:
        builtin = builtin_team(team_id)
        if builtin is not None:
            if version not in (None, 1):
                raise NotFound("Ekibin bu sürümü bulunamadı.")
            return builtin
        rows = await self.store.team_rows(team_id)
        if not rows:
            raise NotFound("Ekip bulunamadı.")
        if version is None:
            return _team_from_rows(rows)
        upto = [r for r in rows if r["version"] <= version]
        if not upto or upto[-1]["version"] != version:
            raise NotFound("Ekibin bu sürümü bulunamadı.")
        return _team_from_rows(upto)

    async def versions(self, team_id: str) -> list[TeamVersionInfo]:
        builtin = builtin_team(team_id)
        if builtin is not None:
            return [TeamVersionInfo(version=1, name=builtin.name, created_by="builtin")]
        rows = await self.store.team_rows(team_id)
        if not rows:
            raise NotFound("Ekip bulunamadı.")
        return [
            TeamVersionInfo(
                version=r["version"], name=r["name"], created_by=r["created_by"], created_at=r["created_at"]
            )
            for r in rows
        ]

    async def create(self, body: TeamCreate, *, created_by: str = "user") -> Team:
        if body.workspace_id is not None:
            await self.rt.workspaces().get(body.workspace_id)
        name = body.name.strip()
        if not name:
            raise ValidationFailed("Ekip adı boş olamaz.")
        self.ensure_valid(body.spec)
        team_id = new_id("team")
        await self.store.insert_team_version(
            team_id=team_id,
            version=1,
            workspace_id=body.workspace_id,
            name=name,
            description=body.description,
            spec=body.spec,
            created_by=created_by,
        )
        team = await self.get(team_id)
        await self.rt.emit(
            "team.template.saved",
            {"team_id": team_id, "version": 1, "name": team.name},
            workspace_id=body.workspace_id,
        )
        return team

    async def update(self, team_id: str, body: TeamUpdate, *, created_by: str = "user") -> Team:
        if builtin_team(team_id) is not None:
            raise Conflict(BUILTIN_READONLY)
        current = await self.get(team_id)
        name = body.name.strip() if body.name is not None else current.name
        if not name:
            raise ValidationFailed("Ekip adı boş olamaz.")
        spec = body.spec if body.spec is not None else current.spec
        self.ensure_valid(spec)
        version = current.version + 1
        await self.store.insert_team_version(
            team_id=team_id,
            version=version,
            workspace_id=current.workspace_id,
            name=name,
            description=body.description if body.description is not None else current.description,
            spec=spec,
            created_by=created_by,
        )
        team = await self.get(team_id)
        await self.rt.emit(
            "team.template.saved",
            {"team_id": team_id, "version": version, "name": team.name},
            workspace_id=team.workspace_id,
        )
        return team

    async def delete(self, team_id: str) -> None:
        if builtin_team(team_id) is not None:
            raise Conflict(BUILTIN_READONLY)
        team = await self.get(team_id)
        await self.store.archive_team(team_id)
        await self.rt.emit(
            "team.template.deleted", {"team_id": team_id, "name": team.name}, workspace_id=team.workspace_id
        )
