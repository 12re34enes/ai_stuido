"""Studio tools for agents: ``memory_read`` and ``memory_propose`` (spec §10, §11).

Both are non-mutating from the tool registry's point of view: reading is harmless and a
proposal changes nothing until the user approves it, so advisors may use them too.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from aistudio.contracts.tools import ToolContext, ToolResult, ToolSpec
from aistudio.memory.markdown import truncate_lines

if TYPE_CHECKING:
    from aistudio.memory.service import MemoryServiceImpl

_MAX_TOOL_CHARS = 60_000

MEMORY_READ_SPEC = ToolSpec(
    name="memory_read",
    description=(
        "Read the workspace's shared memory (project facts, boundaries, decision records, session "
        "summaries). Call without `path` to list every memory document with its title and last update; "
        "call with `path` to get that document's full Markdown."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": (
                    "Document path relative to the memory root, e.g. 'facts.md', 'boundaries.md', "
                    "'decisions/2026-01-31-database.md'. Omit to list documents."
                ),
            }
        },
        "additionalProperties": False,
    },
    mutating=False,
)

MEMORY_PROPOSE_SPEC = ToolSpec(
    name="memory_propose",
    description=(
        "Propose a change to the shared memory. Provide the COMPLETE new content of one document; the user "
        "reviews the diff and the change is committed only if approved. Use it for durable knowledge: verified "
        "project facts (facts.md), decisions (decisions/YYYY-MM-DD-short-title.md with front matter title, "
        "date, status, summary) or boundaries (boundaries.md). Read the current document first with "
        "memory_read and keep everything that is still true. Do not store secrets."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Document path, e.g. 'facts.md' or 'decisions/...md'."},
            "content": {"type": "string", "description": "Full new Markdown content of the document."},
            "rationale": {"type": "string", "description": "Why this change is needed (shown to the user)."},
        },
        "required": ["path", "content", "rationale"],
        "additionalProperties": False,
    },
    mutating=False,
)


class MemoryReadTool:
    spec = MEMORY_READ_SPEC

    def __init__(self, svc: MemoryServiceImpl) -> None:
        self._svc = svc

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        path = args.get("path")
        if path is not None and not isinstance(path, str):
            return ToolResult(content="`path` must be a string.", is_error=True)
        if not path or not path.strip():
            docs = await self._svc.list_docs(ctx.workspace_id)
            lines = [f"Memory documents ({len(docs)}):"]
            for d in docs:
                updated = f", updated {d.updated_at.date().isoformat()}" if d.updated_at else ""
                lines.append(f"- {d.path} [{d.layer}] — {d.title}{updated}")
            lines.append("Call memory_read with a `path` to read one document.")
            return ToolResult(
                content="\n".join(lines),
                data={"documents": [{"path": d.path, "layer": d.layer, "title": d.title} for d in docs]},
            )
        doc = await self._svc.read(ctx.workspace_id, path)
        content = truncate_lines(doc.content, _MAX_TOOL_CHARS, marker="… (truncated)")
        return ToolResult(content=content, data={"path": doc.path, "layer": doc.layer, "title": doc.title})


class MemoryProposeTool:
    spec = MEMORY_PROPOSE_SPEC

    def __init__(self, svc: MemoryServiceImpl) -> None:
        self._svc = svc

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        path, content, rationale = args.get("path"), args.get("content"), args.get("rationale")
        if not isinstance(path, str) or not isinstance(content, str):
            return ToolResult(content="`path` and `content` are required strings.", is_error=True)
        proposal = await self._svc.propose(
            ctx.workspace_id,
            path=path,
            new_content=content,
            rationale=rationale if isinstance(rationale, str) else None,
            source_session_id=ctx.session_id,
        )
        return ToolResult(
            content=(
                f"Proposal {proposal.id} for {proposal.path} was sent to the user for approval. "
                "It is NOT applied yet; it will be committed only if the user approves it. Continue your task."
            ),
            data={"proposal_id": proposal.id, "approval_id": proposal.approval_id, "path": proposal.path},
        )
