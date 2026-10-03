"""Database access for the engine tables (SQLAlchemy Core)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.engine import RowMapping

from aistudio.contracts.engine import NodeRun, Run, Task
from aistudio.contracts.flows import FlowGraph, FlowMode
from aistudio.contracts.limits import Budget
from aistudio.core.clock import utcnow
from aistudio.core.errors import NotFound
from aistudio.core.ids import new_id
from aistudio.engine.models import (
    CheckpointInfo,
    Evidence,
    FlowVersionInfo,
    GateResult,
    RunState,
    RunSummary,
    SavedFlow,
    Schedule,
    ScheduleTemplate,
)
from aistudio.engine.tables import (
    engine_checkpoints,
    engine_evidence,
    engine_flows,
    engine_gate_results,
    engine_node_runs,
    engine_runs,
    engine_schedules,
    engine_task_teams,
    engine_tasks,
    engine_team_assignments,
    engine_team_runs,
)
from aistudio.storage.db import Database

Row = RowMapping

_TASK_FIELDS = tuple(Task.model_fields)


def task_from_row(row: Row) -> Task:
    data = {k: row[k] for k in _TASK_FIELDS if k in row}
    data["mode"] = FlowMode(row["mode"])
    data["inputs"] = row["inputs"] or {}
    data["budget"] = Budget.model_validate(row["budget"]) if row["budget"] else None
    return Task.model_validate(data)


def node_run_from_row(row: Row) -> NodeRun:
    return NodeRun(
        id=row["id"],
        run_id=row["run_id"],
        node_id=row["node_id"],
        status=row["status"],
        attempt=row["attempt"],
        session_ids=list(row["session_ids"] or []),
        worktree_ids=list(row["worktree_ids"] or []),
        output=row["output"],
        data=row["data"],
        error=row["error"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


class EngineStore:
    def __init__(self, db: Database) -> None:
        self.db = db

    # ------------------------------------------------------------------ tasks
    async def insert_task(self, values: dict[str, Any]) -> None:
        async with self.db.begin() as conn:
            await conn.execute(engine_tasks.insert().values(**values))

    async def task_row(self, task_id: str) -> Row:
        async with self.db.connect() as conn:
            row = (await conn.execute(sa.select(engine_tasks).where(engine_tasks.c.id == task_id))).mappings().first()
        if row is None:
            raise NotFound("Görev bulunamadı.")
        return row

    async def get_task(self, task_id: str) -> Task:
        return task_from_row(await self.task_row(task_id))

    async def update_task(self, task_id: str, **values: Any) -> None:
        values.setdefault("updated_at", utcnow())
        async with self.db.begin() as conn:
            await conn.execute(engine_tasks.update().where(engine_tasks.c.id == task_id).values(**values))

    async def delete_task(self, task_id: str) -> None:
        async with self.db.begin() as conn:
            run_ids = (
                (await conn.execute(sa.select(engine_runs.c.id).where(engine_runs.c.task_id == task_id)))
                .scalars()
                .all()
            )
            if run_ids:
                for table in (
                    engine_node_runs,
                    engine_gate_results,
                    engine_checkpoints,
                    engine_team_runs,
                    engine_team_assignments,
                ):
                    await conn.execute(table.delete().where(table.c.run_id.in_(run_ids)))
                await conn.execute(engine_runs.delete().where(engine_runs.c.id.in_(run_ids)))
            await conn.execute(engine_evidence.delete().where(engine_evidence.c.task_id == task_id))
            await conn.execute(engine_task_teams.delete().where(engine_task_teams.c.task_id == task_id))
            await conn.execute(engine_tasks.delete().where(engine_tasks.c.id == task_id))

    async def list_task_rows(
        self,
        *,
        workspace_id: str | None = None,
        statuses: Sequence[str] | None = None,
        mode: str | None = None,
        source: str | None = None,
        query: str | None = None,
        limit: int = 100,
        offset: int = 0,
        order: str = "recent",
        studio_id: str | None = None,
    ) -> list[Row]:
        t = engine_tasks
        stmt = sa.select(t)
        if studio_id is not None:
            stmt = stmt.where(t.c.studio_id == studio_id)
        if workspace_id is not None:
            stmt = stmt.where(t.c.workspace_id == workspace_id)
        if statuses:
            stmt = stmt.where(t.c.status.in_(list(statuses)))
        if mode is not None:
            stmt = stmt.where(t.c.mode == mode)
        if source is not None:
            stmt = stmt.where(t.c.source == source)
        if query:
            like = f"%{query}%"
            stmt = stmt.where(sa.or_(t.c.title.like(like), t.c.prompt.like(like)))
        if order == "queue":
            stmt = stmt.order_by(t.c.priority.desc(), t.c.created_at.asc())
        else:
            stmt = stmt.order_by(t.c.created_at.desc())
        stmt = stmt.limit(limit).offset(offset)
        async with self.db.connect() as conn:
            return list((await conn.execute(stmt)).mappings().all())

    # ------------------------------------------------------------------ runs
    async def insert_run(
        self, *, run_id: str, task_id: str, workspace_id: str, graph: FlowGraph, state: RunState
    ) -> None:
        now = utcnow()
        async with self.db.begin() as conn:
            await conn.execute(
                engine_runs.insert().values(
                    id=run_id,
                    task_id=task_id,
                    workspace_id=workspace_id,
                    graph=graph.model_dump(mode="json"),
                    status="running",
                    state=state.model_dump(mode="json"),
                    started_at=now,
                    updated_at=now,
                )
            )

    async def run_row(self, run_id: str) -> Row:
        async with self.db.connect() as conn:
            row = (await conn.execute(sa.select(engine_runs).where(engine_runs.c.id == run_id))).mappings().first()
        if row is None:
            raise NotFound("Koşu bulunamadı.")
        return row

    async def update_run(self, run_id: str, **values: Any) -> None:
        values.setdefault("updated_at", utcnow())
        async with self.db.begin() as conn:
            await conn.execute(engine_runs.update().where(engine_runs.c.id == run_id).values(**values))

    async def update_run_and_task(
        self, run_id: str, task_id: str, run_values: dict[str, Any], task_values: dict[str, Any]
    ) -> None:
        """Update a run and its task in one transaction (their statuses never disagree)."""
        now = utcnow()
        async with self.db.begin() as conn:
            await conn.execute(
                engine_runs.update().where(engine_runs.c.id == run_id).values(**{"updated_at": now, **run_values})
            )
            await conn.execute(
                engine_tasks.update().where(engine_tasks.c.id == task_id).values(**{"updated_at": now, **task_values})
            )

    async def save_state(self, run_id: str, state: RunState) -> None:
        await self.update_run(run_id, state=state.model_dump(mode="json"))

    async def get_run(self, run_id: str) -> Run:
        row = await self.run_row(run_id)
        return Run(
            id=row["id"],
            task_id=row["task_id"],
            workspace_id=row["workspace_id"],
            graph=FlowGraph.model_validate(row["graph"]),
            status=row["status"],
            nodes=await self.list_node_runs(run_id),
            started_at=row["started_at"],
            finished_at=row["finished_at"],
        )

    async def run_summaries(self, task_id: str) -> list[RunSummary]:
        t = engine_runs
        async with self.db.connect() as conn:
            rows = (
                (await conn.execute(sa.select(t).where(t.c.task_id == task_id).order_by(t.c.started_at.asc())))
                .mappings()
                .all()
            )
        return [
            RunSummary(
                id=r["id"],
                status=r["status"],
                error=r["error"],
                started_at=r["started_at"],
                finished_at=r["finished_at"],
            )
            for r in rows
        ]

    async def run_rows(
        self, *, statuses: Sequence[str] | None = None, workspace_id: str | None = None, since: datetime | None = None
    ) -> list[Row]:
        t = engine_runs
        stmt = sa.select(t)
        if statuses:
            stmt = stmt.where(t.c.status.in_(list(statuses)))
        if workspace_id is not None:
            stmt = stmt.where(t.c.workspace_id == workspace_id)
        if since is not None:
            stmt = stmt.where(t.c.started_at >= since)
        async with self.db.connect() as conn:
            return list((await conn.execute(stmt.order_by(t.c.started_at.asc()))).mappings().all())

    # ------------------------------------------------------------------ node runs
    async def insert_node_run(
        self, *, run_id: str, node_id: str, kind: str, label: str, attempt: int, status: str
    ) -> str:
        nrid = new_id("nrun")
        now = utcnow()
        async with self.db.begin() as conn:
            await conn.execute(
                engine_node_runs.insert().values(
                    id=nrid,
                    run_id=run_id,
                    node_id=node_id,
                    kind=kind,
                    label=label,
                    attempt=attempt,
                    status=status,
                    session_ids=[],
                    worktree_ids=[],
                    state={},
                    created_at=now,
                    started_at=now if status in ("running", "waiting") else None,
                    finished_at=now if status in ("skipped", "cancelled") else None,
                )
            )
        return nrid

    async def update_node_run(self, node_run_id: str, **values: Any) -> None:
        async with self.db.begin() as conn:
            await conn.execute(engine_node_runs.update().where(engine_node_runs.c.id == node_run_id).values(**values))

    async def node_run_row(self, node_run_id: str) -> Row:
        async with self.db.connect() as conn:
            row = (
                (await conn.execute(sa.select(engine_node_runs).where(engine_node_runs.c.id == node_run_id)))
                .mappings()
                .first()
            )
        if row is None:
            raise NotFound("Düğüm koşusu bulunamadı.")
        return row

    async def node_run_rows(self, run_id: str) -> list[Row]:
        t = engine_node_runs
        async with self.db.connect() as conn:
            return list(
                (await conn.execute(sa.select(t).where(t.c.run_id == run_id).order_by(t.c.created_at, t.c.id)))
                .mappings()
                .all()
            )

    async def list_node_runs(self, run_id: str) -> list[NodeRun]:
        return [node_run_from_row(r) for r in await self.node_run_rows(run_id)]

    async def latest_node_run_row(self, run_id: str, node_id: str) -> Row | None:
        t = engine_node_runs
        async with self.db.connect() as conn:
            return (
                (
                    await conn.execute(
                        sa.select(t)
                        .where(t.c.run_id == run_id, t.c.node_id == node_id)
                        .order_by(t.c.created_at.desc(), t.c.id.desc())
                        .limit(1)
                    )
                )
                .mappings()
                .first()
            )

    async def all_node_run_rows(
        self, *, since: datetime | None = None, kinds: Sequence[str] | None = None
    ) -> list[Row]:
        t = engine_node_runs
        stmt = sa.select(t)
        if since is not None:
            stmt = stmt.where(t.c.created_at >= since)
        if kinds:
            stmt = stmt.where(t.c.kind.in_(list(kinds)))
        async with self.db.connect() as conn:
            return list((await conn.execute(stmt)).mappings().all())

    # ------------------------------------------------------------------ gates & evidence
    async def insert_gate_result(self, result: GateResult) -> None:
        async with self.db.begin() as conn:
            await conn.execute(engine_gate_results.insert().values(**result.model_dump(mode="python")))

    async def gate_results(
        self, run_id: str | None = None, *, run_ids: Sequence[str] | None = None
    ) -> list[GateResult]:
        t = engine_gate_results
        stmt = sa.select(t).order_by(t.c.created_at, t.c.id)
        if run_id is not None:
            stmt = stmt.where(t.c.run_id == run_id)
        if run_ids is not None:
            stmt = stmt.where(t.c.run_id.in_(list(run_ids)))
        async with self.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [GateResult.model_validate(dict(r)) for r in rows]

    async def insert_evidence(self, ev: Evidence) -> None:
        async with self.db.begin() as conn:
            await conn.execute(engine_evidence.insert().values(**ev.model_dump(mode="python", exclude={"label"})))

    async def evidence(self, *, run_id: str | None = None, node_run_id: str | None = None) -> list[Evidence]:
        t = engine_evidence
        stmt = sa.select(t).order_by(t.c.created_at, t.c.id)
        if run_id is not None:
            stmt = stmt.where(t.c.run_id == run_id)
        if node_run_id is not None:
            stmt = stmt.where(t.c.node_run_id == node_run_id)
        async with self.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [Evidence.model_validate(dict(r)) for r in rows]

    # ------------------------------------------------------------------ flows
    async def insert_flow_version(
        self,
        *,
        flow_id: str,
        version: int,
        workspace_id: str | None,
        name: str,
        description: str,
        graph: FlowGraph,
        is_template: bool,
        studio_id: str | None,
        created_by: str = "user",
    ) -> None:
        async with self.db.begin() as conn:
            await conn.execute(
                engine_flows.insert().values(
                    flow_id=flow_id,
                    version=version,
                    workspace_id=workspace_id,
                    name=name,
                    description=description,
                    graph=graph.model_dump(mode="json"),
                    is_template=is_template,
                    studio_id=studio_id,
                    created_by=created_by,
                    archived=False,
                    created_at=utcnow(),
                )
            )

    async def _flow_rows(self, flow_id: str) -> list[Row]:
        t = engine_flows
        async with self.db.connect() as conn:
            return list(
                (await conn.execute(sa.select(t).where(t.c.flow_id == flow_id).order_by(t.c.version.asc())))
                .mappings()
                .all()
            )

    @staticmethod
    def _saved_flow(row: Row, first_created_at: datetime) -> SavedFlow:
        return SavedFlow(
            id=row["flow_id"],
            version=row["version"],
            workspace_id=row["workspace_id"],
            name=row["name"],
            description=row["description"] or "",
            graph=FlowGraph.model_validate(row["graph"]),
            is_template=row["is_template"],
            studio_id=row["studio_id"],
            created_by=row["created_by"],
            created_at=row["created_at"],
            first_created_at=first_created_at,
        )

    async def get_flow(self, flow_id: str, version: int | None = None) -> SavedFlow:
        rows = [r for r in await self._flow_rows(flow_id) if not r["archived"]]
        if not rows:
            raise NotFound("Akış bulunamadı.")
        if version is None:
            return self._saved_flow(rows[-1], rows[0]["created_at"])
        for r in rows:
            if r["version"] == version:
                return self._saved_flow(r, rows[0]["created_at"])
        raise NotFound("Akışın bu sürümü bulunamadı.")

    async def flow_versions(self, flow_id: str) -> list[FlowVersionInfo]:
        rows = [r for r in await self._flow_rows(flow_id) if not r["archived"]]
        if not rows:
            raise NotFound("Akış bulunamadı.")
        return [
            FlowVersionInfo(
                version=r["version"], name=r["name"], created_by=r["created_by"], created_at=r["created_at"]
            )
            for r in rows
        ]

    async def list_flows(self, *, workspace_id: str | None = None, include_global: bool = True) -> list[SavedFlow]:
        t = engine_flows
        stmt = sa.select(t).where(t.c.archived.is_(False))
        if workspace_id is not None:
            cond = t.c.workspace_id == workspace_id
            if include_global:
                cond = sa.or_(cond, t.c.workspace_id.is_(None))
            stmt = stmt.where(cond)
        async with self.db.connect() as conn:
            rows = (await conn.execute(stmt.order_by(t.c.flow_id, t.c.version))).mappings().all()
        latest: dict[str, Row] = {}
        first: dict[str, datetime] = {}
        for r in rows:
            first.setdefault(r["flow_id"], r["created_at"])
            latest[r["flow_id"]] = r
        flows = [self._saved_flow(r, first[fid]) for fid, r in latest.items()]
        return sorted(flows, key=lambda f: f.created_at, reverse=True)

    async def archive_flow(self, flow_id: str) -> None:
        async with self.db.begin() as conn:
            res = await conn.execute(
                engine_flows.update().where(engine_flows.c.flow_id == flow_id).values(archived=True)
            )
        if res.rowcount == 0:
            raise NotFound("Akış bulunamadı.")

    # ------------------------------------------------------------------ schedules
    @staticmethod
    def schedule_from_row(row: Row) -> Schedule:
        data = dict(row)
        data["template"] = ScheduleTemplate.model_validate(row["template"] or {})
        return Schedule.model_validate(data)

    async def insert_schedule(self, sched: Schedule) -> None:
        values = sched.model_dump(mode="python")
        values["template"] = sched.template.model_dump(mode="json")
        async with self.db.begin() as conn:
            await conn.execute(engine_schedules.insert().values(**values))

    async def get_schedule(self, schedule_id: str) -> Schedule:
        async with self.db.connect() as conn:
            row = (
                (await conn.execute(sa.select(engine_schedules).where(engine_schedules.c.id == schedule_id)))
                .mappings()
                .first()
            )
        if row is None:
            raise NotFound("Zamanlama bulunamadı.")
        return self.schedule_from_row(row)

    async def list_schedules(self, *, workspace_id: str | None = None) -> list[Schedule]:
        t = engine_schedules
        stmt = sa.select(t).order_by(t.c.created_at)
        if workspace_id is not None:
            stmt = stmt.where(t.c.workspace_id == workspace_id)
        async with self.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [self.schedule_from_row(r) for r in rows]

    async def update_schedule(self, schedule_id: str, **values: Any) -> None:
        values.setdefault("updated_at", utcnow())
        async with self.db.begin() as conn:
            await conn.execute(engine_schedules.update().where(engine_schedules.c.id == schedule_id).values(**values))

    async def delete_schedule(self, schedule_id: str) -> None:
        async with self.db.begin() as conn:
            res = await conn.execute(engine_schedules.delete().where(engine_schedules.c.id == schedule_id))
        if res.rowcount == 0:
            raise NotFound("Zamanlama bulunamadı.")

    async def due_schedules(self, now: datetime) -> list[Schedule]:
        t = engine_schedules
        async with self.db.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        sa.select(t).where(t.c.enabled.is_(True), t.c.next_run_at.is_not(None), t.c.next_run_at <= now)
                    )
                )
                .mappings()
                .all()
            )
        return [self.schedule_from_row(r) for r in rows]

    async def next_schedule_time(self) -> datetime | None:
        t = engine_schedules
        async with self.db.connect() as conn:
            value = (await conn.execute(sa.select(sa.func.min(t.c.next_run_at)).where(t.c.enabled.is_(True)))).scalar()
        if value is None:
            return None
        return datetime.fromisoformat(value) if isinstance(value, str) else value

    # ------------------------------------------------------------------ checkpoints
    async def insert_checkpoint(self, info: CheckpointInfo, snapshot: dict[str, Any]) -> None:
        async with self.db.begin() as conn:
            await conn.execute(engine_checkpoints.insert().values(**info.model_dump(mode="python"), snapshot=snapshot))

    async def checkpoints(self, run_id: str) -> list[CheckpointInfo]:
        t = engine_checkpoints
        async with self.db.connect() as conn:
            rows = (
                (await conn.execute(sa.select(t).where(t.c.run_id == run_id).order_by(t.c.created_at, t.c.id)))
                .mappings()
                .all()
            )
        return [CheckpointInfo.model_validate({k: v for k, v in r.items() if k != "snapshot"}) for r in rows]

    async def checkpoint_row(self, checkpoint_id: str) -> Row:
        async with self.db.connect() as conn:
            row = (
                (await conn.execute(sa.select(engine_checkpoints).where(engine_checkpoints.c.id == checkpoint_id)))
                .mappings()
                .first()
            )
        if row is None:
            raise NotFound("Checkpoint bulunamadı.")
        return row
