"""Studios module tables."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

# Every save of a user-defined or edited studio is a new immutable row. Built-in studios are not
# stored here; they ship as package YAML and are always available as version 1.
studios_versions = sa.Table(
    "studios_versions",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
    sa.Column("studio_id", sa.String(80), nullable=False),
    sa.Column("version", sa.Integer, nullable=False),
    json_col("data"),  # full Studio JSON
    sa.Column("note", sa.Text),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.UniqueConstraint("studio_id", "version"),
    sa.Index("ix_studios_versions_studio", "studio_id", "version"),
)
