"""Studios: versioned packaged flows (spec §16). Implemented in ``aistudio.studios``."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Protocol

from pydantic import BaseModel, Field

from aistudio.contracts.flows import FlowGraph


class StudioInput(BaseModel):
    name: str
    label: str  # Turkish
    type: str = "text"  # text | textarea | select | repo | branch | host | db
    required: bool = True
    default: Any = None
    options: list[str] | None = None
    help: str | None = None


class Studio(BaseModel):
    id: str  # slug: "architecture", "market-analysis", ...
    name: str  # Turkish display name
    description: str
    icon: str = "sparkles"
    version: int = 1
    builtin: bool = True
    inputs: list[StudioInput] = Field(default_factory=list)
    graph: FlowGraph
    output_format: str = "markdown"  # how the final output is rendered
    output_template: str | None = None  # Jinja2 producing the final document
    updated_at: datetime | None = None


class StudioService(Protocol):
    async def list(self) -> list[Studio]: ...
    async def get(self, studio_id: str, version: int | None = None) -> Studio: ...
    async def save(self, studio: Studio) -> Studio:
        """Creates a new version (never overwrites)."""
        ...

    async def instantiate(self, studio_id: str, *, workspace_id: str, inputs: dict[str, Any]) -> FlowGraph: ...
