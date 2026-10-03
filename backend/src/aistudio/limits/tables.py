"""Tables owned by the limits module."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, metadata

# Limit observations (LimitWindow). Only meaningful changes are stored (see service.py).
limits_snapshots = sa.Table(
    "limits_snapshots",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("provider", sa.String(16), nullable=False),
    sa.Column("window", sa.String(64), nullable=False, quote=True),
    sa.Column("label", sa.String(120), nullable=False),
    sa.Column("used_percent", sa.Float, nullable=False),
    sa.Column("resets_at", UTCDateTime),
    sa.Column("window_minutes", sa.Integer),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("source", sa.String(16), nullable=False),
    sa.Column("observed_at", UTCDateTime, nullable=False),
    sa.Index("ix_limits_snapshots_window", "provider", "window", "id"),
)

# Limit percentage attributed to tasks (approximation, see LimitServiceImpl._attribute).
limits_task_usage = sa.Table(
    "limits_task_usage",
    metadata,
    sa.Column("task_id", sa.String(40), primary_key=True),
    sa.Column("provider", sa.String(16), primary_key=True),
    sa.Column("window", sa.String(64), primary_key=True, quote=True),
    sa.Column("window_class", sa.String(16), nullable=False),  # five_hour | weekly | model | other
    sa.Column("percent", sa.Float, nullable=False, default=0.0),
    sa.Column("updated_at", UTCDateTime, nullable=False),
)
