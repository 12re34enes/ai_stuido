"""Memory module tables."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, metadata

# Agent-side write proposals (spec §10). Applied (committed) only after approval.
memory_proposals = sa.Table(
    "memory_proposals",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    sa.Column("layer", sa.String(16), nullable=False),
    sa.Column("path", sa.Text, nullable=False),
    sa.Column("old_content", sa.Text),
    # What will be (or was) committed; replaced by the user-edited text when edited on approval.
    sa.Column("new_content", sa.Text, nullable=False),
    sa.Column("diff", sa.Text, nullable=False),
    sa.Column("rationale", sa.Text),
    sa.Column("source_session_id", sa.String(40)),
    sa.Column("approval_id", sa.String(40)),
    sa.Column("status", sa.String(16), nullable=False),  # pending | applied | rejected
    sa.Column("base_commit", sa.String(64)),  # memory HEAD when proposed
    sa.Column("commit_sha", sa.String(64)),  # commit that applied it
    sa.Column("edited", sa.Boolean, nullable=False, default=False),  # user changed the content
    sa.Column("note", sa.Text),  # rejection note or conflict explanation (Turkish)
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("decided_at", UTCDateTime),
    sa.Index("ix_memory_proposals_workspace", "workspace_id", "created_at"),
    sa.Index("ix_memory_proposals_approval", "approval_id"),
    sa.Index("ix_memory_proposals_status", "status"),
)
