"""HTTP API under ``/api/engine``. Approvals are decided through ``/api/approvals``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, Query, Response

from aistudio.contracts.engine import Run, Task, TaskCreate
from aistudio.contracts.flows import FlowGraph, FlowMode
from aistudio.core.text import slugify
from aistudio.engine.models import (
    AgentStatsReport,
    CheckpointInfo,
    Evidence,
    FlowCreate,
    FlowUpdate,
    FlowVersionInfo,
    GateResult,
    ModeInfo,
    QualityBreakdown,
    QueueEntry,
    RatingBody,
    SavedFlow,
    Schedule,
    ScheduleCreate,
    ScheduleUpdate,
    StartBody,
    TaskCreateBody,
    TaskDetail,
    TaskUpdate,
    TimelinePage,
    ValidationReport,
)
from aistudio.engine.modes import MODE_INFO
from aistudio.engine.service import FlowEngineImpl

ExportFmt = Literal["md", "html", "json"]
_EXT = {"md": "md", "html": "html", "json": "json"}


def build_router(get_engine: Callable[[], FlowEngineImpl]) -> APIRouter:
    r = APIRouter(prefix="/engine", tags=["engine"])

    # ------------------------------------------------------------------ tasks
    @r.get("/tasks", response_model=list[Task])
    async def list_tasks(
        workspace_id: str | None = None,
        status: str | None = Query(default=None, description="Virgülle ayrılmış durumlar"),
        mode: str | None = None,
        source: str | None = None,
        q: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[Task]:
        statuses = [s for s in status.split(",") if s] if status else None
        return await get_engine().list_tasks(
            workspace_id=workspace_id, statuses=statuses, mode=mode, source=source, query=q, limit=limit, offset=offset
        )

    @r.post("/tasks", response_model=TaskDetail, status_code=201)
    async def create_task(body: TaskCreateBody) -> TaskDetail:
        engine = get_engine()
        req = body.model_dump(exclude={"start_on_reset"})
        task = await engine.create_task(TaskCreate.model_validate(req), start_on_reset=body.start_on_reset)
        return await engine.task_detail(task.id)

    @r.get("/tasks/{task_id}", response_model=TaskDetail)
    async def get_task(task_id: str) -> TaskDetail:
        return await get_engine().task_detail(task_id)

    @r.patch("/tasks/{task_id}", response_model=Task)
    async def update_task(task_id: str, body: TaskUpdate) -> Task:
        return await get_engine().update_task(task_id, body)

    @r.delete("/tasks/{task_id}", status_code=204)
    async def delete_task(task_id: str) -> Response:
        await get_engine().delete_task(task_id)
        return Response(status_code=204)

    @r.post("/tasks/{task_id}/start", response_model=TaskDetail)
    async def start_task(task_id: str, body: StartBody | None = None) -> TaskDetail:
        engine = get_engine()
        body = body or StartBody()
        if body.now:
            await engine.start(task_id)
        else:
            await engine.enqueue(task_id, start_on_reset=body.start_on_reset)
        return await engine.task_detail(task_id)

    @r.post("/tasks/{task_id}/cancel", response_model=Task)
    async def cancel_task(task_id: str) -> Task:
        return await get_engine().cancel_task(task_id)

    @r.get("/tasks/{task_id}/quality", response_model=QualityBreakdown)
    async def task_quality(task_id: str) -> QualityBreakdown:
        return await get_engine().quality(task_id)

    @r.post("/tasks/{task_id}/rating", response_model=QualityBreakdown)
    async def rate_task(task_id: str, body: RatingBody) -> QualityBreakdown:
        return await get_engine().rate_task(task_id, body.rating, body.note)

    @r.get("/tasks/{task_id}/export")
    async def export_task(task_id: str, format: ExportFmt = "md") -> Response:
        engine = get_engine()
        content, media = await engine.export_task(task_id, format)
        task = await engine.get_task(task_id)
        name = f"{slugify(task.title, fallback='gorev')}.{_EXT[format]}"
        return Response(content, media_type=media, headers={"content-disposition": f'attachment; filename="{name}"'})

    @r.get("/queue", response_model=list[QueueEntry])
    async def queue(workspace_id: str | None = None) -> list[QueueEntry]:
        return await get_engine().queue(workspace_id)

    # ------------------------------------------------------------------ runs
    @r.get("/runs/{run_id}", response_model=Run)
    async def get_run(run_id: str) -> Run:
        return await get_engine().get_run(run_id)

    @r.post("/runs/{run_id}/cancel", status_code=204)
    async def cancel_run(run_id: str) -> Response:
        await get_engine().cancel(run_id)
        return Response(status_code=204)

    @r.post("/runs/{run_id}/nodes/{node_id}/retry", response_model=Run)
    async def retry_node(run_id: str, node_id: str) -> Run:
        engine = get_engine()
        await engine.retry_node(run_id, node_id)
        return await engine.get_run(run_id)

    @r.get("/runs/{run_id}/gates", response_model=list[GateResult])
    async def run_gates(run_id: str) -> list[GateResult]:
        engine = get_engine()
        await engine.store.run_row(run_id)
        return await engine.store.gate_results(run_id)

    @r.get("/runs/{run_id}/evidence", response_model=list[Evidence])
    async def run_evidence(run_id: str) -> list[Evidence]:
        engine = get_engine()
        await engine.store.run_row(run_id)
        return await engine.store.evidence(run_id=run_id)

    @r.get("/runs/{run_id}/checkpoints", response_model=list[CheckpointInfo])
    async def run_checkpoints(run_id: str) -> list[CheckpointInfo]:
        return await get_engine().list_checkpoints(run_id)

    @r.post("/runs/{run_id}/checkpoints/{checkpoint_id}/restore", response_model=Run)
    async def restore_checkpoint(run_id: str, checkpoint_id: str) -> Run:
        return await get_engine().restore_checkpoint(run_id, checkpoint_id)

    @r.get("/runs/{run_id}/timeline", response_model=TimelinePage)
    async def run_timeline(run_id: str, after_id: int | None = None, limit: int = 2000) -> TimelinePage:
        return await get_engine().timeline(run_id, after_id=after_id, limit=limit)

    @r.get("/runs/{run_id}/export")
    async def export_run(run_id: str, format: ExportFmt = "md") -> Response:
        content, media = await get_engine().export_run(run_id, format)
        name = f"{run_id}.{_EXT[format]}"
        return Response(content, media_type=media, headers={"content-disposition": f'attachment; filename="{name}"'})

    # ------------------------------------------------------------------ flows & modes
    @r.get("/modes", response_model=list[ModeInfo])
    async def list_modes() -> list[ModeInfo]:
        return list(MODE_INFO.values())

    @r.get("/modes/{mode}", response_model=FlowGraph)
    async def mode_graph(mode: FlowMode, workspace_id: str) -> FlowGraph:
        return await get_engine().graph_for_mode(mode, workspace_id=workspace_id)

    @r.get("/flows", response_model=list[SavedFlow])
    async def list_flows(workspace_id: str | None = None) -> list[SavedFlow]:
        return await get_engine().list_flows(workspace_id)

    @r.post("/flows", response_model=SavedFlow, status_code=201)
    async def create_flow(body: FlowCreate) -> SavedFlow:
        return await get_engine().create_flow(body)

    @r.post("/flows/validate", response_model=ValidationReport)
    async def validate_flow(graph: FlowGraph) -> ValidationReport:
        return await get_engine().validate(graph)

    @r.get("/flows/{flow_id}", response_model=SavedFlow)
    async def get_flow(flow_id: str) -> SavedFlow:
        return await get_engine().get_flow(flow_id)

    @r.put("/flows/{flow_id}", response_model=SavedFlow)
    async def update_flow(flow_id: str, body: FlowUpdate) -> SavedFlow:
        return await get_engine().update_flow(flow_id, body)

    @r.delete("/flows/{flow_id}", status_code=204)
    async def delete_flow(flow_id: str) -> Response:
        await get_engine().delete_flow(flow_id)
        return Response(status_code=204)

    @r.get("/flows/{flow_id}/versions", response_model=list[FlowVersionInfo])
    async def flow_versions(flow_id: str) -> list[FlowVersionInfo]:
        return await get_engine().flow_versions(flow_id)

    @r.get("/flows/{flow_id}/versions/{version}", response_model=SavedFlow)
    async def flow_version(flow_id: str, version: int) -> SavedFlow:
        return await get_engine().get_flow(flow_id, version)

    # ------------------------------------------------------------------ schedules
    @r.get("/schedules", response_model=list[Schedule])
    async def list_schedules(workspace_id: str | None = None) -> list[Schedule]:
        return await get_engine().list_schedules(workspace_id)

    @r.post("/schedules", response_model=Schedule, status_code=201)
    async def create_schedule(body: ScheduleCreate) -> Schedule:
        return await get_engine().create_schedule(body)

    @r.get("/schedules/{schedule_id}", response_model=Schedule)
    async def get_schedule(schedule_id: str) -> Schedule:
        return await get_engine().get_schedule(schedule_id)

    @r.patch("/schedules/{schedule_id}", response_model=Schedule)
    async def update_schedule(schedule_id: str, body: ScheduleUpdate) -> Schedule:
        return await get_engine().update_schedule(schedule_id, body)

    @r.delete("/schedules/{schedule_id}", status_code=204)
    async def delete_schedule(schedule_id: str) -> Response:
        await get_engine().delete_schedule(schedule_id)
        return Response(status_code=204)

    @r.post("/schedules/{schedule_id}/run", response_model=Task)
    async def run_schedule(schedule_id: str) -> Task:
        return await get_engine().fire_schedule(schedule_id)

    # ------------------------------------------------------------------ stats
    @r.get("/stats/agents", response_model=AgentStatsReport)
    async def agent_stats(workspace_id: str | None = None, days: int | None = None) -> AgentStatsReport:
        return await get_engine().agent_stats(workspace_id=workspace_id, days=days)

    return r
