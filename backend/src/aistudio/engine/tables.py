"""Engine tables: saved flows, tasks, runs, node runs, gate results, evidence, schedules, checkpoints.

Run state that the executor needs to resume after a studiod restart lives in ``engine_runs.state``
(edge deliveries, loop counters, ready queue, feedback) and ``engine_node_runs.state`` (per node
progress such as the session id of an in-flight turn or the id of a pending approval).
"""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

# One row per version. The latest non-archived version is the current one.
engine_flows = sa.Table(
    "engine_flows",
    metadata,
    sa.Column("flow_id", sa.String(40), primary_key=True),
    sa.Column("version", sa.Integer, primary_key=True),
    sa.Column("workspace_id", sa.String(40)),  # None = global flow
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("description", sa.Text, nullable=False, default=""),
    json_col("graph", default={}),
    sa.Column("is_template", sa.Boolean, nullable=False, default=False),
    sa.Column("studio_id", sa.String(80)),
    sa.Column("created_by", sa.String(120), nullable=False, default="user"),
    sa.Column("archived", sa.Boolean, nullable=False, default=False),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Index("ix_engine_flows_workspace", "workspace_id"),
)

engine_tasks = sa.Table(
    "engine_tasks",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    sa.Column("title", sa.Text, nullable=False),
    sa.Column("prompt", sa.Text, nullable=False),
    sa.Column("mode", sa.String(16), nullable=False),
    sa.Column("flow_id", sa.String(40)),
    sa.Column("studio_id", sa.String(80)),
    json_col("graph", nullable=True),  # explicit graph (overrides studio/flow/mode)
    json_col("repo_ids", nullable=True),
    sa.Column("base_ref", sa.String(200)),
    json_col("inputs", default={}),
    json_col("budget", nullable=True),
    sa.Column("priority", sa.Integer, nullable=False, default=0),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("scheduled_at", UTCDateTime),
    sa.Column("source", sa.String(32), nullable=False, default="user"),
    json_col("source_ref", nullable=True),
    sa.Column("current_run_id", sa.String(40)),
    sa.Column("quality_score", sa.Float),
    json_col("quality", nullable=True),  # QualityBreakdown of the latest completed run
    sa.Column("rating", sa.Integer),  # user rating 1..5
    sa.Column("rating_note", sa.Text),
    sa.Column("start_on_reset", sa.Boolean, nullable=False, default=False),
    sa.Column("hold_until", UTCDateTime),  # queue: not before (limit reset)
    sa.Column("hold_reason", sa.Text),
    sa.Column("error", sa.Text),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Column("started_at", UTCDateTime),
    sa.Column("finished_at", UTCDateTime),
    sa.Index("ix_engine_tasks_workspace", "workspace_id", "created_at"),
    sa.Index("ix_engine_tasks_status", "status", "priority"),
)

engine_runs = sa.Table(
    "engine_runs",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("task_id", sa.String(40), nullable=False),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    json_col("graph", default={}),  # snapshot of the graph this run executes
    sa.Column("status", sa.String(16), nullable=False),
    json_col("state", default={}),  # RunState
    sa.Column("error", sa.Text),
    json_col("quality", nullable=True),
    sa.Column("started_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Column("finished_at", UTCDateTime),
    sa.Index("ix_engine_runs_task", "task_id", "started_at"),
    sa.Index("ix_engine_runs_status", "status"),
)

engine_node_runs = sa.Table(
    "engine_node_runs",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("run_id", sa.String(40), nullable=False),
    sa.Column("node_id", sa.String(80), nullable=False),
    sa.Column("kind", sa.String(16), nullable=False),
    sa.Column("label", sa.Text, nullable=False, default=""),
    sa.Column("attempt", sa.Integer, nullable=False, default=1),
    sa.Column("status", sa.String(16), nullable=False),
    json_col("session_ids", default=[]),
    json_col("worktree_ids", default=[]),
    sa.Column("output", sa.Text),
    json_col("data", nullable=True),
    sa.Column("error", sa.Text),
    json_col("state", default={}),  # resumable per-node progress
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("started_at", UTCDateTime),
    sa.Column("finished_at", UTCDateTime),
    sa.Index("ix_engine_node_runs_run", "run_id", "node_id", "attempt"),
)

engine_gate_results = sa.Table(
    "engine_gate_results",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("run_id", sa.String(40), nullable=False),
    sa.Column("node_run_id", sa.String(40), nullable=False),
    sa.Column("node_id", sa.String(80), nullable=False),
    sa.Column("kind", sa.String(32), nullable=False),  # GateKind
    sa.Column("status", sa.String(16), nullable=False),  # passed | failed | skipped
    sa.Column("attempt", sa.Integer, nullable=False, default=1),
    sa.Column("target_node_id", sa.String(80)),
    sa.Column("summary", sa.Text, nullable=False, default=""),
    json_col("evidence", default={}),
    sa.Column("decided_by", sa.String(120), nullable=False, default="studiod"),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Index("ix_engine_gate_results_run", "run_id", "created_at"),
)

engine_evidence = sa.Table(
    "engine_evidence",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40)),
    sa.Column("task_id", sa.String(40)),
    sa.Column("run_id", sa.String(40)),
    sa.Column("node_run_id", sa.String(40)),
    sa.Column("node_id", sa.String(80)),
    # gate = produced by studiod itself (counts as gate evidence); agent = submitted by an agent
    sa.Column("source", sa.String(16), nullable=False),
    sa.Column("kind", sa.String(32), nullable=False),  # command | review | approval | text | output | link | ...
    sa.Column("title", sa.Text, nullable=False),
    sa.Column("content", sa.Text, nullable=False, default=""),
    json_col("data", nullable=True),
    sa.Column("created_by", sa.String(120), nullable=False, default="studiod"),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Index("ix_engine_evidence_run", "run_id", "created_at"),
)

engine_schedules = sa.Table(
    "engine_schedules",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("cron", sa.String(120), nullable=False),
    sa.Column("timezone", sa.String(64), nullable=False, default="UTC"),
    json_col("template", default={}),  # TaskCreate fields (without workspace_id)
    sa.Column("enabled", sa.Boolean, nullable=False, default=True),
    sa.Column("next_run_at", UTCDateTime),
    sa.Column("last_run_at", UTCDateTime),
    sa.Column("last_task_id", sa.String(40)),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Index("ix_engine_schedules_next", "enabled", "next_run_at"),
)

engine_checkpoints = sa.Table(
    "engine_checkpoints",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("run_id", sa.String(40), nullable=False),
    sa.Column("node_id", sa.String(80), nullable=False),
    sa.Column("node_run_id", sa.String(40)),
    sa.Column("label", sa.Text, nullable=False),
    sa.Column("gitops_checkpoint_id", sa.String(40)),
    json_col("refs", default={}),
    sa.Column("memory_commit", sa.String(64)),
    json_col("snapshot", default={}),  # RunState + node statuses at that moment
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Index("ix_engine_checkpoints_run", "run_id", "created_at"),
)
