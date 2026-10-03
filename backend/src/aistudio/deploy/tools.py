"""Studio tool ``deploy_request``: agents may REQUEST a deploy; it always waits for approval."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from aistudio.contracts.tools import ToolContext, ToolResult, ToolSpec

if TYPE_CHECKING:
    from aistudio.deploy.service import DeployServiceImpl

DEPLOY_REQUEST_DESCRIPTION = """\
Request a deploy using a configured deploy profile (by name or id) of this workspace.

The deploy never starts on your say-so: every deploy requested by an agent waits for an explicit human
approval (on production this approval is locked and critical), and the human may reject it. The call blocks
until the deploy finishes or is rejected, then returns the status, health-check result and the end of the log.
Provide `ref` (branch, tag or commit) when relevant and a concise `summary` of what changes; both are shown
to the approver. Only request a deploy after the work has passed its gates (tests, review)."""


class DeployRequestTool:
    spec = ToolSpec(
        name="deploy_request",
        description=DEPLOY_REQUEST_DESCRIPTION,
        input_schema={
            "type": "object",
            "properties": {
                "profile": {"type": "string", "description": "Deploy profile name or id."},
                "ref": {"type": "string", "description": "Git ref to deploy (branch, tag or commit)."},
                "summary": {"type": "string", "description": "What changes in this deploy (shown to approvers)."},
            },
            "required": ["profile", "summary"],
            "additionalProperties": False,
        },
        mutating=True,
    )

    def __init__(self, svc: DeployServiceImpl) -> None:
        self._svc = svc

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        ref_name = str(args.get("profile") or "").strip()
        if not ref_name:
            return ToolResult(content="`profile` is required.", is_error=True)
        profile = await self._svc.resolve_profile(ref_name, ctx.workspace_id)
        git_ref = str(args["ref"]).strip() if args.get("ref") else None
        summary = str(args["summary"]).strip() if args.get("summary") else None
        result = await self._svc.deploy(
            profile.id,
            ref=git_ref,
            actor=f"agent:{ctx.session_id}",
            task_id=ctx.task_id,
            run_id=ctx.run_id,
            summary=summary,
        )
        lines = [
            f"deploy: {profile.name} ({result.environment.value})",
            f"status: {result.status}",
        ]
        if result.approved_by:
            lines.append(f"approved by: {result.approved_by}")
        if result.health_ok is not None:
            lines.append(f"health check: {'ok' if result.health_ok else 'FAILED'}")
        tail = "\n".join(result.log.splitlines()[-40:])
        if tail:
            lines += ["--- log (tail) ---", tail]
        return ToolResult(
            content="\n".join(lines),
            is_error=result.status != "succeeded",
            data={"deploy_id": result.id, "status": result.status, "health_ok": result.health_ok},
        )
