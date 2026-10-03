"""Database access for team templates, team runs and assignments."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.engine import RowMapping

from aistudio.contracts.teams import AssignmentMerge, TeamSpec
from aistudio.core.clock import utcnow
from aistudio.engine.tables import engine_task_teams, engine_team_assignments, engine_team_runs, engine_teams
from aistudio.engine.team.models import TeamAssignment, TeamState, TeamTestVerdict
from aistudio.storage.db import Database

Row = RowMapping


def assignment_from_row(row: Row) -> TeamAssignment:
    merge = row["merge"]
    return TeamAssignment(
        id=row["id"],
        run_id=row["run_id"],
        node_id=row["node_id"],
        seq=row["seq"],
        kind=row["kind"],
        from_member=row["from_member"],
        to_member=row["to_member"],
        parent_id=row["parent_id"],
        target_id=row["target_id"],
        title=row["title"],
        instructions=row["instructions"] or "",
        depends_on=list(row["depends_on"] or []),
        status=row["status"],
        phase=row["phase"] or "work",
        round=row["round"] or 1,
        session_id=row["session_id"],
        worktree_id=row["worktree_id"],
        result_summary=row["result_summary"],
        error=row["error"],
        merge=AssignmentMerge.model_validate(merge) if merge else None,
        tests=[TeamTestVerdict.model_validate(t) for t in row["tests"] or []],
        delivered=bool(row["delivered"]),
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


def _assignment_values(a: TeamAssignment) -> dict[str, Any]:
    values = a.model_dump(mode="python", exclude={"merge", "tests"})
    values["merge"] = a.merge.model_dump(mode="json") if a.merge else None
    values["tests"] = [t.model_dump(mode="json") for t in a.tests]
    return values


class TeamStore:
    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------------ templates
    async def insert_team_version(
        self,
        *,
        team_id: str,
        version: int,
        workspace_id: str | None,
        name: str,
        description: str,
        spec: TeamSpec,
        created_by: str = "user",
    ) -> None:
        async with self.db.begin() as conn:
            await conn.execute(
                engine_teams.insert().values(
                    team_id=team_id,
                    version=version,
                    workspace_id=workspace_id,
                    name=name,
                    description=description,
                    spec=spec.model_dump(mode="json"),
                    created_by=created_by,
                    archived=False,
                    created_at=utcnow(),
                )
            )

    async def team_rows(self, team_id: str) -> list[Row]:
        t = engine_teams
        async with self.db.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        sa.select(t).where(t.c.team_id == team_id, t.c.archived.is_(False)).order_by(t.c.version)
                    )
                )
                .mappings()
                .all()
            )
        return list(rows)

    async def list_team_rows(self, *, workspace_id: str | None = None) -> list[Row]:
        t = engine_teams
        stmt = sa.select(t).where(t.c.archived.is_(False))
        if workspace_id is not None:
            stmt = stmt.where(sa.or_(t.c.workspace_id == workspace_id, t.c.workspace_id.is_(None)))
        async with self.db.connect() as conn:
            return list((await conn.execute(stmt.order_by(t.c.team_id, t.c.version))).mappings().all())

    async def archive_team(self, team_id: str) -> int:
        async with self.db.begin() as conn:
            res = await conn.execute(
                engine_teams.update().where(engine_teams.c.team_id == team_id).values(archived=True)
            )
        return int(res.rowcount or 0)

    # ------------------------------------------------------------------ task -> team
    async def set_task_team(self, task_id: str, *, team_id: str | None, team: TeamSpec | None) -> None:
        async with self.db.begin() as conn:
            await conn.execute(engine_task_teams.delete().where(engine_task_teams.c.task_id == task_id))
            await conn.execute(
                engine_task_teams.insert().values(
                    task_id=task_id,
                    team_id=team_id,
                    team=team.model_dump(mode="json") if team is not None else None,
                    created_at=utcnow(),
                )
            )

    async def task_team(self, task_id: str) -> tuple[str | None, TeamSpec | None] | None:
        t = engine_task_teams
        async with self.db.connect() as conn:
            row = (await conn.execute(sa.select(t).where(t.c.task_id == task_id))).mappings().first()
        if row is None:
            return None
        return row["team_id"], TeamSpec.model_validate(row["team"]) if row["team"] else None

    async def delete_for_task(self, task_id: str, run_ids: Sequence[str]) -> None:
        async with self.db.begin() as conn:
            await conn.execute(engine_task_teams.delete().where(engine_task_teams.c.task_id == task_id))
            if run_ids:
                for table in (engine_team_runs, engine_team_assignments):
                    await conn.execute(table.delete().where(table.c.run_id.in_(list(run_ids))))

    # ------------------------------------------------------------------ team runs
    async def team_run_row(self, run_id: str, node_id: str) -> Row | None:
        t = engine_team_runs
        async with self.db.connect() as conn:
            return (
                (await conn.execute(sa.select(t).where(t.c.run_id == run_id, t.c.node_id == node_id)))
                .mappings()
                .first()
            )

    async def team_run_rows(self, run_id: str) -> list[Row]:
        t = engine_team_runs
        async with self.db.connect() as conn:
            return list(
                (await conn.execute(sa.select(t).where(t.c.run_id == run_id).order_by(t.c.created_at))).mappings().all()
            )

    async def insert_team_run(
        self,
        *,
        run_id: str,
        node_id: str,
        team_id: str | None,
        team_version: int | None,
        team_name: str,
        spec: TeamSpec,
        state: TeamState,
    ) -> None:
        now = utcnow()
        async with self.db.begin() as conn:
            await conn.execute(
                engine_team_runs.insert().values(
                    run_id=run_id,
                    node_id=node_id,
                    team_id=team_id,
                    team_version=team_version,
                    team_name=team_name,
                    spec=spec.model_dump(mode="json"),
                    state=state.model_dump(mode="json"),
                    status="running",
                    created_at=now,
                    updated_at=now,
                )
            )

    async def update_team_run(self, run_id: str, node_id: str, **values: Any) -> None:
        values.setdefault("updated_at", utcnow())
        t = engine_team_runs
        async with self.db.begin() as conn:
            await conn.execute(t.update().where(t.c.run_id == run_id, t.c.node_id == node_id).values(**values))

    async def save_state(self, run_id: str, node_id: str, state: TeamState) -> None:
        await self.update_team_run(run_id, node_id, state=state.model_dump(mode="json"))

    # ------------------------------------------------------------------ assignments
    async def insert_assignment(self, a: TeamAssignment) -> None:
        async with self.db.begin() as conn:
            await conn.execute(engine_team_assignments.insert().values(**_assignment_values(a)))

    async def save_assignment(self, a: TeamAssignment) -> None:
        values = _assignment_values(a)
        values.pop("id")
        t = engine_team_assignments
        async with self.db.begin() as conn:
            await conn.execute(t.update().where(t.c.id == a.id).values(**values))

    async def assignments(self, run_id: str, node_id: str | None = None) -> list[TeamAssignment]:
        t = engine_team_assignments
        stmt = sa.select(t).where(t.c.run_id == run_id)
        if node_id is not None:
            stmt = stmt.where(t.c.node_id == node_id)
        async with self.db.connect() as conn:
            rows = (await conn.execute(stmt.order_by(t.c.node_id, t.c.seq))).mappings().all()
        return [assignment_from_row(r) for r in rows]
