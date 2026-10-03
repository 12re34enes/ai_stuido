"""Remote hosts and databases (spec §12). Implemented in ``aistudio.remote``."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.transport import Transport


class Host(BaseModel):
    id: str
    workspace_id: str | None = None
    name: str
    hostname: str
    port: int = 22
    username: str
    jump_host_id: str | None = None
    auth: Literal["key", "password", "agent"] = "key"
    key_path: str | None = None  # private key path on this Mac (passphrase in Keychain)
    environment: Environment = Environment.test
    permission_level: PermissionLevel = PermissionLevel.read
    created_at: datetime


DbKind = Literal["postgres", "mysql", "sqlite", "mssql", "mongodb", "redis"]


class DbProfile(BaseModel):
    id: str
    workspace_id: str | None = None
    name: str
    kind: DbKind
    host: str | None = None
    port: int | None = None
    database: str | None = None
    username: str | None = None
    via_host_id: str | None = None  # SSH tunnel through this host
    options: dict[str, Any] = Field(default_factory=dict)
    environment: Environment = Environment.test
    permission_level: PermissionLevel = PermissionLevel.read
    created_at: datetime


CommandClass = Literal["read", "write", "unknown"]


class Classification(BaseModel):
    klass: CommandClass  # unknown is treated as write
    reasons: list[str] = Field(default_factory=list)  # Turkish explanations


class RemoteExecResult(BaseModel):
    host_id: str
    command: str
    classification: Classification
    approved_by: str | None = None
    exit_code: int | None = None
    output: str = ""  # masked, truncated
    duration_ms: int | None = None
    denied: bool = False
    denial_reason: str | None = None


class DbQueryResult(BaseModel):
    profile_id: str
    query: str
    classification: Classification
    approved_by: str | None = None
    columns: list[str] = Field(default_factory=list)
    rows: list[list[Any]] = Field(default_factory=list)
    row_count: int | None = None
    truncated: bool = False
    duration_ms: int | None = None
    denied: bool = False
    denial_reason: str | None = None
    error: str | None = None


class RemoteService(Protocol):
    async def get_host(self, host_id: str) -> Host: ...
    async def transport(self, host_id: str) -> Transport:
        """SSH transport for adapters/gitops (connection pooled, known_hosts enforced)."""
        ...

    async def exec(
        self,
        host_id: str,
        command: str,
        *,
        actor: str,
        workspace_id: str | None = None,
        session_id: str | None = None,
        task_id: str | None = None,
        reason: str | None = None,
        timeout: float = 300,
    ) -> RemoteExecResult:
        """Classify -> enforce permission level -> approval if needed -> run -> audit event."""
        ...

    async def db_query(
        self,
        profile_id: str,
        query: str,
        *,
        actor: str,
        workspace_id: str | None = None,
        session_id: str | None = None,
        task_id: str | None = None,
        reason: str | None = None,
        max_rows: int = 500,
    ) -> DbQueryResult: ...
