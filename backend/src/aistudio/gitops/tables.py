"""Tables owned by the gitops module."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

# One row per agent worktree. ``repo_path``/``host_id`` are copied from the repo at creation so
# cleanup keeps working even if the repo is later removed from the workspace.
worktrees = sa.Table(
    "gitops_worktrees",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("repo_id", sa.String(40), nullable=False),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    sa.Column("repo_path", sa.Text, nullable=False),
    sa.Column("host_id", sa.String(40)),
    sa.Column("path", sa.Text, nullable=False),
    sa.Column("branch", sa.String(250), nullable=False),
    sa.Column("base_ref", sa.String(250), nullable=False),
    sa.Column("base_sha", sa.String(64), nullable=False),
    json_col("location", default={}),
    sa.Column("run_id", sa.String(40)),
    sa.Column("task_id", sa.String(40)),
    sa.Column("label", sa.String(120)),
    sa.Column("status", sa.String(16), nullable=False),
    sa.Column("merged_into", sa.String(250)),
    sa.Column("merged_sha", sa.String(64)),
    sa.Column("created_at", UTCDateTime, nullable=False),
    # Last status change; drives retention-based cleanup.
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.UniqueConstraint("repo_id", "branch", name="uq_gitops_worktrees_repo_branch"),
    sa.Index("ix_gitops_worktrees_status", "status", "updated_at"),
    sa.Index("ix_gitops_worktrees_run", "run_id"),
    sa.Index("ix_gitops_worktrees_repo", "repo_id"),
)

# Checkpoints: ``refs`` maps worktree_id -> snapshot commit, each also stored in the repo under
# ``refs/aistudio/checkpoints/<checkpoint_id>/<worktree_id>``.
checkpoints = sa.Table(
    "gitops_checkpoints",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("run_id", sa.String(40)),
    sa.Column("node_id", sa.String(120)),
    sa.Column("workspace_id", sa.String(40)),
    sa.Column("label", sa.Text, nullable=False),
    json_col("refs", default={}),
    sa.Column("memory_commit", sa.String(64)),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("restored_at", UTCDateTime),
    sa.Index("ix_gitops_checkpoints_run", "run_id", "created_at"),
)
