"""Tables owned by the git hosting module."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

# GitHub / GitLab accounts. The token lives in the Keychain; only its reference is stored.
git_accounts = sa.Table(
    "git_accounts",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("kind", sa.String(16), nullable=False),  # github | gitlab
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("api_url", sa.Text, nullable=False),  # https://api.github.com, https://ghe/api/v3, .../api/v4
    sa.Column("web_url", sa.Text, nullable=False),  # https://github.com, https://gitlab.example.com
    sa.Column("username", sa.String(200), nullable=False),
    sa.Column("token_ref", sa.String(200), nullable=False),
    json_col("scopes", default=[]),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.UniqueConstraint("api_url", "username", name="uq_git_accounts_api_url_username"),
)

# Optional explicit account for a repo (several accounts on the same host: work / personal).
git_repo_accounts = sa.Table(
    "git_repo_accounts",
    metadata,
    sa.Column("repo_id", sa.String(40), sa.ForeignKey("repos.id", ondelete="CASCADE"), primary_key=True),
    sa.Column("account_id", sa.String(40), sa.ForeignKey("git_accounts.id", ondelete="CASCADE"), nullable=False),
)

# PR takibi: one row per watched PR/MR. ``state`` holds the watcher's memory (handled shas,
# handled comment ids, active fix task...) so restarts never create duplicate tasks.
git_watches = sa.Table(
    "git_watches",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("repo_id", sa.String(40), sa.ForeignKey("repos.id", ondelete="CASCADE"), nullable=False),
    sa.Column("number", sa.Integer, nullable=False),
    sa.Column("workspace_id", sa.String(40), nullable=False),
    sa.Column("task_id", sa.String(40)),  # task that opened / asked to watch the PR
    sa.Column("autofix", sa.Boolean, nullable=False, default=True),
    sa.Column("status", sa.String(16), nullable=False),  # active | stopped
    sa.Column("stop_reason", sa.String(40)),  # merged | closed | user
    json_col("state", default={}),
    sa.Column("last_error", sa.Text),
    sa.Column("last_polled_at", UTCDateTime),
    sa.Column("next_poll_at", UTCDateTime),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.UniqueConstraint("repo_id", "number", name="uq_git_watches_repo_id_number"),
    sa.Index("ix_git_watches_status_next", "status", "next_poll_at"),
)
