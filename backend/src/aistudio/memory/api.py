"""HTTP API: ``/api/memory/{workspace_id}/...``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from aistudio.contracts.agents import AgentRole, Boundaries
from aistudio.contracts.memory import MemoryDoc
from aistudio.core.errors import NotFound
from aistudio.memory.repo import MemoryCommit
from aistudio.memory.service import MemoryDiff, MemoryProposalRecord, MemoryServiceImpl


class WriteBody(BaseModel):
    content: str
    message: str | None = None


class WriteResult(BaseModel):
    commit: str
    doc: MemoryDoc


class RestoreBody(BaseModel):
    commit: str


class HeadResult(BaseModel):
    head: str | None


class ContextResult(BaseModel):
    role: str
    text: str
    chars: int


def build_router(get_svc: Callable[[], MemoryServiceImpl]) -> APIRouter:
    r = APIRouter(prefix="/memory/{workspace_id}", tags=["memory"])

    @r.get("/docs", response_model=list[MemoryDoc])
    async def list_docs(workspace_id: str, content: bool = True) -> list[MemoryDoc]:
        docs = await get_svc().list_docs(workspace_id)
        if not content:
            docs = [d.model_copy(update={"content": ""}) for d in docs]
        return docs

    @r.get("/docs/{path:path}", response_model=MemoryDoc)
    async def read_doc(workspace_id: str, path: str, commit: str | None = None) -> MemoryDoc:
        if commit:
            return await get_svc().read_at(workspace_id, path, commit)
        return await get_svc().read(workspace_id, path)

    @r.put("/docs/{path:path}", response_model=WriteResult)
    async def write_doc(workspace_id: str, path: str, body: WriteBody) -> WriteResult:
        svc = get_svc()
        message = (body.message or "").strip() or f"{path} düzenlendi"
        sha = await svc.write(workspace_id, path, body.content, message=message, actor="user")
        return WriteResult(commit=sha, doc=await svc.read(workspace_id, path))

    @r.get("/history", response_model=list[MemoryCommit])
    async def history(
        workspace_id: str, path: str | None = None, limit: int = Query(50, ge=1, le=1000)
    ) -> list[MemoryCommit]:
        return await get_svc().history(workspace_id, path=path, limit=limit)

    @r.get("/diff", response_model=MemoryDiff)
    async def diff(workspace_id: str, base: str, head: str | None = None, path: str | None = None) -> MemoryDiff:
        return await get_svc().diff(workspace_id, base, head, path=path)

    @r.get("/head", response_model=HeadResult)
    async def head(workspace_id: str) -> HeadResult:
        return HeadResult(head=await get_svc().head(workspace_id))

    @r.post("/restore", response_model=HeadResult)
    async def restore(workspace_id: str, body: RestoreBody) -> HeadResult:
        svc = get_svc()
        await svc.restore(workspace_id, body.commit, actor="user")
        return HeadResult(head=await svc.head(workspace_id))

    @r.get("/proposals", response_model=list[MemoryProposalRecord])
    async def list_proposals(
        workspace_id: str,
        status: Literal["pending", "applied", "rejected"] | None = None,
        limit: int = Query(200, ge=1, le=1000),
    ) -> list[MemoryProposalRecord]:
        return await get_svc().list_proposals(workspace_id, status=status, limit=limit)

    @r.get("/proposals/{proposal_id}", response_model=MemoryProposalRecord)
    async def get_proposal(workspace_id: str, proposal_id: str) -> MemoryProposalRecord:
        rec = await get_svc().get_proposal(proposal_id)
        if rec.workspace_id != workspace_id:
            raise NotFound("Hafıza önerisi bulunamadı.")
        return rec

    @r.get("/boundaries", response_model=BoundariesView)
    async def boundaries(workspace_id: str) -> BoundariesView:
        parsed = await get_svc().boundaries(workspace_id)
        return BoundariesView(**parsed.model_dump(), warnings=await get_svc().boundary_warnings(workspace_id))

    @r.get("/context", response_model=ContextResult)
    async def context(workspace_id: str, role: AgentRole = "writer") -> ContextResult:
        text = await get_svc().context_for_agent(workspace_id, role=role)
        return ContextResult(role=role, text=text, chars=len(text))

    return r


class BoundariesView(Boundaries):
    """Parsed boundaries plus the parser's warnings (parts of boundaries.md that were ignored)."""

    warnings: list[str] = Field(default_factory=list)
