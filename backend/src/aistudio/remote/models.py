"""API and internal models of the remote module (contract models live in contracts/remote.py)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, SecretStr

from aistudio.contracts.common import Environment, PermissionLevel, Provider
from aistudio.contracts.remote import CommandClass, DbKind, DbProfile, Host

HOSTNAME_PATTERN = r"^[A-Za-z0-9._:%\-]+$"
USERNAME_PATTERN = r"^[A-Za-z0-9._@+\-\\]+$"

DEFAULT_DB_PORTS: dict[str, int] = {"postgres": 5432, "mysql": 3306, "mssql": 1433, "mongodb": 27017, "redis": 6379}


class HostRecord(Host):
    """A host as stored (adds non-contract fields). Secrets are never included, only flags."""

    limited_write_patterns: list[str] = Field(default_factory=list)
    has_password: bool = False
    has_passphrase: bool = False
    updated_at: datetime | None = None


class HostCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    hostname: str = Field(min_length=1, max_length=255, pattern=HOSTNAME_PATTERN)
    port: int = Field(default=22, ge=1, le=65535)
    username: str = Field(min_length=1, max_length=120, pattern=USERNAME_PATTERN)
    workspace_id: str | None = None
    jump_host_id: str | None = None
    auth: Literal["key", "password", "agent"] = "key"
    key_path: str | None = None
    environment: Environment = Environment.test
    permission_level: PermissionLevel = PermissionLevel.read
    limited_write_patterns: list[str] = Field(default_factory=list)
    password: SecretStr | None = None
    passphrase: SecretStr | None = None


class HostUpdate(BaseModel):
    """Only fields that are present are changed. An empty ``password``/``passphrase`` deletes it."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    hostname: str | None = Field(default=None, min_length=1, max_length=255, pattern=HOSTNAME_PATTERN)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = Field(default=None, min_length=1, max_length=120, pattern=USERNAME_PATTERN)
    jump_host_id: str | None = None
    auth: Literal["key", "password", "agent"] | None = None
    key_path: str | None = None
    environment: Environment | None = None
    permission_level: PermissionLevel | None = None
    limited_write_patterns: list[str] | None = None
    password: SecretStr | None = None
    passphrase: SecretStr | None = None


class DbProfileRecord(DbProfile):
    limited_write_patterns: list[str] = Field(default_factory=list)
    has_password: bool = False
    updated_at: datetime | None = None


class DbProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: DbKind
    host: str | None = Field(default=None, max_length=255, pattern=HOSTNAME_PATTERN)
    port: int | None = Field(default=None, ge=1, le=65535)
    database: str | None = None  # SQLite: file path on this Mac; Redis: db number
    username: str | None = Field(default=None, max_length=120)
    via_host_id: str | None = None
    options: dict[str, Any] = Field(default_factory=dict)
    workspace_id: str | None = None
    environment: Environment = Environment.test
    permission_level: PermissionLevel = PermissionLevel.read
    limited_write_patterns: list[str] = Field(default_factory=list)
    password: SecretStr | None = None


class DbProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    host: str | None = Field(default=None, max_length=255, pattern=HOSTNAME_PATTERN)
    port: int | None = Field(default=None, ge=1, le=65535)
    database: str | None = None
    username: str | None = Field(default=None, max_length=120)
    via_host_id: str | None = None
    options: dict[str, Any] | None = None
    environment: Environment | None = None
    permission_level: PermissionLevel | None = None
    limited_write_patterns: list[str] | None = None
    password: SecretStr | None = None


class HostTestResult(BaseModel):
    ok: bool
    message: str  # Turkish
    latency_ms: int | None = None
    server_version: str | None = None
    uname: str | None = None
    error_code: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)


class TrustRequest(BaseModel):
    fingerprint: str = Field(min_length=8, max_length=200)  # what the user confirmed, e.g. "SHA256:..."
    replace: bool = False  # required when the host already has a different trusted key


class TrustResult(BaseModel):
    host_id: str
    hostname: str
    port: int
    fingerprint: str
    key_type: str
    known_hosts_path: str
    already_trusted: bool = False


class RemoteAgentInfo(BaseModel):
    provider: Provider
    installed: bool
    path: str | None = None
    version: str | None = None
    message: str | None = None  # Turkish


class ExecRequest(BaseModel):
    command: str = Field(min_length=1, max_length=20_000)
    reason: str | None = Field(default=None, max_length=2000)
    timeout: float = Field(default=300, gt=0, le=3600)


class QueryRequest(BaseModel):
    query: str = Field(min_length=1, max_length=200_000)
    reason: str | None = Field(default=None, max_length=2000)
    max_rows: int = Field(default=500, ge=1, le=5000)


class ClassifyRequest(BaseModel):
    language: Literal["shell", "sql", "redis", "mongodb"] = "shell"
    text: str = Field(max_length=200_000)
    dialect: Literal["postgres", "mysql", "sqlite", "mssql"] = "postgres"


class SegmentOut(BaseModel):
    text: str
    klass: CommandClass
    reasons: list[str]


class ClassifyResponse(BaseModel):
    klass: CommandClass
    reasons: list[str]
    parsed: bool
    segments: list[SegmentOut]


class SshConfigEntryOut(BaseModel):
    alias: str
    hostname: str
    user: str | None = None
    port: int = 22
    identity_file: str | None = None
    proxy_jump: str | None = None
    exists: bool = False  # a host with this name already exists


class SshImportRequest(BaseModel):
    path: str | None = None  # default ~/.ssh/config
    aliases: list[str] | None = None  # None = every concrete Host entry
    workspace_id: str | None = None
    environment: Environment = Environment.test
    permission_level: PermissionLevel = PermissionLevel.read


class SkippedImport(BaseModel):
    alias: str
    reason: str


class SshImportResult(BaseModel):
    created: list[HostRecord] = Field(default_factory=list)
    skipped: list[SkippedImport] = Field(default_factory=list)


class DbTestResult(BaseModel):
    ok: bool
    message: str
    latency_ms: int | None = None
    server_version: str | None = None


class AuditEntry(BaseModel):
    """One immutable audit record, flattened from a ``remote.command`` / ``db.query`` event."""

    event_id: int
    ts: datetime
    type: str
    severity: str
    actor: str
    workspace_id: str | None = None
    task_id: str | None = None
    session_id: str | None = None
    target_kind: Literal["host", "db"]
    target_id: str | None = None
    target_name: str | None = None
    environment: str | None = None
    command: str = ""
    klass: str | None = None
    reasons: list[str] = Field(default_factory=list)
    decision: str | None = None
    denied: bool = False
    denial_reason: str | None = None
    approval_id: str | None = None
    approved_by: str | None = None
    exit_code: int | None = None
    row_count: int | None = None
    duration_ms: int | None = None
    output_preview: str | None = None
    source: str | None = None
    reason: str | None = None
    error: str | None = None
    hash: str = ""
    prev_hash: str = ""


class AuditPage(BaseModel):
    entries: list[AuditEntry]
    has_more: bool
    next_before_id: int | None = None
