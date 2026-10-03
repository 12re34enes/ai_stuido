"""Remote module tables. Secrets (passwords, key passphrases) live only in ``ctx.secrets``;
these rows never hold them."""

from __future__ import annotations

import sqlalchemy as sa

from aistudio.storage.db import UTCDateTime, json_col, metadata

remote_hosts = sa.Table(
    "remote_hosts",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40)),
    sa.Column("name", sa.String(120), nullable=False),
    sa.Column("hostname", sa.String(255), nullable=False),
    sa.Column("port", sa.Integer, nullable=False, default=22),
    sa.Column("username", sa.String(120), nullable=False),
    sa.Column("jump_host_id", sa.String(40)),
    sa.Column("auth", sa.String(16), nullable=False, default="key"),
    sa.Column("key_path", sa.Text),
    sa.Column("environment", sa.String(16), nullable=False),
    sa.Column("permission_level", sa.String(16), nullable=False),
    # Glob (or ``re:``) patterns for writes allowed without approval at the ``limited`` level.
    json_col("limited_write_patterns", default=[]),
    # Which secrets exist in the Keychain for this row ("password", "passphrase"); never values.
    json_col("secret_fields", default=[]),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Index("ix_remote_hosts_workspace", "workspace_id"),
)

remote_db_profiles = sa.Table(
    "remote_db_profiles",
    metadata,
    sa.Column("id", sa.String(40), primary_key=True),
    sa.Column("workspace_id", sa.String(40)),
    sa.Column("name", sa.String(120), nullable=False),
    sa.Column("kind", sa.String(16), nullable=False),
    sa.Column("host", sa.String(255)),
    sa.Column("port", sa.Integer),
    sa.Column("database", sa.Text),
    sa.Column("username", sa.String(120)),
    sa.Column("via_host_id", sa.String(40)),
    json_col("options", default={}),
    sa.Column("environment", sa.String(16), nullable=False),
    sa.Column("permission_level", sa.String(16), nullable=False),
    json_col("limited_write_patterns", default=[]),
    # Which secrets exist in the Keychain for this row ("password", "passphrase"); never values.
    json_col("secret_fields", default=[]),
    sa.Column("created_at", UTCDateTime, nullable=False),
    sa.Column("updated_at", UTCDateTime, nullable=False),
    sa.Index("ix_remote_db_profiles_workspace", "workspace_id"),
)
