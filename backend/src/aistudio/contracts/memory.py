"""Shared memory (spec §10). Implemented in ``aistudio.memory``.

Layout of a workspace memory repo (its own git repo, markdown, hand-editable)::

    facts.md          # proje gerçekleri
    boundaries.md     # sınırlar; YAML front matter is machine-read into Boundaries
    decisions/        # YYYY-MM-DD-<slug>.md karar kayıtları
    sessions/         # YYYY-MM-DD-<session>.md oturum özetleri
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Protocol

from pydantic import BaseModel

from aistudio.contracts.agents import AgentRole, Boundaries

MemoryLayer = Literal["facts", "decisions", "boundaries", "sessions"]


class MemoryDoc(BaseModel):
    path: str  # relative to the memory root
    layer: MemoryLayer
    title: str
    content: str
    updated_at: datetime | None = None


class MemoryProposal(BaseModel):
    id: str
    workspace_id: str
    layer: MemoryLayer
    path: str
    old_content: str | None
    new_content: str
    diff: str
    rationale: str | None = None
    source_session_id: str | None = None
    approval_id: str | None = None
    status: Literal["pending", "applied", "rejected"] = "pending"
    created_at: datetime


class MemoryService(Protocol):
    async def ensure(self, workspace_id: str) -> None:
        """Create the memory repo with starter files if missing."""
        ...

    async def context_for_agent(self, workspace_id: str, *, role: AgentRole) -> str:
        """Compact text for the system prompt: facts + boundaries + decision index."""
        ...

    async def list_docs(self, workspace_id: str) -> list[MemoryDoc]: ...
    async def read(self, workspace_id: str, path: str) -> MemoryDoc: ...
    async def write(self, workspace_id: str, path: str, content: str, *, message: str, actor: str = "user") -> str:
        """Direct (user) edit; commits and returns the sha."""
        ...

    async def propose(
        self,
        workspace_id: str,
        *,
        path: str,
        new_content: str,
        rationale: str | None = None,
        source_session_id: str | None = None,
    ) -> MemoryProposal:
        """Agent-side write: creates a proposal + approval; applied only when approved."""
        ...

    async def boundaries(self, workspace_id: str) -> Boundaries: ...
    async def head(self, workspace_id: str) -> str | None:
        """Current memory commit (for checkpoints)."""
        ...

    async def restore(self, workspace_id: str, commit: str) -> None: ...
