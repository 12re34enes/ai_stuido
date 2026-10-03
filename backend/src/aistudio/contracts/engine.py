"""Tasks and runs (spec §5). Implemented in ``aistudio.engine``."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from aistudio.contracts.flows import FlowGraph, FlowMode
from aistudio.contracts.limits import Budget
from aistudio.contracts.teams import TeamSpec

TaskStatus = Literal["draft", "queued", "running", "waiting", "completed", "failed", "cancelled"]
RunStatus = Literal["running", "waiting", "completed", "failed", "cancelled"]
NodeStatus = Literal["pending", "running", "waiting", "passed", "failed", "skipped", "cancelled"]


class TaskCreate(BaseModel):
    workspace_id: str
    title: str
    prompt: str
    mode: FlowMode = FlowMode.duo
    flow_id: str | None = None  # saved flow; overrides mode
    studio_id: str | None = None  # studio template; overrides mode
    graph: FlowGraph | None = None  # explicit graph; overrides everything
    team_id: str | None = None  # mode=team: saved team template
    team: TeamSpec | None = None  # mode=team: inline team spec (wins over team_id)
    repo_ids: list[str] | None = None  # None = all workspace repos
    base_ref: str | None = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    budget: Budget | None = None
    priority: int = 0
    scheduled_at: datetime | None = None
    source: Literal["user", "schedule", "pr_watch", "issue", "studio"] = "user"
    source_ref: dict[str, Any] | None = None  # e.g. {"repo_id":..., "pr": 12}
    start: bool = True


class Task(BaseModel):
    id: str
    workspace_id: str
    title: str
    prompt: str
    mode: FlowMode
    flow_id: str | None = None
    studio_id: str | None = None
    repo_ids: list[str] | None = None
    base_ref: str | None = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    budget: Budget | None = None
    priority: int = 0
    status: TaskStatus
    scheduled_at: datetime | None = None
    source: str = "user"
    source_ref: dict[str, Any] | None = None
    current_run_id: str | None = None
    quality_score: float | None = None
    created_at: datetime
    updated_at: datetime


class NodeRun(BaseModel):
    id: str
    run_id: str
    node_id: str
    status: NodeStatus
    attempt: int = 1
    session_ids: list[str] = Field(default_factory=list)
    worktree_ids: list[str] = Field(default_factory=list)
    output: str | None = None
    data: dict[str, Any] | None = None
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


class Run(BaseModel):
    id: str
    task_id: str
    workspace_id: str
    graph: FlowGraph
    status: RunStatus
    nodes: list[NodeRun] = Field(default_factory=list)  # history: every attempt of every node
    # Current status per node id: the live executor state while the run is in memory, otherwise
    # each node's latest attempt. After a loop-back the looped region is "pending" here even though
    # ``nodes`` still holds the earlier (passed) attempts. UIs should render from this.
    node_states: dict[str, NodeStatus] = Field(default_factory=dict)
    started_at: datetime
    finished_at: datetime | None = None


class FlowEngine(Protocol):
    async def create_task(self, req: TaskCreate) -> Task: ...
    async def start(self, task_id: str) -> Run: ...
    async def cancel(self, run_id: str) -> None: ...
    async def retry_node(self, run_id: str, node_id: str) -> None: ...
    async def get_task(self, task_id: str) -> Task: ...
    async def get_run(self, run_id: str) -> Run: ...
    async def graph_for_mode(self, mode: FlowMode, *, workspace_id: str) -> FlowGraph: ...
