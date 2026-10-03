"""Team Studio tools (spec §25): ``team_delegate``, ``team_wait``, ``team_consult``, ``team_report``,
``team_finish``.

They are ``opt_in`` tools: bound only to team member sessions (the team runtime lists them in the
session's ``tool_names``), never to ordinary sessions. The calling member is resolved from
``ToolContext.session_id``; scope violations come back as Turkish tool errors.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from aistudio.contracts.tools import ToolContext, ToolResult, ToolSpec
from aistudio.engine.team import prompts as P
from aistudio.engine.team.runtime import WAIT_DEFAULT_S, WAIT_MAX_S, TeamError, TeamRun

if TYPE_CHECKING:
    from aistudio.engine.service import FlowEngineImpl


def _result_data(a: Any) -> dict[str, Any]:
    return {
        "assignment_id": a.id,
        "title": a.title,
        "member_id": a.to_member,
        "status": a.status,
        "summary": a.result_summary,
        "error": a.error,
        "round": a.round,
        "merge": a.merge.model_dump(mode="json") if a.merge else None,
        "tests": [v.model_dump(mode="json", exclude={"findings"}) for v in a.tests],
    }


class _TeamTool:
    spec: ToolSpec

    def __init__(self, engine: FlowEngineImpl) -> None:
        self.engine = engine

    def _resolve(self, ctx: ToolContext) -> tuple[TeamRun, str]:
        found = self.engine.rt.teams.resolve(ctx.session_id)
        if found is None:
            raise TeamError("Bu araç yalnız çalışan bir ekibin üyesi olan oturumlarda kullanılabilir.")
        return found

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:  # pragma: no cover
        raise NotImplementedError


class TeamDelegateTool(_TeamTool):
    spec = ToolSpec(
        name="team_delegate",
        description=(
            "Delegate a piece of work to one of your direct subordinates (see the team roster in your instructions). "
            "The assignment runs in the subordinate's own worktree, branched from your branch; when it finishes, its "
            "changes are merged into your branch automatically. Returns the assignment id immediately - collect the "
            "result with team_wait. Write self-contained instructions: goal, scope, relevant files, acceptance "
            "criteria."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "member_id": {"type": "string", "description": "Id of one of your direct subordinates."},
                "title": {"type": "string", "description": "Short title of the assignment."},
                "instructions": {
                    "type": "string",
                    "description": "Complete instructions for the subordinate (it has not seen the conversation).",
                },
                "depends_on": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Ids of your earlier assignments that must complete before this one starts.",
                },
            },
            "required": ["member_id", "title", "instructions"],
        },
        mutating=True,
        opt_in=True,
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        team, caller = self._resolve(ctx)
        raw_deps = args.get("depends_on")
        if raw_deps is not None and not isinstance(raw_deps, list):
            raise TeamError("depends_on bir iş kimliği listesi olmalı.")
        deps = [str(d) for d in raw_deps or []]
        a = await team.delegate(
            caller,
            str(args.get("member_id") or "").strip(),
            str(args.get("title") or ""),
            str(args.get("instructions") or ""),
            deps,
        )
        waiting = " Bağımlılıkları bitince başlayacak." if deps else ""
        return ToolResult(
            content=(
                f"İş oluşturuldu: {a.id} — '{a.title}' → {team.names.get(a.to_member, a.to_member)}.{waiting} "
                "Sonucu team_wait ile al."
            ),
            data={"assignment_id": a.id, "member_id": a.to_member, "status": a.status, "depends_on": a.depends_on},
        )


class TeamWaitTool(_TeamTool):
    spec = ToolSpec(
        name="team_wait",
        description=(
            "Wait for your delegated assignments to finish and get their results: status, summary, merge outcome "
            "(including conflicting files) and test verdicts. Without assignment_ids it waits for all of your open "
            "assignments (and also returns finished results you have not seen yet). Returns early when timeout_s "
            f"elapses (default {int(WAIT_DEFAULT_S)}, max {int(WAIT_MAX_S)}); call it again to keep waiting."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "assignment_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Assignment ids to wait for (default: all of your open assignments).",
                },
                "timeout_s": {"type": "number", "minimum": 0, "maximum": WAIT_MAX_S},
            },
        },
        opt_in=True,
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        team, caller = self._resolve(ctx)
        raw_ids = args.get("assignment_ids")
        if raw_ids is not None and not isinstance(raw_ids, list):
            raise TeamError("assignment_ids bir iş kimliği listesi olmalı.")
        timeout_raw = args.get("timeout_s")
        try:
            timeout = float(timeout_raw) if timeout_raw is not None else None
        except (TypeError, ValueError):
            raise TeamError("timeout_s sayı olmalı.") from None
        done, still = await team.wait(caller, [str(i) for i in raw_ids] if raw_ids else None, timeout)
        if not done and not still:
            return ToolResult(content="Bekleyen veya okunmamış işin yok.", data={"results": [], "pending": []})
        parts: list[str] = []
        if done:
            parts.append(P.format_results(done, team.names))
        if still:
            names = ", ".join(f"'{a.title}' ({a.id}, {P.STATUS_TR.get(a.status, a.status)})" for a in still)
            parts.append(f"Henüz bitmeyen işler: {names}. Beklemeye devam etmek için team_wait'i tekrar çağır.")
        return ToolResult(
            content="\n\n".join(parts),
            data={"results": [_result_data(a) for a in done], "pending": [a.id for a in still]},
        )


class TeamConsultTool(_TeamTool):
    spec = ToolSpec(
        name="team_consult",
        description=(
            "Ask the team advisor a question and get the answer (blocks until the advisor replies). Use it for "
            "design decisions, trade-offs or when you are stuck."
        ),
        input_schema={
            "type": "object",
            "properties": {"question": {"type": "string", "description": "The question, with enough context."}},
            "required": ["question"],
        },
        opt_in=True,
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        team, caller = self._resolve(ctx)
        answer = await team.consult(caller, str(args.get("question") or ""))
        return ToolResult(content=answer, data={"answer": answer})


class TeamReportTool(_TeamTool):
    spec = ToolSpec(
        name="team_report",
        description=(
            "Send a short progress report to the team advisor. Depending on the team's report mode it is forwarded "
            "right away (the advisor's advice comes back to you as a message) or kept for your next team_consult."
        ),
        input_schema={
            "type": "object",
            "properties": {"summary": {"type": "string", "description": "What you did, what is next, any risks."}},
            "required": ["summary"],
        },
        opt_in=True,
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        team, caller = self._resolve(ctx)
        how = await team.report(caller, str(args.get("summary") or ""))
        content = (
            "Rapor kaydedildi; danışman bir sonraki danışmanda görecek."
            if how == "on_demand"
            else "Rapor danışmana iletildi; önerisi gelirse sana mesaj olarak iletilecek."
        )
        return ToolResult(content=content, data={"delivery": how})


class TeamFinishTool(_TeamTool):
    spec = ToolSpec(
        name="team_finish",
        description=(
            "Finish your current assignment with a concise summary of what you did (changed files, decisions, open "
            "issues). Wait for your own delegated assignments first. When the lead calls it, the team's work ends "
            "with this summary. End your turn right after calling it."
        ),
        input_schema={
            "type": "object",
            "properties": {"summary": {"type": "string", "description": "Concise summary of the finished work."}},
            "required": ["summary"],
        },
        opt_in=True,
    )

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        team, caller = self._resolve(ctx)
        unread = await team.finish(caller, str(args.get("summary") or ""))
        content = "İş bitti olarak işaretlendi. Turunu kısa bir sonuçla bitir."
        if unread:
            content += "\n\nHenüz görmediğin sonuçlar vardı:\n\n" + P.format_results(unread, team.names)
        return ToolResult(content=content, data={"finished": True, "unread": [_result_data(a) for a in unread]})


def team_tools(engine: FlowEngineImpl) -> list[_TeamTool]:
    return [
        TeamDelegateTool(engine),
        TeamWaitTool(engine),
        TeamConsultTool(engine),
        TeamReportTool(engine),
        TeamFinishTool(engine),
    ]
