"""``FlowEngineImpl``: tasks, runs, flows, schedules, checkpoints (registered as ``FlowEngine``)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel

from aistudio.contracts.agents import AgentProfile
from aistudio.contracts.approvals import ApprovalStatus
from aistudio.contracts.common import PROVIDERS, Provider
from aistudio.contracts.engine import NodeRun, NodeStatus, Run, Task, TaskCreate
from aistudio.contracts.flows import (
    AdvisorNodeConfig,
    AgentNodeConfig,
    FlowGraph,
    FlowMode,
    FlowSettings,
    GateKind,
    GateNodeConfig,
    SynthesisNodeConfig,
)
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, NotFound, StudioError, ValidationFailed
from aistudio.core.events import Severity
from aistudio.core.ids import new_id
from aistudio.core.text import truncate
from aistudio.engine import export as export_mod
from aistudio.engine import quality as quality_mod
from aistudio.engine.executor import RunExecutor
from aistudio.engine.models import (
    AgentStatsReport,
    CheckpointInfo,
    FlowCreate,
    FlowUpdate,
    FlowVersionInfo,
    QualityBreakdown,
    QueueEntry,
    RunState,
    SavedFlow,
    Schedule,
    ScheduleCreate,
    ScheduleTemplate,
    ScheduleUpdate,
    TaskDetail,
    TaskUpdate,
    TimelinePage,
    ValidationReport,
)
from aistudio.engine.modes import build_mode_graph
from aistudio.engine.nodes.base import NodeContext
from aistudio.engine.runtime import EngineRuntime
from aistudio.engine.scheduler import Scheduler, next_fire, validate_cron
from aistudio.engine.store import EngineStore, Row, task_from_row
from aistudio.engine.templates import TemplateFailed
from aistudio.engine.templates import render as render_template
from aistudio.engine.validation import validate_graph

log = logging.getLogger(__name__)

PROVIDER_LABEL: dict[str, str] = {"claude": "Claude", "codex": "Codex"}


class FlowEngineImpl:
    def __init__(self, ctx: AppContext) -> None:
        self.rt = EngineRuntime(ctx, EngineStore(ctx.db))
        self.executors: dict[str, RunExecutor] = {}
        self.scheduler = Scheduler(self)
        self._task_locks: dict[str, asyncio.Lock] = {}
        self._scheduler_task: asyncio.Task[None] | None = None

    @property
    def store(self) -> EngineStore:
        return self.rt.store

    # ------------------------------------------------------------------ lifecycle
    async def startup(self, *, run_scheduler: bool = True) -> None:
        await self.resume_all()
        if run_scheduler:
            self._scheduler_task = self.rt.ctx.spawn(self.scheduler.run_forever(), name="engine-scheduler")

    async def shutdown(self) -> None:
        if self._scheduler_task is not None:
            self._scheduler_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._scheduler_task
            self._scheduler_task = None
        for ex in list(self.executors.values()):
            await ex.shutdown()
        self.executors.clear()

    async def resume_all(self) -> list[str]:
        resumed: list[str] = []
        for row in await self.store.run_rows(statuses=["running", "waiting"]):
            if row["id"] in self.executors:
                continue
            try:
                ex = await RunExecutor.load(self.rt, row["id"], on_finished=self._finished)
            except Exception as e:
                log.exception("could not resume run %s", row["id"])
                message = f"Koşu yeniden başlatılamadı: {e}"
                now = utcnow()
                await self.store.update_run(row["id"], status="failed", error=message, finished_at=now)
                await self.store.update_task(row["task_id"], status="failed", error=message, finished_at=now)
                continue
            self.executors[row["id"]] = ex
            ex.start(resume=True)
            resumed.append(row["id"])
        return resumed

    def _finished(self, ex: RunExecutor) -> None:
        if self.executors.get(ex.run_id) is ex:
            self.executors.pop(ex.run_id, None)
        self.scheduler.wake()

    def active_run_count(self) -> int:
        """Runs holding a queue slot: running (not merely waiting for an approval/limit) and not finishing."""
        return sum(
            1
            for ex in self.executors.values()
            if ex.status == "running" and ex.final_status is None and not ex.finished.is_set()
        )

    def node_context(self, run_id: str | None, node_id: str | None) -> NodeContext | None:
        if not run_id or not node_id:
            return None
        ex = self.executors.get(run_id)
        return ex.contexts.get(node_id) if ex else None

    async def current_node_run_id(self, run_id: str, node_id: str) -> str | None:
        nctx = self.node_context(run_id, node_id)
        if nctx is not None:
            return nctx.node_run_id
        row = await self.store.latest_node_run_row(run_id, node_id)
        return str(row["id"]) if row is not None else None

    async def emit_task(
        self, task: Task, type: str, payload: dict[str, Any], *, severity: Severity = Severity.info
    ) -> None:
        await self.rt.emit(
            type,
            {"task_id": task.id, "title": task.title, **payload},
            severity=severity,
            workspace_id=task.workspace_id,
            task_id=task.id,
            run_id=task.current_run_id,
        )

    # ------------------------------------------------------------------ graphs
    async def _workspace_engine_settings(self, workspace_id: str) -> dict[str, Any]:
        ws = await self.rt.workspaces().get(workspace_id)
        raw = ws.settings.get("engine") if isinstance(ws.settings, dict) else None
        return raw if isinstance(raw, dict) else {}

    async def _default_provider(self, workspace_id: str) -> Provider:
        settings = await self._workspace_engine_settings(workspace_id)
        if settings.get("default_provider") in ("claude", "codex"):
            return settings["default_provider"]
        value = await self.rt.setting("engine.default_provider")
        return value if value in ("claude", "codex") else "claude"

    async def graph_for_mode(self, mode: FlowMode, *, workspace_id: str) -> FlowGraph:
        settings = await self._workspace_engine_settings(workspace_id)
        primary = await self._default_provider(workspace_id)
        # Global Settings → Limitler defaults, then the workspace's own flow settings on top.
        flow_settings = FlowSettings(limit_policy=await self.rt.default_limit_policy())
        if isinstance(settings.get("flow_settings"), dict):
            try:
                flow_settings = FlowSettings.model_validate(
                    {**flow_settings.model_dump(mode="json"), **settings["flow_settings"]}
                )
            except ValueError:
                log.warning("invalid flow_settings for workspace %s", workspace_id)
        return build_mode_graph(mode, primary=primary, settings=flow_settings)

    async def resolve_graph(self, task: Task, row: Row | None = None) -> FlowGraph:
        """Explicit graph > studio > saved flow > mode template."""
        row = row if row is not None else await self.store.task_row(task.id)
        if row["graph"]:
            return FlowGraph.model_validate(row["graph"])
        if task.studio_id:
            studios = self.rt.studios()
            if studios is not None:
                return await studios.instantiate(
                    task.studio_id, workspace_id=task.workspace_id, inputs={**task.inputs, "prompt": task.prompt}
                )
            await self.emit_task(
                task,
                "task.warning",
                {"message": "Stüdyo servisi hazır değil; seçilen mod şablonu kullanılıyor."},
                severity=Severity.normal,
            )
        if task.flow_id:
            return (await self.store.get_flow(task.flow_id)).graph
        return await self.graph_for_mode(task.mode, workspace_id=task.workspace_id)

    async def validate(self, graph: FlowGraph) -> ValidationReport:
        mgr = self.rt.maybe_agents()

        async def resolve(profile_id: str) -> AgentProfile | None:
            if mgr is None:
                return None
            try:
                return await mgr.resolve_profile(profile_id)
            except Exception:
                return None

        return await validate_graph(graph, resolve_profile=resolve)

    async def _ensure_valid(self, graph: FlowGraph) -> None:
        report = await self.validate(graph)
        if not report.ok:
            raise ValidationFailed(
                f"Akış geçersiz: {report.errors[0].message}",
                details={"errors": [e.model_dump() for e in report.errors]},
            )

    async def required_providers(self, graph: FlowGraph, workspace_id: str) -> set[Provider]:
        default = await self._default_provider(workspace_id)
        mgr = self.rt.maybe_agents()
        out: set[Provider] = set()
        for node in graph.nodes:
            cfg = node.config
            if isinstance(cfg, AgentNodeConfig | AdvisorNodeConfig | SynthesisNodeConfig):
                provider: Provider | None = cfg.provider
                if cfg.profile_id and mgr is not None:
                    with contextlib.suppress(Exception):
                        provider = (await mgr.resolve_profile(cfg.profile_id)).provider
                out.add(provider or default)
            if isinstance(cfg, GateNodeConfig) and cfg.gate == GateKind.cross_review:
                out.update(("claude", "codex"))
        return out

    # ------------------------------------------------------------------ limits & queue
    async def limit_hold(
        self, task: Task, row: Row, *, now: datetime, poll_seconds: float
    ) -> tuple[datetime, str] | None:
        """Keep a queued task from starting while the limits it needs are exhausted.

        ``queue`` policy: wait until every required provider is available. ``switch_provider``: wait
        only when no provider at all is available. ``ask``: never hold (the node asks the user)."""
        limits = self.rt.limits()
        if limits is None:
            return None
        graph = await self.resolve_graph(task, row)
        policy = graph.settings.limit_policy.on_exhausted
        if policy == "ask":
            return None
        providers = await self.required_providers(graph, task.workspace_id)
        if policy == "switch_provider":
            providers = set(PROVIDERS)
        unavailable: dict[str, datetime | None] = {}
        for p in sorted(providers):
            check = await limits.is_available(p)
            if not check.ok:
                unavailable[p] = check.resets_at
        if not unavailable or (policy == "switch_provider" and len(unavailable) < len(providers)):
            return None
        resets = [r for r in unavailable.values() if r is not None and r > now]
        until = now + timedelta(seconds=poll_seconds)
        if resets:
            until = max(resets) if policy == "queue" else min(resets)
        names = ", ".join(PROVIDER_LABEL.get(p, p) for p in unavailable)
        return until, f"{names} limiti dolu; limit sıfırlanınca başlayacak."

    async def _reset_hold(self, task: Task) -> tuple[datetime, str] | None:
        """'Start when limits reset': hold until the next reset of the providers the flow needs."""
        limits = self.rt.limits()
        if limits is None:
            return None
        graph = await self.resolve_graph(task)
        now = utcnow()
        resets: list[datetime] = []
        for p in sorted(await self.required_providers(graph, task.workspace_id)):
            windows = await limits.current(p)
            upcoming = [w for w in windows if w.resets_at is not None and w.resets_at > now]
            short = [w for w in upcoming if w.window in ("five_hour", "primary")] or upcoming
            if short:
                soonest = min(short, key=lambda w: w.resets_at or now)
                if soonest.resets_at is not None:
                    resets.append(soonest.resets_at)
        if not resets:
            return None
        return max(resets), "Limitler sıfırlanınca başlayacak."

    async def queue(self, workspace_id: str | None = None) -> list[QueueEntry]:
        rows = await self.store.list_task_rows(workspace_id=workspace_id, statuses=["queued"], order="queue", limit=500)
        return [
            QueueEntry(task=task_from_row(r), position=i + 1, hold_until=r["hold_until"], hold_reason=r["hold_reason"])
            for i, r in enumerate(rows)
        ]

    # ------------------------------------------------------------------ tasks
    async def create_task(self, req: TaskCreate, *, start_on_reset: bool = False, dispatch: bool = True) -> Task:
        ws_svc = self.rt.workspaces()
        ws = await ws_svc.get(req.workspace_id)
        prompt = req.prompt.strip()
        if not prompt:
            raise ValidationFailed("Görev istemi boş olamaz.")
        title = req.title.strip() or truncate(prompt.splitlines()[0], 80, marker="…")
        if req.repo_ids is not None:
            known = {r.id for r in await ws_svc.repos(ws.id)}
            unknown = [r for r in req.repo_ids if r not in known]
            if unknown:
                raise ValidationFailed("Seçilen repo bu çalışma alanında yok.", details={"repo_ids": unknown})
        graph_json: dict[str, Any] | None = None
        if req.graph is not None:
            await self._ensure_valid(req.graph)
            graph_json = req.graph.model_dump(mode="json")
        elif req.flow_id:
            await self._ensure_valid((await self.store.get_flow(req.flow_id)).graph)
        elif req.studio_id is None and req.mode == FlowMode.custom:
            raise ValidationFailed("Özel mod için kayıtlı bir akış seçin veya tuvalde bir akış çizin.")
        now = utcnow()
        task_id = new_id("task")
        await self.store.insert_task(
            {
                "id": task_id,
                "workspace_id": ws.id,
                "title": title,
                "prompt": prompt,
                "mode": req.mode.value,
                "flow_id": req.flow_id,
                "studio_id": req.studio_id,
                "graph": graph_json,
                "repo_ids": req.repo_ids,
                "base_ref": req.base_ref,
                "inputs": dict(req.inputs),
                "budget": req.budget.model_dump(mode="json") if req.budget else None,
                "priority": req.priority,
                "status": "queued" if req.start else "draft",
                "scheduled_at": req.scheduled_at,
                "source": req.source,
                "source_ref": req.source_ref,
                "start_on_reset": start_on_reset,
                "created_at": now,
                "updated_at": now,
            }
        )
        task = await self.store.get_task(task_id)
        await self.emit_task(
            task,
            "task.created",
            {"mode": task.mode.value, "source": task.source, "priority": task.priority, "status": task.status},
        )
        if req.start:
            await self._after_enqueue(task, start_on_reset=start_on_reset, dispatch=dispatch)
        return await self.store.get_task(task_id)

    async def _after_enqueue(self, task: Task, *, start_on_reset: bool, dispatch: bool) -> None:
        if start_on_reset:
            hold = await self._reset_hold(task)
            if hold is not None:
                await self.store.update_task(task.id, hold_until=hold[0], hold_reason=hold[1])
        if dispatch:
            await self.scheduler.dispatch()
        self.scheduler.wake()

    async def enqueue(self, task_id: str, *, start_on_reset: bool = False) -> Task:
        task = await self.store.get_task(task_id)
        if task.status in ("running", "waiting"):
            raise Conflict("Görev zaten çalışıyor.")
        if task.status == "queued" and not start_on_reset:
            return task
        await self.store.update_task(
            task_id, status="queued", start_on_reset=start_on_reset, hold_until=None, hold_reason=None, error=None
        )
        task = await self.store.get_task(task_id)
        await self.emit_task(task, "task.updated", {"status": "queued"})
        await self._after_enqueue(task, start_on_reset=start_on_reset, dispatch=True)
        return await self.store.get_task(task_id)

    async def start(self, task_id: str) -> Run:
        lock = self._task_locks.setdefault(task_id, asyncio.Lock())
        async with lock:
            row = await self.store.task_row(task_id)
            task = task_from_row(row)
            if task.status in ("running", "waiting"):
                raise Conflict("Görev zaten çalışıyor.")
            graph = await self.resolve_graph(task, row)
            await self._ensure_valid(graph)
            run_id = new_id("run")
            await self.store.insert_run(
                run_id=run_id, task_id=task_id, workspace_id=task.workspace_id, graph=graph, state=RunState()
            )
            now = utcnow()
            await self.store.update_task(
                task_id,
                status="running",
                current_run_id=run_id,
                started_at=now,
                finished_at=None,
                error=None,
                hold_until=None,
                hold_reason=None,
            )
            task = await self.store.get_task(task_id)
            await self.rt.emit(
                "run.started",
                {
                    "run_id": run_id,
                    "task_id": task_id,
                    "mode": task.mode.value,
                    "nodes": [{"id": n.id, "label": n.label, "kind": n.kind.value} for n in graph.nodes],
                },
                severity=Severity.normal if task.source == "schedule" else Severity.info,
                workspace_id=task.workspace_id,
                task_id=task_id,
                run_id=run_id,
            )
            await self.emit_task(task, "task.updated", {"status": "running"})
            ex = await RunExecutor.load(self.rt, run_id, on_finished=self._finished)
            self.executors[run_id] = ex
            ex.start(resume=False)
        return await self.store.get_run(run_id)

    async def cancel(self, run_id: str) -> None:
        ex = self.executors.get(run_id)
        if ex is not None:
            with contextlib.suppress(Conflict):
                await ex.cancel()
                return
        row = await self.store.run_row(run_id)
        if row["status"] not in ("running", "waiting"):
            raise Conflict("Koşu zaten sona ermiş.")
        reason = "Kullanıcı iptal etti."
        approvals = self.rt.approvals()
        for a in await approvals.list(status=ApprovalStatus.pending, workspace_id=row["workspace_id"]):
            if a.run_id == run_id:
                with contextlib.suppress(Exception):
                    await approvals.cancel(a.id, reason)
        now = utcnow()
        await self.store.update_run(run_id, status="cancelled", error=reason, finished_at=now)
        await self.store.update_task(row["task_id"], status="cancelled", error=reason, finished_at=now)
        await self.rt.emit(
            "run.cancelled",
            {"run_id": run_id, "status": "cancelled"},
            workspace_id=row["workspace_id"],
            task_id=row["task_id"],
            run_id=run_id,
        )

    async def cancel_task(self, task_id: str) -> Task:
        task = await self.store.get_task(task_id)
        if task.status in ("draft", "queued"):
            await self.store.update_task(task_id, status="cancelled", finished_at=utcnow())
            task = await self.store.get_task(task_id)
            await self.emit_task(task, "task.updated", {"status": "cancelled"})
            return task
        if task.status in ("running", "waiting") and task.current_run_id:
            await self.cancel(task.current_run_id)
            return await self.store.get_task(task_id)
        raise Conflict("Görev zaten sona ermiş.")

    async def retry_node(self, run_id: str, node_id: str) -> None:
        ex = self.executors.get(run_id)
        if ex is not None and ex.main_task is not None and not ex.main_task.done():
            await ex.retry(node_id)
            return
        row = await self.store.run_row(run_id)
        graph = FlowGraph.model_validate(row["graph"])
        if node_id not in {n.id for n in graph.nodes}:
            raise NotFound("Düğüm bulunamadı.")
        if row["status"] == "completed":
            raise Conflict("Tamamlanmış bir koşuda düğüm yeniden denenemez.")
        state = RunState.model_validate(row["state"] or {})
        if state.status.get(node_id) not in ("failed", "cancelled", "skipped"):
            raise Conflict("Yalnız başarısız, atlanmış veya iptal edilmiş düğümler yeniden denenebilir.")
        task = await self.store.get_task(row["task_id"])
        if task.current_run_id != run_id and task.status in ("running", "waiting"):
            raise Conflict("Görevin başka bir koşusu çalışıyor.")
        now = utcnow()
        await self.store.update_run(run_id, status="running", error=None, finished_at=None)
        await self.store.update_task(
            task.id, status="running", current_run_id=run_id, error=None, finished_at=None, started_at=now
        )
        await self.rt.emit(
            "run.reopened",
            {"run_id": run_id, "node_id": node_id},
            workspace_id=task.workspace_id,
            task_id=task.id,
            run_id=run_id,
        )
        ex = await RunExecutor.load(self.rt, run_id, on_finished=self._finished)
        self.executors[run_id] = ex
        ex.start(resume=True, retry_node=node_id)

    async def get_task(self, task_id: str) -> Task:
        return await self.store.get_task(task_id)

    async def get_run(self, run_id: str) -> Run:
        return self._with_states(await self.store.get_run(run_id))

    async def task_document(self, task_id: str) -> TaskDocument:
        task = await self.store.get_task(task_id)
        run = await self.store.get_run(task.current_run_id) if task.current_run_id else None
        latest: dict[str, NodeRun] = {}
        if run is not None:
            for nr in run.nodes:
                cur = latest.get(nr.node_id)
                if cur is None or nr.attempt >= cur.attempt:
                    latest[nr.node_id] = nr
        labels = {n.id: n.label for n in run.graph.nodes} if run is not None else {}
        nodes = {
            nid: {"output": nr.output or "", "data": nr.data or {}, "status": nr.status, "label": labels.get(nid, nid)}
            for nid, nr in latest.items()
        }
        last_output = ""
        if run is not None:
            finished = [nr for nr in latest.values() if nr.output and nr.status == "passed"]
            finished.sort(key=lambda nr: nr.finished_at or nr.started_at or datetime.min.replace(tzinfo=UTC))
            last_output = finished[-1].output or "" if finished else ""
        template: str | None = None
        studios = self.rt.studios()
        if task.studio_id and studios is not None:
            version = (task.source_ref or {}).get("version")
            with contextlib.suppress(Exception):
                studio = await studios.get(task.studio_id, int(version) if version else None)
                template = studio.output_template
        if template:
            # Same variables the reader's client-side renderer offers (studios/document.ts).
            gate: dict[str, dict[str, str]] = {}
            if run is not None and "gate." in template:
                for ev in await self.store.evidence(run_id=run.id):
                    if ev.source != "gate" or not ev.node_id:
                        continue
                    block = f"**{ev.title}**" + (f"\n\n```\n{ev.content}\n```" if ev.content else "")
                    prev = gate.get(ev.node_id, {}).get("evidence")
                    gate[ev.node_id] = {"evidence": f"{prev}\n\n{block}" if prev else block}
            workspace_name = ""
            with contextlib.suppress(Exception):
                workspace_name = (await self.rt.workspaces().get(task.workspace_id)).name
            variables = {
                "input": {**task.inputs, "prompt": task.prompt},
                "nodes": nodes,
                "gate": gate,
                "task": {"id": task.id, "title": task.title},
                "workspace": {"name": workspace_name},
            }
            try:
                markdown = _tidy_markdown(render_template(template, variables))
            except TemplateFailed as e:
                return TaskDocument(task_id=task.id, markdown=last_output, source="last_output", warning=e.message)
            if re.sub(r"[-#*\s]", "", markdown):  # a template whose sections all came out empty
                return TaskDocument(task_id=task.id, markdown=markdown, source="template")
        return TaskDocument(task_id=task.id, markdown=last_output, source="last_output")

    def _with_states(self, run: Run) -> Run:
        ex = self.executors.get(run.id)
        states = dict(ex.state.status) if ex is not None else latest_node_states(run.nodes)
        for node in run.graph.nodes:  # nodes that never ran yet
            states.setdefault(node.id, "pending")
        return run.model_copy(update={"node_states": states})

    async def task_detail(self, task_id: str) -> TaskDetail:
        row = await self.store.task_row(task_id)
        task = task_from_row(row)
        current = self._with_states(await self.store.get_run(task.current_run_id)) if task.current_run_id else None
        return TaskDetail(
            task=task,
            runs=await self.store.run_summaries(task_id),
            current_run=current,
            quality=QualityBreakdown.model_validate(row["quality"]) if row["quality"] else None,
            rating=row["rating"],
            rating_note=row["rating_note"],
            error=row["error"],
            hold_until=row["hold_until"],
            hold_reason=row["hold_reason"],
            start_on_reset=bool(row["start_on_reset"]),
            has_explicit_graph=row["graph"] is not None,
        )

    async def list_tasks(
        self,
        *,
        workspace_id: str | None = None,
        statuses: list[str] | None = None,
        mode: str | None = None,
        source: str | None = None,
        query: str | None = None,
        limit: int = 100,
        offset: int = 0,
        studio_id: str | None = None,
    ) -> list[Task]:
        rows = await self.store.list_task_rows(
            workspace_id=workspace_id,
            statuses=statuses,
            mode=mode,
            source=source,
            query=query,
            studio_id=studio_id,
            limit=max(1, min(limit, 500)),
            offset=max(0, offset),
        )
        return [task_from_row(r) for r in rows]

    async def update_task(self, task_id: str, body: TaskUpdate) -> Task:
        task = await self.store.get_task(task_id)
        if task.status not in ("draft", "queued"):
            raise Conflict("Yalnız taslak veya kuyruktaki görevler düzenlenebilir.")
        values = body.model_dump(exclude_unset=True)
        if "title" in values and not str(values["title"] or "").strip():
            raise ValidationFailed("Görev başlığı boş olamaz.")
        if "prompt" in values and not str(values["prompt"] or "").strip():
            raise ValidationFailed("Görev istemi boş olamaz.")
        if values.get("repo_ids") is not None:
            known = {r.id for r in await self.rt.workspaces().repos(task.workspace_id)}
            if any(r not in known for r in values["repo_ids"]):
                raise ValidationFailed("Seçilen repo bu çalışma alanında yok.")
        if "budget" in values:
            values["budget"] = body.budget.model_dump(mode="json") if body.budget else None
        if not values:
            return task
        await self.store.update_task(task_id, **values)
        task = await self.store.get_task(task_id)
        await self.emit_task(task, "task.updated", {"fields": sorted(values)})
        self.scheduler.wake()
        return task

    async def delete_task(self, task_id: str) -> None:
        task = await self.store.get_task(task_id)
        if task.status in ("running", "waiting"):
            raise Conflict("Çalışan bir görev silinemez; önce iptal edin.")
        await self.store.delete_task(task_id)
        await self.emit_task(task, "task.deleted", {})

    async def rate_task(self, task_id: str, rating: int, note: str | None = None) -> QualityBreakdown:
        task = await self.store.get_task(task_id)
        await self.store.update_task(task_id, rating=rating, rating_note=note)
        await self.emit_task(task, "task.rated", {"rating": rating})
        return await self.quality(task_id)

    async def quality(self, task_id: str) -> QualityBreakdown:
        task = await self.store.get_task(task_id)
        if not task.current_run_id:
            return QualityBreakdown(formula=quality_mod.FORMULA)
        run_row = await self.store.run_row(task.current_run_id)
        if run_row["status"] == "completed":
            return await quality_mod.compute_and_store(self.rt, task_id, task.current_run_id)
        return await quality_mod.compute_for_run(self.rt, task_id, task.current_run_id)

    # ------------------------------------------------------------------ flows
    async def create_flow(self, body: FlowCreate, *, created_by: str = "user") -> SavedFlow:
        if body.workspace_id is not None:
            await self.rt.workspaces().get(body.workspace_id)
        if not body.name.strip():
            raise ValidationFailed("Akış adı boş olamaz.")
        flow_id = new_id("flow")
        await self.store.insert_flow_version(
            flow_id=flow_id,
            version=1,
            workspace_id=body.workspace_id,
            name=body.name.strip(),
            description=body.description,
            graph=body.graph,
            is_template=body.is_template,
            studio_id=body.studio_id,
            created_by=created_by,
        )
        flow = await self.store.get_flow(flow_id)
        await self.rt.emit(
            "flow.saved", {"flow_id": flow_id, "version": 1, "name": flow.name}, workspace_id=body.workspace_id
        )
        return flow

    async def update_flow(self, flow_id: str, body: FlowUpdate, *, created_by: str = "user") -> SavedFlow:
        current = await self.store.get_flow(flow_id)
        version = (await self.store.flow_versions(flow_id))[-1].version + 1
        name = body.name.strip() if body.name is not None else current.name
        if not name:
            raise ValidationFailed("Akış adı boş olamaz.")
        await self.store.insert_flow_version(
            flow_id=flow_id,
            version=version,
            workspace_id=current.workspace_id,
            name=name,
            description=body.description if body.description is not None else current.description,
            graph=body.graph if body.graph is not None else current.graph,
            is_template=body.is_template if body.is_template is not None else current.is_template,
            studio_id=current.studio_id,
            created_by=created_by,
        )
        flow = await self.store.get_flow(flow_id)
        await self.rt.emit(
            "flow.saved", {"flow_id": flow_id, "version": version, "name": flow.name}, workspace_id=flow.workspace_id
        )
        return flow

    async def get_flow(self, flow_id: str, version: int | None = None) -> SavedFlow:
        return await self.store.get_flow(flow_id, version)

    async def list_flows(self, workspace_id: str | None = None) -> list[SavedFlow]:
        return await self.store.list_flows(workspace_id=workspace_id)

    async def flow_versions(self, flow_id: str) -> list[FlowVersionInfo]:
        return await self.store.flow_versions(flow_id)

    async def delete_flow(self, flow_id: str) -> None:
        flow = await self.store.get_flow(flow_id)
        await self.store.archive_flow(flow_id)
        await self.rt.emit("flow.deleted", {"flow_id": flow_id, "name": flow.name}, workspace_id=flow.workspace_id)

    # ------------------------------------------------------------------ schedules
    async def _check_template(self, template: ScheduleTemplate) -> None:
        if not template.prompt.strip():
            raise ValidationFailed("Zamanlanmış görevin istemi boş olamaz.")
        if template.flow_id:
            await self.store.get_flow(template.flow_id)
        elif template.studio_id is None and template.mode == FlowMode.custom:
            raise ValidationFailed("Özel mod için kayıtlı bir akış seçin.")

    async def create_schedule(self, body: ScheduleCreate) -> Schedule:
        await self.rt.workspaces().get(body.workspace_id)
        if not body.name.strip():
            raise ValidationFailed("Zamanlama adı boş olamaz.")
        validate_cron(body.cron, body.timezone)
        await self._check_template(body.template)
        now = utcnow()
        sched = Schedule(
            id=new_id("sched"),
            workspace_id=body.workspace_id,
            name=body.name.strip(),
            cron=body.cron.strip(),
            timezone=body.timezone,
            template=body.template,
            enabled=body.enabled,
            next_run_at=next_fire(body.cron, body.timezone, now) if body.enabled else None,
            created_at=now,
            updated_at=now,
        )
        await self.store.insert_schedule(sched)
        await self.rt.emit(
            "schedule.created",
            {"schedule_id": sched.id, "name": sched.name, "cron": sched.cron},
            workspace_id=sched.workspace_id,
        )
        self.scheduler.wake()
        return sched

    async def update_schedule(self, schedule_id: str, body: ScheduleUpdate) -> Schedule:
        current = await self.store.get_schedule(schedule_id)
        values = body.model_dump(exclude_unset=True)
        cron = values.get("cron", current.cron)
        tz = values.get("timezone", current.timezone)
        enabled = values.get("enabled", current.enabled)
        validate_cron(cron, tz)
        if body.template is not None:
            await self._check_template(body.template)
            values["template"] = body.template.model_dump(mode="json")
        if "name" in values and not str(values["name"] or "").strip():
            raise ValidationFailed("Zamanlama adı boş olamaz.")
        if {"cron", "timezone", "enabled"} & set(values):
            values["next_run_at"] = next_fire(cron, tz, utcnow()) if enabled else None
        await self.store.update_schedule(schedule_id, **values)
        sched = await self.store.get_schedule(schedule_id)
        await self.rt.emit(
            "schedule.updated", {"schedule_id": schedule_id, "fields": sorted(values)}, workspace_id=sched.workspace_id
        )
        self.scheduler.wake()
        return sched

    async def delete_schedule(self, schedule_id: str) -> None:
        sched = await self.store.get_schedule(schedule_id)
        await self.store.delete_schedule(schedule_id)
        await self.rt.emit("schedule.deleted", {"schedule_id": schedule_id}, workspace_id=sched.workspace_id)

    async def list_schedules(self, workspace_id: str | None = None) -> list[Schedule]:
        return await self.store.list_schedules(workspace_id=workspace_id)

    async def get_schedule(self, schedule_id: str) -> Schedule:
        return await self.store.get_schedule(schedule_id)

    async def fire_schedule(self, schedule_id: str) -> Task:
        sched = await self.store.get_schedule(schedule_id)
        task_id = await self.scheduler.fire(sched, manual=True)
        if task_id is None:
            raise ValidationFailed("Zamanlanmış görev oluşturulamadı.")
        await self.scheduler.dispatch()
        return await self.store.get_task(task_id)

    # ------------------------------------------------------------------ checkpoints
    async def list_checkpoints(self, run_id: str) -> list[CheckpointInfo]:
        await self.store.run_row(run_id)
        return await self.store.checkpoints(run_id)

    async def restore_checkpoint(self, run_id: str, checkpoint_id: str) -> Run:
        row = await self.store.checkpoint_row(checkpoint_id)
        if row["run_id"] != run_id:
            raise NotFound("Checkpoint bu koşuya ait değil.")
        run_row = await self.store.run_row(run_id)
        task = await self.store.get_task(run_row["task_id"])
        if task.current_run_id != run_id and task.status in ("running", "waiting"):
            raise Conflict("Görevin başka bir koşusu çalışıyor.")
        ex = self.executors.get(run_id)
        if ex is not None:
            await ex.halt("Checkpoint'e geri dönülüyor.")
            self.executors.pop(run_id, None)
        if row["gitops_checkpoint_id"]:
            await self.rt.worktrees().restore(row["gitops_checkpoint_id"])
        mem = self.rt.memory()
        if row["memory_commit"] and mem is not None:
            try:
                await mem.restore(task.workspace_id, row["memory_commit"])
            except StudioError:
                log.warning("memory restore failed for checkpoint %s", checkpoint_id, exc_info=True)
        snapshot = row["snapshot"] or {}
        state = RunState.model_validate(snapshot.get("state") or {})
        for nid, status in list(state.status.items()):
            if status in ("running", "waiting"):
                state.status[nid] = "pending"
                if nid not in state.ready:
                    state.ready.append(nid)
        await self.store.save_state(run_id, state)
        await self.store.update_run(run_id, status="running", error=None, finished_at=None)
        await self.store.update_task(task.id, status="running", current_run_id=run_id, error=None, finished_at=None)
        await self.rt.emit(
            "checkpoint.restored",
            {"run_id": run_id, "checkpoint_id": checkpoint_id, "node_id": row["node_id"], "label": row["label"]},
            severity=Severity.normal,
            workspace_id=task.workspace_id,
            task_id=task.id,
            run_id=run_id,
        )
        new_ex = await RunExecutor.load(self.rt, run_id, on_finished=self._finished)
        self.executors[run_id] = new_ex
        new_ex.start(resume=True)
        return await self.store.get_run(run_id)

    # ------------------------------------------------------------------ replay, export, stats
    async def timeline(self, run_id: str, *, after_id: int | None = None, limit: int = 2000) -> TimelinePage:
        return await export_mod.timeline(self.rt, run_id, after_id=after_id, limit=limit)

    async def export_run(self, run_id: str, fmt: export_mod.ExportFormat) -> tuple[str, str]:
        row = await self.store.run_row(run_id)
        doc = await export_mod.build_export(self.rt, task_id=row["task_id"], run_ids=[run_id])
        return export_mod.render_export(doc, fmt)

    async def export_task(self, task_id: str, fmt: export_mod.ExportFormat) -> tuple[str, str]:
        doc = await export_mod.build_export(self.rt, task_id=task_id)
        return export_mod.render_export(doc, fmt)

    async def agent_stats(self, *, workspace_id: str | None = None, days: int | None = None) -> AgentStatsReport:
        since = utcnow() - timedelta(days=days) if days else None
        return await quality_mod.agent_stats(self.rt, workspace_id=workspace_id, since=since)


def latest_node_states(nodes: list[NodeRun]) -> dict[str, NodeStatus]:
    """Each node's status from its most recent attempt (highest attempt, then latest start)."""
    floor = datetime.min.replace(tzinfo=UTC)

    def order(nr: NodeRun) -> tuple[int, datetime]:
        return nr.attempt, nr.started_at or nr.finished_at or floor

    best: dict[str, NodeRun] = {}
    for nr in nodes:
        cur = best.get(nr.node_id)
        if cur is None or order(nr) >= order(cur):
            best[nr.node_id] = nr
    return {nid: nr.status for nid, nr in best.items()}


class TaskDocument(BaseModel):
    task_id: str
    markdown: str
    source: Literal["template", "last_output"]
    warning: str | None = None


def _tidy_markdown(text: str) -> str:
    """Collapse the blank-line runs a template leaves around empty sections."""
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n"
