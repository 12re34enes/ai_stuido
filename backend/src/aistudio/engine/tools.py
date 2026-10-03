"""Engine studio tools: ``ask_user``, ``report_status``, ``handoff``, ``evidence_submit``."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from aistudio.contracts.approvals import ApprovalKind, ApprovalRequest, ApprovalStatus
from aistudio.contracts.tools import ToolContext, ToolResult, ToolSpec
from aistudio.core.clock import utcnow
from aistudio.core.events import ET, Severity
from aistudio.core.ids import new_id
from aistudio.core.text import truncate
from aistudio.engine.models import AGENT_EVIDENCE_LABEL, Evidence

if TYPE_CHECKING:
    from aistudio.engine.service import FlowEngineImpl


class _EngineTool:
    spec: ToolSpec

    def __init__(self, engine: FlowEngineImpl) -> None:
        self.engine = engine

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:  # pragma: no cover
        raise NotImplementedError

    async def _emit(
        self, ctx: ToolContext, type: str, payload: dict[str, Any], severity: Severity = Severity.info
    ) -> None:
        await self.engine.rt.emit(
            type,
            {"node_id": ctx.node_id, "agent_label": ctx.agent_label, "provider": ctx.provider, **payload},
            severity=severity,
            workspace_id=ctx.workspace_id,
            task_id=ctx.task_id,
            run_id=ctx.run_id,
            session_id=ctx.session_id,
            actor=f"agent:{ctx.session_id}",
        )


class AskUserTool(_EngineTool):
    spec = ToolSpec(
        name="ask_user",
        description=(
            "Ask the user a question and wait for the answer. Use only when you cannot proceed without a human "
            "decision. Returns the user's answer as text."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "question": {"type": "string", "description": "The question, in the user's language (Turkish)."},
                "options": {"type": "array", "items": {"type": "string"}, "description": "Optional choices."},
                "context": {"type": "string", "description": "Short background so the user can answer quickly."},
            },
            "required": ["question"],
        },
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        question = str(args.get("question") or "").strip()
        if not question:
            return ToolResult(content="question is required", is_error=True)
        raw_options = args.get("options")
        options = [str(o) for o in raw_options] if isinstance(raw_options, list) else []
        nctx = self.engine.node_context(ctx.run_id, ctx.node_id)
        svc = self.engine.rt.approvals()
        approval = await svc.request(
            ApprovalRequest(
                kind=ApprovalKind.question,
                title=truncate(question, 200),
                summary=str(args.get("context") or "") or None,
                payload={
                    "question": question,
                    "options": options,
                    "node_id": ctx.node_id,
                    "agent_label": ctx.agent_label,
                    "answer_with": "decision_payload.answer",
                },
                severity=Severity.high,
                workspace_id=ctx.workspace_id,
                task_id=ctx.task_id,
                run_id=ctx.run_id,
                session_id=ctx.session_id,
                requested_by=f"agent:{ctx.session_id}",
            )
        )
        if nctx is not None:
            await nctx.set_waiting("Ajan bir soru sordu", kind="question")
        try:
            decided = await svc.wait(approval.id)
        finally:
            if nctx is not None:
                await nctx.clear_waiting()
        if decided.status != ApprovalStatus.approved:
            note = decided.decision_note or "yanıt verilmedi"
            return ToolResult(
                content=f"Kullanıcı soruyu yanıtlamadı ({note}). Kendi en iyi kararınla devam et ve bunu belirt.",
                data={"approval_id": decided.id, "status": decided.status.value},
            )
        answer = (decided.decision_payload or {}).get("answer")
        if not isinstance(answer, str) or not answer.strip():
            answer = decided.decision_note or "Onaylandı."
        return ToolResult(content=answer, data={"approval_id": decided.id, "answer": answer})


class ReportStatusTool(_EngineTool):
    spec = ToolSpec(
        name="report_status",
        description="Report progress to the user interface (what you are doing now, optional percentage).",
        input_schema={
            "type": "object",
            "properties": {
                "status": {"type": "string", "description": "One short sentence about the current step."},
                "progress": {"type": "number", "minimum": 0, "maximum": 100},
                "detail": {"type": "string"},
            },
            "required": ["status"],
        },
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        status = str(args.get("status") or "").strip()
        if not status:
            return ToolResult(content="status is required", is_error=True)
        progress = args.get("progress")
        try:
            pct = max(0.0, min(100.0, float(progress))) if progress is not None else None
        except (TypeError, ValueError):
            pct = None
        await self._emit(
            ctx,
            "node.progress",
            {"status": truncate(status, 300), "progress": pct, "detail": truncate(str(args.get("detail") or ""), 1000)},
        )
        return ToolResult(content="Durum bildirildi.", data={"status": status, "progress": pct})


class HandoffTool(_EngineTool):
    spec = ToolSpec(
        name="handoff",
        description="Announce that you are handing the work over to another agent or step, with the reason.",
        input_schema={
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "Who takes over (agent, role or node)."},
                "reason": {"type": "string"},
                "summary": {"type": "string", "description": "What the next agent needs to know."},
            },
            "required": ["to", "reason"],
        },
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        to = str(args.get("to") or "").strip()
        reason = str(args.get("reason") or "").strip()
        if not to or not reason:
            return ToolResult(content="to and reason are required", is_error=True)
        await self._emit(
            ctx,
            ET.AGENT_HANDOFF,
            {
                "from": ctx.agent_label or ctx.node_id or ctx.session_id,
                "from_node_id": ctx.node_id,
                "to": truncate(to, 200),
                "reason": truncate(reason, 1000),
                "summary": truncate(str(args.get("summary") or ""), 4000),
            },
        )
        return ToolResult(content="Devir kaydedildi.", data={"to": to})


class EvidenceSubmitTool(_EngineTool):
    spec = ToolSpec(
        name="evidence_submit",
        description=(
            "Attach evidence (command output, notes, a link, a screenshot path) to your current step. It is shown "
            "to the user labelled as agent-submitted; it never replaces the checks AI Studio runs itself."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "content": {"type": "string"},
                "kind": {"type": "string", "enum": ["text", "output", "link", "screenshot", "file"]},
                "path": {"type": "string", "description": "File path for screenshots/files, if any."},
            },
            "required": ["title", "content"],
        },
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        title = str(args.get("title") or "").strip()
        if not title:
            return ToolResult(content="title is required", is_error=True)
        if not ctx.run_id or not ctx.node_id:
            return ToolResult(content="evidence_submit is only available inside a flow run.", is_error=True)
        node_run_id = await self.engine.current_node_run_id(ctx.run_id, ctx.node_id)
        if node_run_id is None:
            return ToolResult(content="No active flow step found for this session.", is_error=True)
        kind = str(args.get("kind") or "text")
        masker = self.engine.rt.ctx.masker
        data: dict[str, Any] = {"submitted_by_agent": True, "provider": ctx.provider}
        if args.get("path"):
            data["path"] = str(args["path"])
        ev = Evidence(
            id=new_id("evd"),
            workspace_id=ctx.workspace_id,
            task_id=ctx.task_id,
            run_id=ctx.run_id,
            node_run_id=node_run_id,
            node_id=ctx.node_id,
            source="agent",
            kind=kind,
            title=truncate(masker.mask(title), 300),
            content=truncate(masker.mask(str(args.get("content") or "")), 20000),
            data=masker.mask_obj(data),
            created_by=f"agent:{ctx.session_id}",
            created_at=utcnow(),
        )
        await self.engine.rt.store.insert_evidence(ev)
        await self._emit(
            ctx, "evidence.submitted", {"evidence_id": ev.id, "title": ev.title, "label": AGENT_EVIDENCE_LABEL}
        )
        return ToolResult(
            content=(
                "Kanıt eklendi. Ajan kanıtı olarak işaretlendi; studio'nun kendi kapı kontrollerinin yerine geçmez."
            ),
            data={"evidence_id": ev.id},
        )


def engine_tools(engine: FlowEngineImpl) -> list[_EngineTool]:
    return [AskUserTool(engine), ReportStatusTool(engine), HandoffTool(engine), EvidenceSubmitTool(engine)]
