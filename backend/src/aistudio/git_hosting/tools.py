"""Studio tools exposed to agents working on PR takibi tasks."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from aistudio.contracts.engine import FlowEngine
from aistudio.contracts.tools import ToolContext, ToolResult, ToolSpec
from aistudio.core.context import AppContext

if TYPE_CHECKING:
    from aistudio.git_hosting.service import GitHostingServiceImpl


class PrCommentReplyTool:
    """Lets the agent answer a review comment with reasoning instead of changing code."""

    spec = ToolSpec(
        name="pr_comment_reply",
        description=(
            "Reply to a review comment on the pull/merge request this task is fixing. Use it when a "
            "comment does not need a code change: explain why, concisely and politely. Comments you "
            "fix in code are answered and resolved automatically after the push, do not reply to those."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "comment_id": {"type": "string", "description": "The 'yorum id' given in the task prompt."},
                "body": {"type": "string", "description": "Markdown reply text."},
            },
            "required": ["comment_id", "body"],
        },
        mutating=True,
    )

    def __init__(self, ctx: AppContext, svc: GitHostingServiceImpl) -> None:
        self._ctx = ctx
        self._svc = svc

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        comment_id = str(args.get("comment_id") or "").strip()
        body = str(args.get("body") or "").strip()
        if not comment_id or not body:
            return ToolResult(content="comment_id and body are required.", is_error=True)
        if not ctx.task_id:
            return ToolResult(content="This tool is only available inside a PR fix task.", is_error=True)
        task = await self._ctx.services.get(FlowEngine).get_task(ctx.task_id)  # type: ignore[type-abstract]
        ref = task.source_ref or {}
        repo_id, number = ref.get("repo_id"), ref.get("pr")
        if task.source != "pr_watch" or not isinstance(repo_id, str) or not isinstance(number, int):
            return ToolResult(content="This task is not linked to a pull request.", is_error=True)
        created = await self._svc.reply_to_comment(repo_id, number, comment_id, body, by_agent=True)
        return ToolResult(
            content="Reply posted.",
            data={"repo_id": repo_id, "pr": number, "comment_id": comment_id, "reply_id": created},
        )
