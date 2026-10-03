"""Run executor: one asyncio task per run, driving the flow graph.

State machine (see ``graph.py`` for edge semantics):

* Finished nodes deliver ``live`` tokens on the edges they take and ``dead`` tokens on the
  forward edges they do not take (dead-path elimination), so joins never wait forever.
* A loop edge (``failed``/``false`` back edge) resets the region between its target and the
  gate, increments the gate's loop counter and re-triggers the target with ``feedback``. When the
  counter reaches ``max_rounds``/``max_loops`` a ``gate.loop_exhausted`` event is emitted and the
  gate counts as an ordinary failure.
* The run completes when nothing is running or ready: ``completed`` if some sink passed and no
  sink failed, otherwise ``failed``.

Everything the executor needs to continue lives in ``engine_runs.state`` and
``engine_node_runs.state``; ``RunExecutor.load(..., resume=True)`` rebuilds a run after a restart.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Literal

from aistudio.contracts.agents import AgentRole
from aistudio.contracts.approvals import ApprovalStatus
from aistudio.contracts.common import Environment, Provider
from aistudio.contracts.engine import Task
from aistudio.contracts.flows import (
    ConditionNodeConfig,
    DeployNodeConfig,
    FlowGraph,
    GateNodeConfig,
    JoinNodeConfig,
    NodeKind,
)
from aistudio.contracts.workspaces import Repo, Workspace
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, StudioError
from aistudio.core.events import Severity
from aistudio.core.ids import new_id
from aistudio.core.text import truncate
from aistudio.engine.graph import FAIL_CONDITIONS, PASS_CONDITIONS, Topology
from aistudio.engine.models import CheckpointInfo, FeedbackInfo, GateResult, RunState
from aistudio.engine.nodes.base import NodeContext, NodeOutcome
from aistudio.engine.runtime import EngineRuntime
from aistudio.engine.store import task_from_row
from aistudio.engine.templates import format_findings

log = logging.getLogger(__name__)

_CHECKPOINT_KINDS = frozenset(
    {
        NodeKind.agent,
        NodeKind.advisor,
        NodeKind.gate,
        NodeKind.compare,
        NodeKind.synthesis,
        NodeKind.merge,
        NodeKind.git,
        NodeKind.deploy,
        NodeKind.human,
        NodeKind.team,
    }
)


@dataclass
class NodeResult:
    node_run_id: str
    status: str
    output: str | None
    data: dict[str, Any] | None
    attempt: int


@dataclass
class _Msg:
    kind: Literal["done", "retry", "cancel", "halt"]
    node_id: str | None = None
    node_run_id: str | None = None
    outcome: NodeOutcome | None = None
    reply: asyncio.Future[None] | None = None
    reason: str | None = None


class RunExecutor:
    def __init__(
        self,
        rt: EngineRuntime,
        *,
        run_id: str,
        task: Task,
        graph: FlowGraph,
        state: RunState,
        workspace: Workspace,
        repos: list[Repo],
        on_finished: Callable[[RunExecutor], None] | None = None,
    ) -> None:
        self.rt = rt
        self.run_id = run_id
        self.task = task
        self.graph = graph
        self.topo = Topology.build(graph)
        self.state = state
        self.workspace = workspace
        self.repos = repos
        self.results: dict[str, NodeResult] = {}
        self.gate_cache: dict[str, GateResult] = {}
        self.running: dict[str, asyncio.Task[None]] = {}
        self.contexts: dict[str, NodeContext] = {}
        self.inbox: asyncio.Queue[_Msg] = asyncio.Queue()
        self.user_cancelled = False
        self.halted = False
        self.finished = asyncio.Event()
        self.main_task: asyncio.Task[None] | None = None
        self.final_status: str | None = None
        self._on_finished = on_finished
        self._agent_sem = asyncio.Semaphore(max(1, graph.settings.max_parallel_agents))
        self._run_status: str = "running"
        self._production: bool | None = None
        self._memory_cache: dict[str, dict[str, str]] = {}
        self._persist_lock = asyncio.Lock()

    # ------------------------------------------------------------------ construction
    @classmethod
    async def load(
        cls, rt: EngineRuntime, run_id: str, *, on_finished: Callable[[RunExecutor], None] | None = None
    ) -> RunExecutor:
        row = await rt.store.run_row(run_id)
        task = task_from_row(await rt.store.task_row(row["task_id"]))
        graph = FlowGraph.model_validate(row["graph"])
        state = RunState.model_validate(row["state"] or {})
        ws_svc = rt.workspaces()
        workspace = await ws_svc.get(task.workspace_id)
        repos = await ws_svc.repos(task.workspace_id)
        ex = cls(
            rt,
            run_id=run_id,
            task=task,
            graph=graph,
            state=state,
            workspace=workspace,
            repos=repos,
            on_finished=on_finished,
        )
        ex._run_status = row["status"]
        await ex._load_results()
        return ex

    async def _load_results(self) -> None:
        rows = {r["id"]: r for r in await self.rt.store.node_run_rows(self.run_id)}
        for nid, nrid in self.state.latest.items():
            r = rows.get(nrid)
            if r is not None:
                self.results[nid] = NodeResult(
                    node_run_id=nrid, status=r["status"], output=r["output"], data=r["data"], attempt=r["attempt"]
                )
        for g in await self.rt.store.gate_results(self.run_id):
            if self.state.latest.get(g.node_id) == g.node_run_id or g.node_id not in self.gate_cache:
                self.gate_cache[g.node_id] = g

    @property
    def status(self) -> str:
        return self._run_status

    def start(self, *, resume: bool, retry_node: str | None = None) -> asyncio.Task[None]:
        if retry_node is not None:
            self.inbox.put_nowait(_Msg(kind="retry", node_id=retry_node))
        self.main_task = self.rt.ctx.spawn(self._main(resume), name=f"engine-run-{self.run_id}")
        return self.main_task

    # ------------------------------------------------------------------ public commands
    async def _send(self, msg: _Msg) -> None:
        """Deliver a command to the main loop and wait for it to be handled."""
        if self.main_task is None or self.main_task.done():
            raise Conflict("Koşu zaten sona ermiş.")
        fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        msg.reply = fut
        await self.inbox.put(msg)
        await asyncio.wait({fut, self.main_task}, return_when=asyncio.FIRST_COMPLETED)
        if not fut.done():
            raise Conflict("Koşu zaten sona ermiş.")
        fut.result()

    async def cancel(self, reason: str = "Kullanıcı iptal etti.") -> None:
        await self._send(_Msg(kind="cancel", reason=reason))

    async def retry(self, node_id: str) -> None:
        await self._send(_Msg(kind="retry", node_id=node_id))

    async def halt(self, reason: str) -> None:
        """Stop running nodes (cancelling their approvals/sessions) without finishing the run; used
        before restoring a checkpoint."""
        if self.main_task is None or self.main_task.done():
            return
        with contextlib.suppress(Conflict):
            await self._send(_Msg(kind="halt", reason=reason))
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await self.main_task

    async def shutdown(self) -> None:
        """Stop for a studiod shutdown: DB state stays as-is so the run resumes on next start."""
        if self.main_task is not None and not self.main_task.done():
            self.main_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.main_task

    # ------------------------------------------------------------------ helpers used by nodes
    async def persist_state(self) -> None:
        # Serialized and dumped inside the lock: concurrent callers (main loop, node tasks) can never
        # commit an older snapshot over a newer one.
        async with self._persist_lock:
            await self.rt.store.save_state(self.run_id, self.state)

    @asynccontextmanager
    async def agent_slot(self, provider: Provider) -> AsyncIterator[None]:
        provider_sem = await self.rt.provider_slot(provider)
        async with self._agent_sem, provider_sem:
            yield

    async def default_provider(self) -> Provider:
        engine_settings = self.workspace.settings.get("engine") if isinstance(self.workspace.settings, dict) else None
        if isinstance(engine_settings, dict) and engine_settings.get("default_provider") in ("claude", "codex"):
            return engine_settings["default_provider"]
        value = await self.rt.setting("engine.default_provider")
        return value if value in ("claude", "codex") else "claude"

    async def known_session_ids(self) -> set[str]:
        known = set(self.state.sessions.values())
        for row in await self.rt.store.node_run_rows(self.run_id):
            known.update(row["session_ids"] or [])
        return known

    def output_of(self, node_id: str) -> str:
        if node_id in self.state.overrides:
            return self.state.overrides[node_id]
        res = self.results.get(node_id)
        return (res.output or "") if res else ""

    def target_repos(self, node_repo_ids: list[str] | None) -> list[Repo]:
        wanted = node_repo_ids if node_repo_ids is not None else self.task.repo_ids
        if wanted is None:
            return list(self.repos)
        by_id = {r.id: r for r in self.repos}
        return [by_id[r] for r in wanted if r in by_id]

    async def production_target(self) -> bool:
        """True when the flow deploys to a production profile (locked gates cannot be skipped)."""
        if self._production is None:
            prod = False
            deploy = self.rt.deploy()
            for node in self.graph.nodes:
                if isinstance(node.config, DeployNodeConfig) and deploy is not None:
                    try:
                        profile = await deploy.get_profile(node.config.profile_id)
                    except StudioError:
                        continue
                    if profile.environment == Environment.production:
                        prod = True
                        break
            self._production = prod
        return self._production

    async def variables(self, node_id: str, *, role: AgentRole | None = None, attempt: int = 1) -> dict[str, Any]:
        nodes: dict[str, Any] = {}
        for nid, res in self.results.items():
            node = self.topo.nodes.get(nid)
            nodes[nid] = {
                "output": self.output_of(nid),
                "data": res.data or {},
                "status": res.status,
                "label": node.label if node else nid,
            }
        gates = {
            nid: {"evidence": g.evidence, "status": g.status, "summary": g.summary}
            for nid, g in self.gate_cache.items()
        }
        review = self.state.review
        fb = self.state.feedback.get(node_id) or FeedbackInfo()
        findings = review.findings if review else []
        return {
            "input": {**self.task.inputs, "prompt": self.task.prompt},
            "nodes": nodes,
            "gate": gates,
            "review": {
                "findings": findings,
                "text": format_findings(findings),
                "gate": review.gate if review else None,
                "round": review.round if review else 0,
            },
            "feedback": {"text": fb.text, "gate": fb.gate, "round": fb.round},
            "attempt": attempt,
            "memory": await self._memory_vars(role or "writer"),
            "task": {
                "id": self.task.id,
                "title": self.task.title,
                "prompt": self.task.prompt,
                "mode": self.task.mode.value,
                "inputs": self.task.inputs,
            },
            "workspace": {"id": self.workspace.id, "name": self.workspace.name, "slug": self.workspace.slug},
            "repo": {
                r.name: {"id": r.id, "name": r.name, "path": r.path, "default_branch": r.default_branch}
                for r in self.repos
            },
            "run": {"id": self.run_id},
        }

    async def _memory_vars(self, role: str) -> dict[str, str]:
        cached = self._memory_cache.get(role)
        if cached is not None:
            return cached
        out = {"context": "", "facts": "", "boundaries": "", "decisions": ""}
        mem = self.rt.memory()
        if mem is not None:
            ws = self.task.workspace_id
            with contextlib.suppress(Exception):
                out["context"] = await mem.context_for_agent(ws, role=role)  # type: ignore[arg-type]
            with contextlib.suppress(Exception):
                out["facts"] = (await mem.read(ws, "facts.md")).content
            with contextlib.suppress(Exception):
                out["boundaries"] = (await mem.read(ws, "boundaries.md")).content
            with contextlib.suppress(Exception):
                docs = await mem.list_docs(ws)
                out["decisions"] = "\n".join(f"- {d.title} ({d.path})" for d in docs if d.layer == "decisions")
        self._memory_cache[role] = out
        return out

    async def refresh_status(self) -> None:
        statuses = {self.state.status.get(nid) for nid in self.running}
        new = "running"
        if self.running and "running" not in statuses and "waiting" in statuses:
            new = "waiting"
        if new != self._run_status and not self.user_cancelled:
            self._run_status = new
            await self.rt.store.update_run_and_task(self.run_id, self.task.id, {"status": new}, {"status": new})
            await self._emit("run.updated", {"status": new})
            await self._emit(
                "task.updated",
                {"status": new},
            )

    async def _emit(self, type: str, payload: dict[str, Any], *, severity: Severity = Severity.info) -> None:
        await self.rt.emit(
            type,
            {"run_id": self.run_id, "task_id": self.task.id, **payload},
            severity=severity,
            workspace_id=self.task.workspace_id,
            task_id=self.task.id,
            run_id=self.run_id,
        )

    # ------------------------------------------------------------------ main loop
    async def _main(self, resume: bool) -> None:
        try:
            if resume:
                await self._resume_nodes()
                await self._emit("run.resumed", {"running": sorted(self.running), "ready": list(self.state.ready)})
            elif self.topo.entry is not None and not self.state.ready and not self.state.latest:
                self._make_ready(self.topo.entry)
                await self.persist_state()
            while True:
                while not self.inbox.empty():
                    await self._handle(self.inbox.get_nowait())
                if self.user_cancelled or self.halted:
                    break
                await self._launch_ready()
                if not self.running and not self.state.ready:
                    break
                await self._handle(await self.inbox.get())
                if self.user_cancelled or self.halted:
                    break
            if not self.user_cancelled and not self.halted:
                await self._finalize()
        except asyncio.CancelledError:
            # studiod shutdown: leave durable state untouched so the run resumes on restart.
            await self._stop_node_tasks(cleanup=False)
            raise
        except Exception as e:
            log.exception("run %s crashed", self.run_id)
            await self._stop_node_tasks(cleanup=True)
            await self._finish("failed", f"Akış motoru hatası: {e}")
        finally:
            self.finished.set()
            if self._on_finished is not None:
                self._on_finished(self)

    async def _handle(self, msg: _Msg) -> None:
        if msg.kind == "done":
            assert msg.node_id is not None and msg.outcome is not None
            current = self.contexts.get(msg.node_id)
            if current is None or current.node_run_id != msg.node_run_id:
                return  # stale: the node was cancelled (or restarted) after it finished
            await self._on_done(msg.node_id, msg.outcome)
        elif msg.kind == "retry":
            assert msg.node_id is not None
            try:
                await self._do_retry(msg.node_id)
            except Exception as e:
                if msg.reply is not None and not msg.reply.done():
                    msg.reply.set_exception(e)
                return
            if msg.reply is not None and not msg.reply.done():
                msg.reply.set_result(None)
        elif msg.kind == "halt":
            try:
                for nid in list(self.running):
                    await self._cancel_node(nid, msg.reason or "Durduruldu.", cleanup=True)
                self.halted = True
                await self.persist_state()
            finally:
                if msg.reply is not None and not msg.reply.done():
                    msg.reply.set_result(None)
        elif msg.kind == "cancel":
            try:
                await self._do_cancel(msg.reason or "Kullanıcı iptal etti.")
            finally:
                if msg.reply is not None and not msg.reply.done():
                    msg.reply.set_result(None)

    async def _resume_nodes(self) -> None:
        for nid, status in list(self.state.status.items()):
            if status not in ("running", "waiting") or nid in self.running:
                continue
            node = self.topo.nodes.get(nid)
            nrid = self.state.latest.get(nid)
            if node is None or nrid is None:
                continue
            row = await self.rt.store.node_run_row(nrid)
            nctx = NodeContext(self, node, nrid, row["attempt"], dict(row["state"] or {}), resumed=True)
            nctx.session_ids = list(row["session_ids"] or [])
            nctx.worktree_ids = list(row["worktree_ids"] or [])
            nctx.started_at = row["started_at"]
            await self.rt.store.update_node_run(nrid, status="running")
            self.state.status[nid] = "running"
            await nctx.emit("node.resumed", {"kind": node.kind.value, "attempt": row["attempt"]})
            self._spawn(nid, nctx)
        await self.persist_state()

    def _spawn(self, nid: str, nctx: NodeContext) -> None:
        self.contexts[nid] = nctx
        self.running[nid] = asyncio.create_task(self._node_task(nid, nctx), name=f"engine-node-{self.run_id}-{nid}")

    async def _node_task(self, nid: str, nctx: NodeContext) -> None:
        from aistudio.engine.nodes import run_node

        try:
            outcome = await run_node(nctx)
        except asyncio.CancelledError:
            if nctx.cleanup_on_cancel:
                with contextlib.suppress(Exception):
                    await asyncio.shield(nctx.interrupt_sessions())
            raise
        except StudioError as e:  # NodeFailure, Unavailable, TemplateFailed, ...
            outcome = NodeOutcome(status="failed", error=e.message, data=dict(nctx.partial) or None, loopable=False)
        except Exception as e:
            log.exception("node %s of run %s failed", nid, self.run_id)
            outcome = NodeOutcome(
                status="failed", error=f"Beklenmeyen hata: {e}", data=dict(nctx.partial) or None, loopable=False
            )
        with contextlib.suppress(Exception):
            await nctx.close_sessions()
        self.inbox.put_nowait(_Msg(kind="done", node_id=nid, node_run_id=nctx.node_run_id, outcome=outcome))

    def _make_ready(self, nid: str) -> None:
        self.state.status[nid] = "pending"
        self.state.skip_reason.pop(nid, None)
        if nid not in self.state.ready:
            self.state.ready.append(nid)

    async def _launch_ready(self) -> None:
        while self.state.ready:
            nid = self.state.ready.pop(0)
            if nid in self.running:
                continue
            node = self.topo.nodes[nid]
            attempt = self.state.attempts.get(nid, 0) + 1
            self.state.attempts[nid] = attempt
            nrid = await self.rt.store.insert_node_run(
                run_id=self.run_id,
                node_id=nid,
                kind=node.kind.value,
                label=node.label,
                attempt=attempt,
                status="running",
            )
            self.state.latest[nid] = nrid
            self.state.status[nid] = "running"
            self.state.started_nodes += 1
            await self.persist_state()
            nctx = NodeContext(self, node, nrid, attempt)
            await nctx.emit("node.started", {"kind": node.kind.value, "attempt": attempt})
            self._spawn(nid, nctx)
        await self.refresh_status()

    # ------------------------------------------------------------------ completion & routing
    async def _on_done(self, nid: str, outcome: NodeOutcome) -> None:
        self.running.pop(nid, None)
        nctx = self.contexts.pop(nid, None)
        nrid = nctx.node_run_id if nctx else self.state.latest.get(nid, "")
        attempt = nctx.attempt if nctx else self.state.attempts.get(nid, 1)
        node = self.topo.nodes[nid]
        output = self.rt.mask(outcome.output)
        data = self.rt.ctx.masker.mask_obj(outcome.data) if outcome.data is not None else None
        await self.rt.store.update_node_run(
            nrid, status=outcome.status, output=output, data=data, error=outcome.error, finished_at=utcnow()
        )
        self.results[nid] = NodeResult(
            node_run_id=nrid, status=outcome.status, output=output, data=data, attempt=attempt
        )
        self.state.status[nid] = outcome.status
        if outcome.status == "skipped":
            self.state.skip_reason[nid] = "disabled"
        payload: dict[str, Any] = {
            "kind": node.kind.value,
            "attempt": attempt,
            "status": outcome.status,
            "output_preview": truncate(output or "", 400),
        }
        if outcome.branch is not None:
            payload["branch"] = outcome.branch
        if outcome.error:
            payload["error"] = outcome.error
        etype = {"passed": "node.completed", "failed": "node.failed", "skipped": "node.skipped"}[outcome.status]
        if nctx is not None:
            await nctx.emit(etype, payload, severity=Severity.normal if outcome.status == "failed" else Severity.info)
        await self._route(nid, outcome)
        await self.persist_state()
        if (
            outcome.status == "passed"
            and self.graph.settings.checkpoint_every_node
            and node.kind in _CHECKPOINT_KINDS
            and self.state.status.get(nid) == "passed"
        ):
            await self._checkpoint(nid, nrid)

    def _loop_limit(self, nid: str) -> int:
        cfg = self.topo.nodes[nid].config
        if isinstance(cfg, GateNodeConfig):
            return cfg.max_rounds
        if isinstance(cfg, ConditionNodeConfig):
            return cfg.max_loops
        return 0

    async def _route(self, nid: str, outcome: NodeOutcome) -> None:
        node = self.topo.nodes[nid]
        out = self.topo.outgoing[nid]
        ok = outcome.status in ("passed", "skipped")
        if ok:
            if node.kind == NodeKind.condition:
                take = {e.id for e in out if e.condition == "default" or e.condition == outcome.branch}
            else:
                take = {e.id for e in out if e.condition in PASS_CONDITIONS}
        else:
            take = {e.id for e in out if e.condition in FAIL_CONDITIONS}
        back = [e for e in out if e.id in take and self.topo.is_back(e)]
        looping = False
        if back and not ok and not outcome.loopable:
            back = []
        if back:
            limit = self._loop_limit(nid)
            used = self.state.loops.get(nid, 0)
            if used >= limit:
                await self._emit(
                    "gate.loop_exhausted",
                    {"node_id": nid, "label": node.label, "rounds": used, "max_rounds": limit, "error": outcome.error},
                    severity=Severity.high,
                )
                message = f"Tur sınırı aşıldı ({used}/{limit})."
                outcome.error = f"{outcome.error} {message}".strip() if outcome.error else message
                await self.rt.store.update_node_run(self.state.latest[nid], status="failed", error=outcome.error)
                self.state.status[nid] = "failed"
                if nid in self.results:
                    self.results[nid].status = "failed"
                ok = False
                take = {e.id for e in out if e.condition in FAIL_CONDITIONS and not self.topo.is_back(e)}
                back = []
            else:
                self.state.loops[nid] = used + 1
                looping = True
                for e in back:
                    await self._loop_back(e.target, nid, outcome, used + 1, limit, e.id)
        forward_taken = False
        for e in self.topo.forward_out(nid):
            if e.id in take:
                forward_taken = True
                await self._deliver(e.id, live=True)
            elif not looping:
                await self._deliver(e.id, live=False)
        if not ok and not looping and not forward_taken:
            self.state.unhandled[nid] = outcome.error or "Düğüm başarısız oldu."
        elif nid in self.state.unhandled:
            self.state.unhandled.pop(nid, None)

    async def _deliver(self, edge_id: str, *, live: bool) -> None:
        edge = self.topo.edges[edge_id]
        self.state.deliveries[edge_id] = "live" if live else "dead"
        if live:
            await self._emit(
                "run.edge",
                {"edge_id": edge_id, "source": edge.source, "target": edge.target, "condition": edge.condition},
            )
        await self._evaluate(edge.target)

    async def _evaluate(self, nid: str) -> None:
        if self.state.status.get(nid, "pending") != "pending" or nid in self.state.ready or nid in self.running:
            return
        back_live = [e for e in self.topo.back_in(nid) if self.state.deliveries.get(e.id) == "live"]
        if back_live:
            for e in back_live:
                self.state.deliveries.pop(e.id, None)
            self._make_ready(nid)
            return
        fwd = self.topo.forward_in(nid)
        values = [self.state.deliveries.get(e.id) for e in fwd]
        resolved = all(v is not None for v in values)
        cfg = self.topo.nodes[nid].config
        if isinstance(cfg, JoinNodeConfig) and cfg.mode == "any":
            if "live" in values:
                self._make_ready(nid)
                await self._cancel_exclusive_branches(nid)
            elif resolved:
                await self._skip(nid)
            return
        if resolved and fwd:
            if "live" in values:
                self._make_ready(nid)
            else:
                await self._skip(nid)

    async def _skip(self, nid: str) -> None:
        node = self.topo.nodes[nid]
        self.state.status[nid] = "skipped"
        self.state.skip_reason[nid] = "dead_path"
        nrid = await self.rt.store.insert_node_run(
            run_id=self.run_id,
            node_id=nid,
            kind=node.kind.value,
            label=node.label,
            attempt=max(1, self.state.attempts.get(nid, 0)),
            status="skipped",
        )
        self.state.latest[nid] = nrid
        self.results[nid] = NodeResult(node_run_id=nrid, status="skipped", output=None, data=None, attempt=1)
        await self.rt.emit(
            "node.skipped",
            {"node_id": nid, "node_run_id": nrid, "label": node.label, "kind": node.kind.value, "reason": "dead_path"},
            workspace_id=self.task.workspace_id,
            task_id=self.task.id,
            run_id=self.run_id,
        )
        for e in self.topo.forward_out(nid):
            await self._deliver(e.id, live=False)

    async def _loop_back(
        self, target: str, gate_id: str, outcome: NodeOutcome, round_no: int, limit: int, edge_id: str
    ) -> None:
        region = self.topo.between(target, gate_id)
        for nid in region:
            if nid in self.running and nid != gate_id:
                await self._cancel_node(nid, "Döngü nedeniyle yeniden çalışacak.", cleanup=True)
            self.state.status[nid] = "pending"
            self.state.skip_reason.pop(nid, None)
            self.state.unhandled.pop(nid, None)
            if nid in self.state.ready:
                self.state.ready.remove(nid)
        for e in self.topo.edges.values():
            if not self.topo.is_back(e) and e.source in region and e.target in region:
                self.state.deliveries.pop(e.id, None)
        feedback = outcome.feedback or outcome.error or ""
        self.state.feedback[target] = FeedbackInfo(text=feedback, gate=gate_id, round=round_no)
        await self._emit(
            "run.loop",
            {
                "from": gate_id,
                "to": target,
                "round": round_no,
                "max_rounds": limit,
                "reason": truncate(feedback, 500),
            },
            severity=Severity.normal,
        )
        self.state.deliveries[edge_id] = "live"
        await self._evaluate(target)

    async def _cancel_exclusive_branches(self, join_id: str) -> None:
        """join(any): cancel running nodes whose only purpose was to feed this join."""
        ancestors = self.topo.ancestors(join_id)
        region = ancestors | {join_id} | self.topo.descendants(join_id)
        for nid in list(self.running):
            if nid in ancestors and self.topo.descendants(nid) <= region:
                await self._cancel_node(nid, "Birleşme düğümü ilk biten dalla devam etti.", cleanup=True)

    async def _cancel_node(self, nid: str, reason: str, *, cleanup: bool) -> None:
        task = self.running.pop(nid, None)
        nctx = self.contexts.pop(nid, None)
        if task is None:
            return
        if nctx is not None:
            nctx.cleanup_on_cancel = cleanup
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        if nctx is not None:
            await self.rt.store.update_node_run(
                nctx.node_run_id, status="cancelled", error=reason, finished_at=utcnow()
            )
            self.state.status[nid] = "cancelled"
            await nctx.emit("node.cancelled", {"reason": reason})

    async def _stop_node_tasks(self, *, cleanup: bool) -> None:
        tasks = list(self.running.values())
        for nid in list(self.running):
            nctx = self.contexts.get(nid)
            if nctx is not None:
                nctx.cleanup_on_cancel = cleanup
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if cleanup:
            for nid, nctx in list(self.contexts.items()):
                await self.rt.store.update_node_run(nctx.node_run_id, status="cancelled", finished_at=utcnow())
                self.state.status[nid] = "cancelled"
        self.running.clear()
        self.contexts.clear()

    # ------------------------------------------------------------------ commands
    async def _do_retry(self, nid: str) -> None:
        if nid not in self.topo.nodes:
            raise Conflict("Bu düğüm akışta yok.")
        status = self.state.status.get(nid)
        if status not in ("failed", "cancelled", "skipped"):
            raise Conflict("Yalnız başarısız, atlanmış veya iptal edilmiş düğümler yeniden denenebilir.")
        region = {nid} | self.topo.descendants(nid)
        for n in region:
            if n in self.running:
                continue
            if self.state.status.get(n) in ("failed", "skipped", "cancelled") or n == nid:
                self.state.status[n] = "pending"
                self.state.skip_reason.pop(n, None)
                self.state.unhandled.pop(n, None)
        for e in self.topo.edges.values():
            if not self.topo.is_back(e) and e.source in region and e.target in region:
                self.state.deliveries.pop(e.id, None)
        self.state.loops.pop(nid, None)
        self._make_ready(nid)
        await self.persist_state()
        await self._emit("node.retry", {"node_id": nid, "label": self.topo.nodes[nid].label})

    async def _do_cancel(self, reason: str) -> None:
        self.user_cancelled = True
        for nid in list(self.running):
            await self._cancel_node(nid, reason, cleanup=True)
        self.state.ready.clear()
        await self._sweep_external(reason)
        await self.persist_state()
        await self._finish("cancelled", reason)

    async def _sweep_external(self, reason: str) -> None:
        """Cancel approvals and stop sessions that still belong to this run."""
        approvals = self.rt.approvals()
        with contextlib.suppress(Exception):
            for a in await approvals.list(status=ApprovalStatus.pending, workspace_id=self.task.workspace_id):
                if a.run_id == self.run_id:
                    with contextlib.suppress(Exception):
                        await approvals.cancel(a.id, reason)
        mgr = self.rt.maybe_agents()
        if mgr is not None:
            with contextlib.suppress(Exception):
                for rec in await mgr.list(run_id=self.run_id, active_only=True):
                    with contextlib.suppress(Exception):
                        handle = await mgr.handle(rec.id)
                        await handle.interrupt()
                        await handle.close()

    # ------------------------------------------------------------------ finishing
    async def _finalize(self) -> None:
        sinks = self.topo.sinks()

        def succeeded(nid: str) -> bool:
            st = self.state.status.get(nid)
            return st == "passed" or (st == "skipped" and self.state.skip_reason.get(nid) == "disabled")

        passed = [s for s in sinks if succeeded(s)]
        failed = [s for s in sinks if self.state.status.get(s) == "failed"]
        if passed and not failed:
            await self._finish("completed", None)
            return
        error = next(iter(self.state.unhandled.values()), None)
        if error is None and failed:
            res = self.results.get(failed[0])
            error = (res.output if res else None) or "Son adım başarısız oldu."
        await self._finish("failed", error or "Akış tamamlanamadı.")

    async def _finish(self, status: Literal["completed", "failed", "cancelled"], error: str | None) -> None:
        self.final_status = status
        now = utcnow()
        quality: dict[str, Any] = {}
        score: float | None = None
        if status == "completed":
            from aistudio.engine.quality import compute_for_run

            await self.persist_state()
            try:
                breakdown = await compute_for_run(self.rt, self.task.id, self.run_id)
                quality = {"quality": breakdown.model_dump(mode="json")}
                score = breakdown.score
            except Exception:
                log.warning("quality score failed for run %s", self.run_id, exc_info=True)
        task_values: dict[str, Any] = {"status": status, "error": error, "finished_at": now, **quality}
        if quality:
            task_values["quality_score"] = score
        await self.rt.store.update_run_and_task(
            self.run_id,
            self.task.id,
            {"status": status, "error": error, "finished_at": now, **quality},
            task_values,
        )
        run_type = {"completed": "run.completed", "failed": "run.failed", "cancelled": "run.cancelled"}[status]
        sev = {"completed": Severity.normal, "failed": Severity.high, "cancelled": Severity.info}[status]
        await self._emit(run_type, {"status": status, "error": error}, severity=sev)
        if status == "completed":
            await self._emit(
                "task.completed", {"title": self.task.title, "quality_score": score}, severity=Severity.normal
            )
        elif status == "failed":
            await self._emit("task.failed", {"title": self.task.title, "error": error}, severity=Severity.high)
        else:
            await self._emit("task.updated", {"status": "cancelled", "reason": error})

    async def checkpoint(self, nid: str, nrid: str, *, label: str | None = None) -> None:
        """Checkpoint every worktree of the run now (team nodes call it after each merge)."""
        await self._checkpoint(nid, nrid, label=label)

    async def _checkpoint(self, nid: str, nrid: str, *, label: str | None = None) -> None:
        node = self.topo.nodes[nid]
        wt_ids = sorted({w for per_repo in self.state.worktrees.values() for w in per_repo.values()})
        refs: dict[str, str] = {}
        memory_commit: str | None = None
        gitops_id: str | None = None
        wm = self.rt.maybe_worktrees()
        label = label or f"{node.label} sonrası"
        if wm is not None and wt_ids:
            try:
                ck = await wm.checkpoint(
                    run_id=self.run_id,
                    node_id=nid,
                    label=label,
                    worktree_ids=wt_ids,
                    workspace_id=self.task.workspace_id,
                )
                gitops_id, refs, memory_commit = ck.id, dict(ck.refs), ck.memory_commit
            except Exception:
                log.warning("checkpoint failed for run %s node %s", self.run_id, nid, exc_info=True)
        mem = self.rt.memory()
        if memory_commit is None and mem is not None:
            with contextlib.suppress(Exception):
                memory_commit = await mem.head(self.task.workspace_id)
        info = CheckpointInfo(
            id=new_id("ckpt"),
            run_id=self.run_id,
            node_id=nid,
            node_run_id=nrid,
            label=label,
            gitops_checkpoint_id=gitops_id,
            refs=refs,
            memory_commit=memory_commit,
            created_at=utcnow(),
        )
        await self.rt.store.insert_checkpoint(info, {"state": self.state.model_dump(mode="json")})
        await self._emit(
            "checkpoint.created",
            {
                "checkpoint_id": info.id,
                "node_id": nid,
                "label": label,
                "worktrees": len(refs),
                "memory_commit": memory_commit,
            },
        )
