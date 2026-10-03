"""Engine-local models (API bodies, persisted run state, reports).

Cross-module models (Task, Run, NodeRun, FlowGraph, ...) live in ``aistudio.contracts``; the
models here are only used by the engine and its API.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, computed_field

from aistudio.contracts.engine import NodeStatus, Run, RunStatus, Task, TaskCreate
from aistudio.contracts.flows import FlowGraph, FlowMode
from aistudio.contracts.limits import Budget
from aistudio.core.events import Event

Delivery = Literal["live", "dead"]
SkipReason = Literal["disabled", "dead_path"]


# --------------------------------------------------------------------------- run state


class FeedbackInfo(BaseModel):
    """Why a node is being re-run (set when a loop edge targets it)."""

    text: str = ""
    gate: str | None = None  # node id of the gate/condition that looped back
    round: int = 0


class ReviewState(BaseModel):
    findings: list[dict[str, Any]] = Field(default_factory=list)
    gate: str | None = None
    round: int = 0


class RunState(BaseModel):
    """Durable executor state (``engine_runs.state``)."""

    deliveries: dict[str, Delivery] = Field(default_factory=dict)  # edge id -> delivery
    ready: list[str] = Field(default_factory=list)  # triggered, not yet launched
    status: dict[str, NodeStatus] = Field(default_factory=dict)  # node id -> current status
    latest: dict[str, str] = Field(default_factory=dict)  # node id -> current node run id
    attempts: dict[str, int] = Field(default_factory=dict)  # node id -> attempts so far
    loops: dict[str, int] = Field(default_factory=dict)  # gate/condition id -> loop-backs used
    skip_reason: dict[str, SkipReason] = Field(default_factory=dict)
    feedback: dict[str, FeedbackInfo] = Field(default_factory=dict)  # target node -> feedback
    review: ReviewState | None = None  # latest failed cross review (review.findings)
    overrides: dict[str, str] = Field(default_factory=dict)  # node id -> output override (edited plan)
    sessions: dict[str, str] = Field(default_factory=dict)  # reuse key -> agent session id
    worktrees: dict[str, dict[str, str]] = Field(default_factory=dict)  # node id -> repo id -> worktree id
    unhandled: dict[str, str] = Field(default_factory=dict)  # node id -> error of an unhandled failure
    started_nodes: int = 0


# --------------------------------------------------------------------------- validation


class ValidationIssue(BaseModel):
    code: str
    message: str  # Turkish
    node_id: str | None = None
    edge_id: str | None = None


class ValidationReport(BaseModel):
    ok: bool
    errors: list[ValidationIssue] = Field(default_factory=list)
    warnings: list[ValidationIssue] = Field(default_factory=list)


# --------------------------------------------------------------------------- flows


class FlowCreate(BaseModel):
    workspace_id: str | None = None
    name: str
    description: str = ""
    graph: FlowGraph
    is_template: bool = False
    studio_id: str | None = None


class FlowUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    graph: FlowGraph | None = None
    is_template: bool | None = None


class SavedFlow(BaseModel):
    id: str
    version: int
    workspace_id: str | None = None
    name: str
    description: str = ""
    graph: FlowGraph
    is_template: bool = False
    studio_id: str | None = None
    created_by: str = "user"
    created_at: datetime  # of this version
    first_created_at: datetime


class FlowVersionInfo(BaseModel):
    version: int
    name: str
    created_by: str
    created_at: datetime


class ModeInfo(BaseModel):
    mode: FlowMode
    label: str
    description: str


# --------------------------------------------------------------------------- gates & evidence


class GateResult(BaseModel):
    id: str
    run_id: str
    node_run_id: str
    node_id: str
    kind: str
    status: Literal["passed", "failed", "skipped"]
    attempt: int = 1
    target_node_id: str | None = None
    summary: str = ""
    evidence: dict[str, Any] = Field(default_factory=dict)
    decided_by: str = "studiod"
    created_at: datetime


AGENT_EVIDENCE_LABEL = "Ajan tarafından eklendi — kapı kanıtı değildir"
GATE_EVIDENCE_LABEL = "Studio tarafından üretildi — kapı kanıtı"


class Evidence(BaseModel):
    id: str
    workspace_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    node_run_id: str | None = None
    node_id: str | None = None
    source: Literal["gate", "agent"]
    kind: str
    title: str
    content: str = ""
    data: dict[str, Any] | None = None
    created_by: str = "studiod"
    created_at: datetime

    @computed_field
    @property
    def label(self) -> str:
        """Makes clear whether this counts as gate evidence (agent claims never do)."""
        return AGENT_EVIDENCE_LABEL if self.source == "agent" else GATE_EVIDENCE_LABEL


# --------------------------------------------------------------------------- tasks


class TaskCreateBody(TaskCreate):
    start_on_reset: bool = False  # queue until the providers' limits reset


class TaskUpdate(BaseModel):
    title: str | None = None
    prompt: str | None = None
    priority: int | None = None
    scheduled_at: datetime | None = None
    inputs: dict[str, Any] | None = None
    budget: Budget | None = None
    repo_ids: list[str] | None = None
    base_ref: str | None = None


class StartBody(BaseModel):
    now: bool = False  # bypass the queue and start immediately
    start_on_reset: bool = False


class RatingBody(BaseModel):
    rating: int = Field(ge=1, le=5)
    note: str | None = None


class RunSummary(BaseModel):
    id: str
    status: RunStatus
    error: str | None = None
    started_at: datetime
    finished_at: datetime | None = None


class QualityComponent(BaseModel):
    key: str
    label: str  # Turkish
    weight: float
    value: float | None = None  # 0..1, None = not applicable (weight redistributed)
    detail: str = ""  # Turkish explanation of how the value was computed
    raw: dict[str, Any] = Field(default_factory=dict)


class QualityBreakdown(BaseModel):
    score: float | None = None  # 0..100
    components: list[QualityComponent] = Field(default_factory=list)
    formula: str = ""
    run_id: str | None = None
    computed_at: datetime | None = None


class TaskDetail(BaseModel):
    task: Task
    runs: list[RunSummary] = Field(default_factory=list)
    current_run: Run | None = None
    quality: QualityBreakdown | None = None
    rating: int | None = None
    rating_note: str | None = None
    error: str | None = None
    hold_until: datetime | None = None
    hold_reason: str | None = None
    start_on_reset: bool = False
    has_explicit_graph: bool = False


class QueueEntry(BaseModel):
    task: Task
    position: int
    hold_until: datetime | None = None
    hold_reason: str | None = None


# --------------------------------------------------------------------------- schedules


class ScheduleTemplate(BaseModel):
    title: str
    prompt: str
    mode: FlowMode = FlowMode.duo
    flow_id: str | None = None
    studio_id: str | None = None
    repo_ids: list[str] | None = None
    base_ref: str | None = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    budget: Budget | None = None
    priority: int = 0


class ScheduleCreate(BaseModel):
    workspace_id: str
    name: str
    cron: str
    timezone: str = "UTC"
    template: ScheduleTemplate
    enabled: bool = True


class ScheduleUpdate(BaseModel):
    name: str | None = None
    cron: str | None = None
    timezone: str | None = None
    template: ScheduleTemplate | None = None
    enabled: bool | None = None


class Schedule(BaseModel):
    id: str
    workspace_id: str
    name: str
    cron: str
    timezone: str = "UTC"
    template: ScheduleTemplate
    enabled: bool = True
    next_run_at: datetime | None = None
    last_run_at: datetime | None = None
    last_task_id: str | None = None
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- checkpoints, replay, stats


class CheckpointInfo(BaseModel):
    id: str
    run_id: str
    node_id: str
    node_run_id: str | None = None
    label: str
    gitops_checkpoint_id: str | None = None
    refs: dict[str, str] = Field(default_factory=dict)
    memory_commit: str | None = None
    created_at: datetime


class TimelinePage(BaseModel):
    run: Run
    events: list[Event]
    session_ids: list[str] = Field(default_factory=list)
    has_more: bool = False


class AgentStat(BaseModel):
    profile_id: str | None = None
    provider: str
    model: str | None = None
    node_runs: int = 0
    passed: int = 0
    failed: int = 0
    success_rate: float | None = None
    avg_duration_s: float | None = None
    gate_checks: int = 0
    gate_first_pass: int = 0
    gate_first_pass_rate: float | None = None
    avg_quality: float | None = None
    tasks: int = 0
    five_hour_percent_spent: float | None = None
    weekly_percent_spent: float | None = None
    roles: dict[str, int] = Field(default_factory=dict)


class AgentStatsReport(BaseModel):
    stats: list[AgentStat] = Field(default_factory=list)
    recommendations: list[str] = Field(default_factory=list)  # Turkish
    since: datetime | None = None
