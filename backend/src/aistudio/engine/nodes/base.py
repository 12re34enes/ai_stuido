"""Node execution context and helpers shared by node implementations.

Every helper that waits on something external (an approval, an agent turn, a limit reset)
records its progress in the node run's ``state`` first, so a node resumed after a studiod
restart re-attaches to the same approval or agent session instead of starting over.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any, Literal

from aistudio.contracts.agents import (
    AgentProfile,
    AgentRole,
    AgentSessionHandle,
    AgentState,
    Boundaries,
    SandboxLevel,
    SessionSpec,
    StartSessionRequest,
    TurnResult,
)
from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalRequest
from aistudio.contracts.common import Provider
from aistudio.contracts.flows import FlowNode, GateKind
from aistudio.contracts.gitops import Worktree
from aistudio.contracts.workspaces import Repo
from aistudio.core.clock import utcnow
from aistudio.core.errors import StudioError
from aistudio.core.events import Severity
from aistudio.core.ids import new_id
from aistudio.core.text import truncate
from aistudio.engine.models import Evidence, GateResult

if TYPE_CHECKING:
    from aistudio.engine.executor import RunExecutor
    from aistudio.engine.runtime import EngineRuntime

log = logging.getLogger(__name__)

ACTIVE_AGENT_STATES = frozenset(
    {
        AgentState.starting,
        AgentState.thinking,
        AgentState.responding,
        AgentState.running_tool,
        AgentState.waiting_permission,
        AgentState.waiting_user,
    }
)

RESUME_PREFIX = (
    "AI Studio yeniden başlatıldı ve önceki tur yarıda kalmış olabilir. Çalışma dizinindeki durumu kontrol et, "
    "görevi kaldığın yerden tamamla ve son yanıtını eksiksiz ver.\n\n"
)

ROLE_INSTRUCTIONS: dict[str, str] = {
    "writer": (
        "AI Studio akışında kod yazan ajansın. Değişiklikleri yalnız çalışma dizininde yap. Testleri ve "
        "build'i studio ayrıca çalıştırır; senin 'testler geçti' demen kanıt sayılmaz. Bitirdiğinde yaptığın "
        "değişiklikleri kısaca özetle."
    ),
    "planner": "AI Studio akışında planlayıcısın. Kod yazma; repoyu inceleyip uygulanabilir bir plan hazırla.",
    "tester": (
        "AI Studio akışında test yazan ajansın. Değişiklikleri doğrulayan testler ekle; uygulama kodunu yalnız "
        "açık hatalar için değiştir."
    ),
    "reviewer": (
        "AI Studio akışında başka bir modelin yazdığı kodu inceleyen bağımsız bir inceleyicisin. Dosya "
        "değiştirme. Bulgularını önem derecesiyle bildir; doğruluk, güvenlik ve sınırlara uyuma odaklan."
    ),
    "advisor": "AI Studio akışında danışmansın. Kod yazma, dosya değiştirme; yalnız görüş belgesi üret.",
    "judge": "AI Studio akışında hakemsin. Adayları tarafsızca karşılaştır ve gerekçeli bir seçim yap.",
    "synthesizer": (
        "AI Studio akışında kurulun görüşlerini birleştiren sentezcisin. Görüşleri adil biçimde tart ve tek "
        "bir karar belgesi yaz."
    ),
}


class NodeFailure(StudioError):
    """A node failed for a reason that is not a gate verdict (no loop-back)."""

    code = "node_failed"


@dataclass
class NodeOutcome:
    status: Literal["passed", "failed", "skipped"]
    output: str | None = None
    data: dict[str, Any] | None = None
    error: str | None = None
    branch: Literal["true", "false"] | None = None  # condition nodes
    loopable: bool = True  # failed gate verdicts may follow loop edges; errors may not
    feedback: str | None = None  # text handed to the loop target (``feedback.text``)


@dataclass
class AgentTurn:
    session_id: str
    text: str
    result: TurnResult


@dataclass
class ResolvedAgent:
    provider: Provider
    model: str | None
    effort: str | None
    role: AgentRole
    boundaries: Boundaries
    instructions: str = ""
    profile_id: str | None = None
    profile: AgentProfile | None = None
    switched_from: Provider | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class WriterTarget:
    node_id: str
    worktree_ids: list[str]
    provider: Provider | None
    model: str | None
    output: str
    data: dict[str, Any]
    boundaries: Boundaries | None


class NodeContext:
    def __init__(
        self,
        ex: RunExecutor,
        node: FlowNode,
        node_run_id: str,
        attempt: int,
        state: dict[str, Any] | None = None,
        *,
        resumed: bool = False,
    ) -> None:
        self.ex = ex
        self.rt: EngineRuntime = ex.rt
        self.node = node
        self.node_run_id = node_run_id
        self.attempt = attempt
        self.state: dict[str, Any] = state or {}
        self.resumed = resumed
        self.started_at: datetime | None = None  # set for resumed nodes
        self.cleanup_on_cancel = False  # set when the user (not shutdown) cancels this node
        self._handles: dict[str, AgentSessionHandle] = {}
        # facts known before the node finished (provider, model, session...): kept on failure for stats
        self.partial: dict[str, Any] = {}
        self._waiting = False
        self.session_ids: list[str] = []
        self.worktree_ids: list[str] = []

    # ------------------------------------------------------------------ basics
    @property
    def run_id(self) -> str:
        return self.ex.run_id

    @property
    def task_id(self) -> str:
        return self.ex.task.id

    @property
    def workspace_id(self) -> str:
        return self.ex.task.workspace_id

    @property
    def node_id(self) -> str:
        return self.node.id

    async def save_state(self) -> None:
        await self.rt.store.update_node_run(self.node_run_id, state=self.state)

    async def emit(
        self,
        type: str,
        payload: dict[str, Any] | None = None,
        *,
        severity: Severity = Severity.info,
        session_id: str | None = None,
    ) -> None:
        body = {"node_id": self.node_id, "node_run_id": self.node_run_id, "label": self.node.label, **(payload or {})}
        await self.rt.emit(
            type,
            body,
            severity=severity,
            workspace_id=self.workspace_id,
            task_id=self.task_id,
            run_id=self.run_id,
            session_id=session_id,
        )

    async def set_waiting(self, reason: str, *, kind: str = "approval") -> None:
        if self._waiting:
            return
        self._waiting = True
        await self.rt.store.update_node_run(self.node_run_id, status="waiting")
        self.ex.state.status[self.node_id] = "waiting"
        await self.emit("node.waiting", {"reason": reason, "wait_kind": kind})
        await self.ex.refresh_status()

    async def clear_waiting(self) -> None:
        if not self._waiting:
            return
        self._waiting = False
        await self.rt.store.update_node_run(self.node_run_id, status="running")
        self.ex.state.status[self.node_id] = "running"
        await self.emit("node.running", {})
        await self.ex.refresh_status()

    async def add_session(self, session_id: str) -> None:
        if session_id not in self.session_ids:
            self.session_ids.append(session_id)
            await self.rt.store.update_node_run(self.node_run_id, session_ids=list(self.session_ids))

    async def add_worktrees(self, ids: list[str]) -> None:
        changed = False
        for wid in ids:
            if wid not in self.worktree_ids:
                self.worktree_ids.append(wid)
                changed = True
        if changed:
            await self.rt.store.update_node_run(self.node_run_id, worktree_ids=list(self.worktree_ids))

    # ------------------------------------------------------------------ templates
    async def variables(self, *, role: AgentRole | None = None) -> dict[str, Any]:
        return await self.ex.variables(self.node_id, role=role, attempt=self.attempt)

    async def render(self, template: str, *, role: AgentRole | None = None) -> str:
        from aistudio.engine.templates import render

        return render(template, await self.variables(role=role))

    # ------------------------------------------------------------------ approvals
    async def approval(self, key: str, req: ApprovalRequest, *, waiting_reason: str | None = None) -> Approval:
        """Request (once) and wait for an approval; resumable across restarts."""
        svc = self.rt.approvals()
        st_key = f"approval:{key}"
        approval_id = self.state.get(st_key)
        ref = f"{self.node_run_id}:{key}"
        await self.set_waiting(waiting_reason or req.title)
        if not approval_id and self.resumed:
            approval_id = await self._orphan_approval(ref)
            if approval_id:
                self.state[st_key] = approval_id
                await self.save_state()
        if not approval_id:
            req = req.model_copy(
                update={
                    "workspace_id": req.workspace_id or self.workspace_id,
                    "task_id": req.task_id or self.task_id,
                    "run_id": req.run_id or self.run_id,
                    "requested_by": req.requested_by if req.requested_by != "system" else "engine",
                    "payload": {**req.payload, "engine_ref": ref},
                }
            )
            created = await svc.request(req)
            approval_id = created.id
            self.state[st_key] = approval_id
            await self.save_state()
        try:
            decided = await svc.wait(approval_id)
        except asyncio.CancelledError:
            if self.cleanup_on_cancel:
                with contextlib.suppress(Exception):
                    await asyncio.shield(svc.cancel(approval_id, "Akış iptal edildi."))
            raise
        await self.clear_waiting()
        return decided

    async def _orphan_approval(self, ref: str) -> str | None:
        """An approval requested right before a crash, before its id was recorded."""
        svc = self.rt.approvals()
        # it may already have been decided while studiod was down (list is newest first)
        for a in await svc.list(status=None, workspace_id=self.workspace_id, limit=1000):
            if a.run_id == self.run_id and a.payload.get("engine_ref") == ref:
                return a.id
        return None

    async def _orphan_session(self) -> str | None:
        """A session started for this node right before a crash, before its id was recorded."""
        mgr = self.rt.agents()
        known = await self.ex.known_session_ids()
        candidates = [
            r
            for r in await mgr.list(run_id=self.run_id)
            if r.node_id == self.node_id
            and r.id not in known
            and (self.started_at is None or r.created_at >= self.started_at)
        ]
        return max(candidates, key=lambda r: r.created_at).id if candidates else None

    # ------------------------------------------------------------------ agents
    async def resolve_agent(
        self,
        *,
        profile_id: str | None,
        provider: Provider | None,
        model: str | None,
        effort: str | None,
        role: AgentRole,
        explicit: set[str],
        node_boundaries: Boundaries | None = None,
        read_only: bool = False,
    ) -> ResolvedAgent:
        """With a profile, the provider comes from the profile and model/effort/role from the node only
        when set explicitly there. Without a profile everything comes from the node (provider falls back
        to the workspace/engine default)."""
        profile: AgentProfile | None = None
        if profile_id:
            profile = await self.rt.agents().resolve_profile(profile_id)
        if profile is not None:
            chosen_provider: Provider = profile.provider
            chosen_model = model if "model" in explicit else profile.model
            chosen_effort = effort if "effort" in explicit else profile.effort
            chosen_role: AgentRole = role if "role" in explicit else profile.role
        else:
            chosen_provider = provider or await self.ex.default_provider()
            chosen_model, chosen_effort, chosen_role = model, effort, role
        boundaries = await self.merged_boundaries(profile, node_boundaries, read_only=read_only)
        return ResolvedAgent(
            provider=chosen_provider,
            model=chosen_model,
            effort=chosen_effort,
            role=chosen_role,
            boundaries=boundaries,
            instructions=profile.instructions if profile is not None else "",
            profile_id=profile_id,
            profile=profile,
        )

    async def merged_boundaries(
        self, profile: AgentProfile | None, node_boundaries: Boundaries | None, *, read_only: bool = False
    ) -> Boundaries:
        merged = Boundaries()
        mem = self.rt.memory()
        if mem is not None:
            try:
                merged = merged.merged(await mem.boundaries(self.workspace_id))
            except Exception:
                log.warning("memory boundaries unavailable for %s", self.workspace_id, exc_info=True)
        if profile is not None:
            merged = merged.merged(profile.boundaries)
        if node_boundaries is not None:
            merged = merged.merged(node_boundaries)
        if read_only:
            merged = merged.model_copy(update={"sandbox": SandboxLevel.read_only})
        return merged

    async def system_append(self, role: AgentRole, extra: str = "") -> str:
        parts: list[str] = [ROLE_INSTRUCTIONS.get(role, "")]
        mem = self.rt.memory()
        if mem is not None:
            try:
                context = await mem.context_for_agent(self.workspace_id, role=role)
                if context.strip():
                    parts.append("## Çalışma alanı hafızası\n" + context.strip())
            except Exception:
                log.warning("memory context unavailable for %s", self.workspace_id, exc_info=True)
        if extra.strip():
            parts.append(extra.strip())
        return "\n\n".join(p for p in parts if p)

    def session_request(
        self,
        agent: ResolvedAgent,
        *,
        cwd: str,
        system_append: str,
        extra_dirs: list[str] | None = None,
        worktree_id: str | None = None,
        tool_names: list[str] | None = None,
        label: str | None = None,
        network: bool | None = None,
    ) -> StartSessionRequest:
        boundaries = agent.boundaries
        if network is not None:
            boundaries = boundaries.model_copy(update={"network": boundaries.network and network})
        spec = SessionSpec(
            provider=agent.provider,
            cwd=cwd,
            model=agent.model,
            effort=agent.effort,
            role=agent.role,
            system_append=system_append,
            boundaries=boundaries,
            extra_dirs=extra_dirs or [],
            title=f"{self.ex.task.title} · {label or self.node.label}",
        )
        return StartSessionRequest(
            workspace_id=self.workspace_id,
            spec=spec,
            profile_id=agent.profile_id,
            worktree_id=worktree_id,
            task_id=self.task_id,
            run_id=self.run_id,
            node_id=self.node_id,
            label=label or self.node.label,
            tool_names=tool_names,
        )

    async def run_turn(
        self,
        *,
        key: str,
        message: str,
        provider: Provider,
        build_request: Callable[[], Awaitable[StartSessionRequest]],
        reuse_key: str | None = None,
    ) -> AgentTurn:
        """Start (or continue) an agent session and wait for one turn to finish."""
        mgr = self.rt.agents()
        st_key = f"turn:{key}"
        progress: dict[str, Any] | None = self.state.get(st_key)
        timeout_min = await self.rt.int_setting("engine.turn_timeout_minutes")
        timeout = float(timeout_min * 60) if timeout_min > 0 else None
        handle: AgentSessionHandle | None = None
        session_id = ""
        if not (progress and progress.get("session_id")) and self.resumed:
            orphan = await self._orphan_session()
            if orphan is not None:
                progress = {"session_id": orphan, "sent": True, "turn_id": None}
                self.state[st_key] = progress
                await self.save_state()
                if reuse_key:
                    self.ex.state.sessions[reuse_key] = orphan
                    await self.ex.persist_state()
        async with self.ex.agent_slot(provider):
            try:
                if progress and progress.get("session_id"):
                    session_id = str(progress["session_id"])
                    handle = await mgr.handle(session_id)
                    self._handles[session_id] = handle
                    await self.add_session(session_id)
                    if progress.get("sent") and handle.state in ACTIVE_AGENT_STATES:
                        result = await handle.wait_turn(None, timeout=timeout)
                    else:
                        turn_id = await handle.send(RESUME_PREFIX + message)
                        progress.update(turn_id=turn_id, sent=True)
                        await self.save_state()
                        result = await handle.wait_turn(turn_id, timeout=timeout)
                else:
                    reuse_sid = self.ex.state.sessions.get(reuse_key) if reuse_key else None
                    if reuse_sid:
                        session_id = reuse_sid
                        progress = {"session_id": session_id, "sent": False}
                        self.state[st_key] = progress
                        await self.save_state()
                        handle = await mgr.handle(session_id)
                        self._handles[session_id] = handle
                        await self.add_session(session_id)
                        turn_id = await handle.send(message)
                        progress.update(turn_id=turn_id, sent=True)
                        await self.save_state()
                        result = await handle.wait_turn(turn_id, timeout=timeout)
                    else:
                        req = (await build_request()).model_copy(update={"initial_prompt": message})
                        record = await mgr.start_session(req)
                        session_id = record.id
                        self.partial.setdefault("session_id", session_id)
                        progress = {"session_id": session_id, "sent": True, "turn_id": None}
                        self.state[st_key] = progress
                        await self.save_state()
                        if reuse_key:
                            self.ex.state.sessions[reuse_key] = session_id
                            await self.ex.persist_state()
                        await self.add_session(session_id)
                        await self.emit(
                            "node.session",
                            {"provider": req.spec.provider, "model": req.spec.model, "role": req.spec.role},
                            session_id=session_id,
                        )
                        handle = await mgr.handle(session_id)
                        self._handles[session_id] = handle
                        result = await handle.wait_turn(None, timeout=timeout)
            except asyncio.CancelledError:
                if handle is not None and self.cleanup_on_cancel:
                    with contextlib.suppress(Exception):
                        await asyncio.shield(handle.interrupt())
                raise
            except TimeoutError:
                if handle is not None:
                    with contextlib.suppress(Exception):
                        await handle.interrupt()
                raise NodeFailure("Ajan turu süre sınırını aştı.") from None
        progress["done"] = True
        await self.save_state()
        if result.status == "error":
            raise NodeFailure(f"Ajan hata verdi: {result.error or 'bilinmeyen hata'}")
        if result.status == "interrupted":
            raise NodeFailure("Ajan turu kesildi.")
        if result.status == "max_turns":
            raise NodeFailure("Ajan tur sınırına ulaştı; iş tamamlanmadı.")
        return AgentTurn(session_id=session_id, text=result.text or "", result=result)

    async def close_sessions(self) -> None:
        for handle in list(self._handles.values()):
            with contextlib.suppress(Exception):
                await handle.close()
        self._handles.clear()

    async def interrupt_sessions(self) -> None:
        """Stop every session of this node, including one started right before the cancellation."""
        targets: dict[str, AgentSessionHandle] = dict(self._handles)
        mgr = self.rt.maybe_agents()
        if mgr is not None:
            ids = set(self.session_ids)
            with contextlib.suppress(Exception):
                ids.update(
                    r.id for r in await mgr.list(run_id=self.run_id, active_only=True) if r.node_id == self.node_id
                )
            for sid in ids - set(targets):
                with contextlib.suppress(Exception):
                    targets[sid] = await mgr.handle(sid)
        for handle in targets.values():
            with contextlib.suppress(Exception):
                await handle.interrupt()
            with contextlib.suppress(Exception):
                await handle.close()
        self._handles.clear()

    # ------------------------------------------------------------------ limits
    async def ensure_provider(
        self,
        provider: Provider,
        *,
        purpose: str,
        forbidden: Provider | None = None,
        allow_switch: bool = True,
        same_provider_review: bool = False,
    ) -> tuple[Provider, dict[str, Any]]:
        from aistudio.engine.limits import ensure_provider

        return await ensure_provider(
            self,
            provider,
            purpose=purpose,
            forbidden=forbidden,
            allow_switch=allow_switch,
            same_provider_review=same_provider_review,
        )

    async def sleep_until(self, seconds: float) -> None:
        await asyncio.sleep(max(0.0, seconds))

    # ------------------------------------------------------------------ gates & evidence
    async def record_gate(
        self,
        kind: GateKind | str,
        status: Literal["passed", "failed", "skipped"],
        *,
        summary: str,
        evidence: dict[str, Any] | None = None,
        decided_by: str = "studiod",
        target_node_id: str | None = None,
        emit: bool = True,
    ) -> GateResult:
        kind_value = kind.value if isinstance(kind, GateKind) else kind
        result = GateResult(
            id=new_id("gate"),
            run_id=self.run_id,
            node_run_id=self.node_run_id,
            node_id=self.node_id,
            kind=kind_value,
            status=status,
            attempt=self.attempt,
            target_node_id=target_node_id,
            summary=truncate(self.rt.ctx.masker.mask(summary), 4000),
            evidence=self.rt.ctx.masker.mask_obj(evidence or {}),
            decided_by=decided_by,
            created_at=utcnow(),
        )
        await self.rt.store.insert_gate_result(result)
        self.ex.gate_cache[self.node_id] = result
        if emit:
            etype = {"passed": "gate.passed", "failed": "gate.failed", "skipped": "gate.skipped"}[status]
            await self.emit(
                etype,
                {
                    "gate": kind_value,
                    "gate_result_id": result.id,
                    "summary": truncate(result.summary, 500),
                    "attempt": self.attempt,
                    "target_node_id": target_node_id,
                    "decided_by": decided_by,
                },
                severity=Severity.normal if status == "failed" else Severity.info,
            )
        return result

    async def add_evidence(
        self,
        *,
        kind: str,
        title: str,
        content: str = "",
        data: dict[str, Any] | None = None,
        source: Literal["gate", "agent"] = "gate",
        created_by: str = "studiod",
    ) -> Evidence:
        ev = Evidence(
            id=new_id("evd"),
            workspace_id=self.workspace_id,
            task_id=self.task_id,
            run_id=self.run_id,
            node_run_id=self.node_run_id,
            node_id=self.node_id,
            source=source,
            kind=kind,
            title=title,
            content=truncate(self.rt.ctx.masker.mask(content), 20000),
            data=self.rt.ctx.masker.mask_obj(data) if data is not None else None,
            created_by=created_by,
            created_at=utcnow(),
        )
        await self.rt.store.insert_evidence(ev)
        return ev

    # ------------------------------------------------------------------ targets
    def writer_target(self, node_id: str | None) -> WriterTarget | None:
        if node_id is None:
            return None
        res = self.ex.results.get(node_id)
        if res is None or res.status not in ("passed", "skipped"):
            return None
        data = res.data or {}
        wt_ids = [str(w) for w in data.get("worktree_ids") or []]
        bounds_raw = data.get("boundaries")
        boundaries = Boundaries.model_validate(bounds_raw) if isinstance(bounds_raw, dict) else None
        provider = data.get("provider")
        return WriterTarget(
            node_id=node_id,
            worktree_ids=wt_ids,
            provider=provider if provider in ("claude", "codex") else None,
            model=data.get("model"),
            output=self.ex.output_of(node_id),
            data=data,
            boundaries=boundaries,
        )

    async def worktrees_of(self, target: WriterTarget) -> list[Worktree]:
        wm = self.rt.worktrees()
        return [await wm.get(w) for w in target.worktree_ids]

    async def repo(self, repo_id: str) -> Repo:
        for r in self.ex.repos:
            if r.id == repo_id:
                return r
        return await self.rt.workspaces().get_repo(repo_id)


def approval_request(
    kind: ApprovalKind,
    title: str,
    *,
    summary: str | None = None,
    payload: dict[str, Any] | None = None,
    severity: Severity = Severity.high,
    production: bool = False,
    session_id: str | None = None,
    expires_in: timedelta | None = None,
) -> ApprovalRequest:
    return ApprovalRequest(
        kind=kind,
        title=title,
        summary=summary,
        payload=payload or {},
        severity=severity,
        production=production,
        session_id=session_id,
        requested_by="engine",
        expires_at=(utcnow() + expires_in) if expires_in else None,
    )
