"""Tables owned by the alerts module."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

# Delivery channels. ``config`` holds non-secret settings; secrets live in the Keychain and
# ``secret_refs`` maps each secret field to its reference.
alerts_channels = sa.Table(
    "alerts_channels",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("kind", sa.String(16), nullable=False),
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("enabled", sa.Boolean, nullable=False, default=True),
    json_col("config", default={}),
    json_col("secret_refs", default={}),
    sa.Column("last_error", sa.Text),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
)

# User routing rules. Matching rules replace the default severity routing for an alert.
alerts_rules = sa.Table(
    "alerts_rules",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("enabled", sa.Boolean, nullable=False, default=True),
    json_col("event_types", default=[]),
    sa.Column("min_severity", sa.String(16), nullable=False),
    sa.Column("workspace_id", sa.String(40)),
    json_col("channel_ids", default=[]),
    sa.Column("sound", sa.Boolean, nullable=False, default=False),
    sa.Column("bypass_quiet_hours", sa.Boolean, nullable=False, default=False),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
)

# One row per delivery attempt outcome (and per suppressed / deduplicated / grouped alert).
alerts_log = sa.Table(
    "alerts_log",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("alert_id", sa.String(40), nullable=False),
    sa.Column("channel_id", sa.String(40)),
    sa.Column("channel_kind", sa.String(16)),
    sa.Column("event_id", sa.Integer),
    sa.Column("event_type", sa.String(80), nullable=False),
    sa.Column("severity", sa.String(16), nullable=False),
    sa.Column("title", sa.Text, nullable=False),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("attempts", sa.Integer, nullable=False, default=0),
    sa.Column("error", sa.Text),
    sa.Column("approval_id", sa.String(40)),
    sa.Column("test", sa.Boolean, nullable=False, default=False),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Index("ix_alerts_log_created", "created_at"),
    sa.Index("ix_alerts_log_channel", "channel_id", "id"),
)

# Messages that carry approval buttons, so they can be edited once the approval is decided.
alerts_messages = sa.Table(
    "alerts_messages",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("channel_id", sa.String(40), sa.ForeignKey("alerts_channels.id", ondelete="CASCADE"), nullable=False),
    sa.Column("approval_id", sa.String(40), nullable=False),
    json_col("external_ref", default={}),
    json_col("alert", default={}),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Index("ix_alerts_messages_approval", "approval_id"),
)
