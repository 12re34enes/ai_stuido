"""Core tables owned by the foundation. Feature modules declare their own in ``<module>/tables.py``."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

# Append-only, hash-chained event log: the single source of truth (see core/eventlog.py).
events = sa.Table(
    "events",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("ts", UTCDateTime, nullable=False),
    sa.Column("type", sa.String(80), nullable=False),
    sa.Column("severity", sa.String(16), nullable=False),
    sa.Column("actor", sa.String(120), nullable=False),
    sa.Column("workspace_id", sa.String(40)),
    sa.Column("task_id", sa.String(40)),
    sa.Column("run_id", sa.String(40)),
    sa.Column("session_id", sa.String(40)),
    json_col("payload", default={}),
    sa.Column("prev_hash", sa.String(64), nullable=False),
    sa.Column("hash", sa.String(64), nullable=False),
    sa.Index("ix_events_workspace", "workspace_id", "id"),
    sa.Index("ix_events_run", "run_id", "id"),
    sa.Index("ix_events_session", "session_id", "id"),
    sa.Index("ix_events_task", "task_id", "id"),
    sa.Index("ix_events_type", "type", "id"),
)

workspaces = sa.Table(
    "workspaces",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("slug", sa.String(80), nullable=False, unique=True),
    sa.Column("color", sa.String(16), nullable=False, default="#C96442"),
    sa.Column("archived", sa.Boolean, nullable=False, default=False),
    json_col("settings", default={}),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
)

repos = sa.Table(
    "repos",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
    sa.Column("name", sa.String(200), nullable=False),
    # Local checkout path, or a path on a remote host when host_id is set.
    sa.Column("path", sa.Text, nullable=False),
    sa.Column("host_id", sa.String(40)),
    sa.Column("remote_url", sa.Text),
    sa.Column("provider", sa.String(16)),  # github | gitlab | None
    sa.Column("default_branch", sa.String(200), nullable=False, default="main"),
    # Commands studiod runs for the build/test gate: {"lint": "...", "typecheck": "...", ...}
    json_col("commands", default={}),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Index("ix_repos_workspace", "workspace_id"),
)

approvals = sa.Table(
    "approvals",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40)),
    sa.Column("task_id", sa.String(40)),
    sa.Column("run_id", sa.String(40)),
    sa.Column("session_id", sa.String(40)),
    sa.Column("kind", sa.String(40), nullable=False),
    sa.Column("title", sa.Text, nullable=False),
    sa.Column("summary", sa.Text),
    json_col("payload", default={}),
    sa.Column("severity", sa.String(16), nullable=False),
    sa.Column("production", sa.Boolean, nullable=False, default=False),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("requested_by", sa.String(120), nullable=False),
    sa.Column("decided_by", sa.String(120)),
    sa.Column("decision_note", sa.Text),
    json_col("decision_payload", nullable=True),
    sa.Column("channel", sa.String(40)),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("decided_at", UTCDateTime),
    sa.Column("expires_at", UTCDateTime),
    sa.Index("ix_approvals_status", "status", "created_at"),
)

# Small key/value store for global settings (alert defaults, appearance, safety switches).
kv_settings = sa.Table(
    "kv_settings",
    metadata,
    sa.Column("key", sa.String(120), primary_key=True),
    sa.Column("value", sa.JSON, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
)
