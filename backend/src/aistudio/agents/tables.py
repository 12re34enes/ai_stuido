"""Tables owned by the agents module."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

# Agent profiles (AgentProfile). workspace_id NULL = global profile. Built-in defaults are seeded
# on first start and can be edited but not deleted.
agents_profiles = sa.Table(
    "agents_profiles",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40)),
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("provider", sa.String(16), nullable=False),
    sa.Column("model", sa.String(120)),
    sa.Column("effort", sa.String(32)),
    sa.Column("role", sa.String(32), nullable=False),
    sa.Column("instructions", sa.Text, nullable=False, default=""),
    json_col("boundaries", default={}),
    sa.Column("color", sa.String(16)),
    sa.Column("builtin", sa.Boolean, nullable=False, default=False),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Index("ix_agents_profiles_workspace", "workspace_id"),
)

# Agent sessions (SessionRecord) plus what is needed to resume them after a restart.
agents_sessions = sa.Table(
    "agents_sessions",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    sa.Column("provider", sa.String(16), nullable=False),
    sa.Column("profile_id", sa.String(40)),
    sa.Column("native_id", sa.String(200)),
    json_col("location", default={"kind": "local", "host_id": None}),
    sa.Column("cwd", sa.Text, nullable=False),
    sa.Column("worktree_id", sa.String(40)),
    sa.Column("task_id", sa.String(40)),
    sa.Column("run_id", sa.String(40)),
    sa.Column("node_id", sa.String(80)),
    sa.Column("label", sa.String(200)),
    sa.Column("role", sa.String(32), nullable=False),
    sa.Column("model", sa.String(120)),
    sa.Column("state", sa.String(32), nullable=False),
    sa.Column("origin", sa.String(16), nullable=False),
    sa.Column("title", sa.Text),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    json_col("last_usage", nullable=True),
    # The original StartSessionRequest pieces ({"spec", "tool_names"}) used to rebuild the spec
    # on resume. NULL for imported sessions.
    json_col("request", nullable=True),
    sa.Index("ix_agents_sessions_workspace", "workspace_id", "created_at"),
    sa.Index("ix_agents_sessions_run", "run_id"),
    sa.Index("ix_agents_sessions_task", "task_id"),
    sa.Index("ix_agents_sessions_native", "provider", "native_id"),
)

# CLI-native subagents of a session (Claude Agent/Task tool, Codex sub-agent threads), built from
# the agent.subagent.* events and the payloads tagged with subagent_id (agents/subagents.py).
agents_subagents = sa.Table(
    "agents_subagents",
    metadata,
    sa.Column("session_id", sa.String(40), primary_key=True),
    sa.Column("subagent_id", sa.String(200), primary_key=True),
    sa.Column("parent_subagent_id", sa.String(200)),
    sa.Column("parent_call_id", sa.String(200)),
    sa.Column("name", sa.String(200)),
    sa.Column("description", sa.Text),
    sa.Column("prompt", sa.Text),
    sa.Column("status", sa.String(16), nullable=False),  # running | success | error | interrupted
    sa.Column("model", sa.String(120)),
    sa.Column("started_at", UTCDateTime, nullable=False),
    sa.Column("finished_at", UTCDateTime),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Column("input_tokens", sa.Integer, nullable=False, default=0),
    sa.Column("output_tokens", sa.Integer, nullable=False, default=0),
    sa.Column("tool_calls", sa.Integer, nullable=False, default=0),
    sa.Column("last_text", sa.Text),
    sa.Index("ix_agents_subagents_session", "session_id", "started_at"),
)
