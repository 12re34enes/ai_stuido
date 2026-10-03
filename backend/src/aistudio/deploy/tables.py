"""Deploy module tables."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

deploy_profiles = sa.Table(
    "deploy_profiles",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    sa.Column("name", sa.String(120), nullable=False),
    sa.Column("kind", sa.String(16), nullable=False),  # ci | ssh | command
    sa.Column("environment", sa.String(16), nullable=False),
    json_col("config", default={}),
    json_col("health_check", nullable=True),
    json_col("rollback", nullable=True),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Index("ix_deploy_profiles_workspace", "workspace_id"),
)

deploy_runs = sa.Table(
    "deploy_runs",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("profile_id", sa.String(40), nullable=False),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    sa.Column("profile_name", sa.String(120), nullable=False),
    sa.Column("kind", sa.String(16), nullable=False),
    sa.Column("environment", sa.String(16), nullable=False),
    # pending_approval | running | succeeded | failed | rejected | cancelled
    sa.Column("status", sa.String(24), nullable=False),
    sa.Column("ref", sa.String(255)),
    sa.Column("summary", sa.Text),
    sa.Column("actor", sa.String(120), nullable=False),
    sa.Column("task_id", sa.String(40)),
    sa.Column("run_id", sa.String(40)),
    sa.Column("approval_id", sa.String(40)),
    sa.Column("approved_by", sa.String(120)),
    sa.Column("health_ok", sa.Boolean),
    sa.Column("external_id", sa.String(120)),  # CI run / pipeline id
    sa.Column("rollback_of", sa.String(40)),
    sa.Column("rollback_available", sa.Boolean, nullable=False, default=False),
    sa.Column("error", sa.Text),
    sa.Column("log", sa.Text, nullable=False, default=""),
    sa.Column("started_at", UTCDateTime, nullable=False),
    sa.Column("finished_at", UTCDateTime),
    sa.Index("ix_deploy_runs_profile", "profile_id", "started_at"),
    sa.Index("ix_deploy_runs_workspace", "workspace_id", "started_at"),
)
