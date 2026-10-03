"""Studio tools: functions AI Studio exposes to agents through the agent channel
(Claude: SDK MCP server over the control protocol ``mcp_message``; Codex: dynamic tools).

Modules register tools in ``setup``:

    ctx.services.get(ToolRegistry).register(MyTool())

Tool names use ``domain_verb`` snake_case (MCP-safe): ``memory_read``, ``memory_propose``,
``evidence_submit``, ``ask_user``, ``report_status``, ``handoff``, ``remote_exec``,
``db_query``, ``deploy_request``.
"""

from __future__ import annotations

from typing import Any, Protocol

from pydantic import BaseModel, Field

from aistudio.contracts.common import Location, Provider


class ToolSpec(BaseModel):
    name: str
    description: str  # shown to the model; English is fine, keep it precise
    input_schema: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})
    # Tools that change the outside world. Read-only agents (advisors) never get these.
    mutating: bool = False


class ToolContext(BaseModel):
    workspace_id: str
    session_id: str
    provider: Provider
    location: Location = Field(default_factory=Location)
    task_id: str | None = None
    run_id: str | None = None
    node_id: str | None = None
    agent_label: str | None = None


class ToolResult(BaseModel):
    content: str  # text returned to the model
    is_error: bool = False
    data: dict[str, Any] | None = None  # structured copy for the UI/eventlog


class StudioTool(Protocol):
    spec: ToolSpec

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult: ...


class ToolHost(Protocol):
    """Bound set of tools for one agent session (what an adapter talks to)."""

    def specs(self) -> list[ToolSpec]: ...
    async def call(self, name: str, args: dict[str, Any]) -> ToolResult: ...


class ToolRegistry(Protocol):
    def register(self, tool: StudioTool) -> None: ...
    def get(self, name: str) -> StudioTool: ...
    def all_specs(self) -> list[ToolSpec]: ...
    def bind(self, ctx: ToolContext, names: list[str] | None = None, *, allow_mutating: bool = True) -> ToolHost:
        """``names`` None = every registered tool."""
        ...
