"""``/api/remote`` routes."""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Response, WebSocket

from aistudio.contracts.remote import DbQueryResult, RemoteExecResult
from aistudio.remote.audit import AuditFilter, AuditKind, export_audit, query_audit
from aistudio.remote.classify import ClassifiedCommand, classify_mongo, classify_redis, classify_shell, classify_sql
from aistudio.remote.models import (
    AuditPage,
    ClassifyRequest,
    ClassifyResponse,
    DbProfileCreate,
    DbProfileRecord,
    DbProfileUpdate,
    DbTestResult,
    ExecRequest,
    HostCreate,
    HostRecord,
    HostTestResult,
    HostUpdate,
    QueryRequest,
    RemoteAgentInfo,
    SegmentOut,
    SshConfigEntryOut,
    SshImportRequest,
    SshImportResult,
    TrustRequest,
    TrustResult,
)
from aistudio.remote.service import RemoteServiceImpl
from aistudio.remote.terminal import terminal_session


def _classified(c: ClassifiedCommand) -> ClassifyResponse:
    return ClassifyResponse(
        klass=c.klass,
        reasons=list(c.reasons),
        parsed=c.parsed,
        segments=[SegmentOut(text=s.text, klass=s.klass, reasons=list(s.reasons)) for s in c.segments],
    )


def build_router(get_svc: Callable[[], RemoteServiceImpl]) -> APIRouter:
    r = APIRouter(prefix="/remote", tags=["remote"])

    # ------------------------------------------------------------------ hosts
    @r.get("/hosts", response_model=list[HostRecord])
    async def list_hosts(workspace_id: str | None = None) -> list[HostRecord]:
        return await get_svc().store.list_hosts(workspace_id)

    @r.post("/hosts", response_model=HostRecord, status_code=201)
    async def create_host(body: HostCreate) -> HostRecord:
        return await get_svc().store.create_host(body)

    @r.get("/ssh-config", response_model=list[SshConfigEntryOut])
    async def preview_ssh_config(path: str | None = None, workspace_id: str | None = None) -> list[SshConfigEntryOut]:
        return await get_svc().list_ssh_config(path, workspace_id)

    @r.post("/hosts/import-ssh-config", response_model=SshImportResult)
    async def import_ssh_config(body: SshImportRequest) -> SshImportResult:
        return await get_svc().import_ssh_config(body)

    @r.get("/hosts/{host_id}", response_model=HostRecord)
    async def get_host(host_id: str) -> HostRecord:
        return await get_svc().store.get_host(host_id)

    @r.patch("/hosts/{host_id}", response_model=HostRecord)
    async def update_host(host_id: str, body: HostUpdate) -> HostRecord:
        svc = get_svc()
        host = await svc.store.update_host(host_id, body)
        await svc.pool.drop(host_id)
        return host

    @r.delete("/hosts/{host_id}", status_code=204)
    async def delete_host(host_id: str) -> Response:
        svc = get_svc()
        await svc.store.delete_host(host_id)
        await svc.pool.drop(host_id)
        return Response(status_code=204)

    @r.post("/hosts/{host_id}/test", response_model=HostTestResult)
    async def test_host(host_id: str) -> HostTestResult:
        return await get_svc().test_host(host_id)

    @r.post("/hosts/{host_id}/trust", response_model=TrustResult)
    async def trust_host(host_id: str, body: TrustRequest) -> TrustResult:
        return await get_svc().trust_host(host_id, body.fingerprint, replace=body.replace)

    @r.get("/hosts/{host_id}/agents", response_model=list[RemoteAgentInfo])
    async def host_agents(host_id: str) -> list[RemoteAgentInfo]:
        return await get_svc().detect_agents(host_id)

    @r.post("/hosts/{host_id}/exec", response_model=RemoteExecResult)
    async def exec_command(host_id: str, body: ExecRequest) -> RemoteExecResult:
        return await get_svc().exec(host_id, body.command, actor="user", reason=body.reason, timeout=body.timeout)

    @r.websocket("/hosts/{host_id}/terminal")
    async def terminal(ws: WebSocket, host_id: str) -> None:
        await terminal_session(ws, get_svc(), host_id)

    # ------------------------------------------------------------------ databases
    @r.get("/db-profiles", response_model=list[DbProfileRecord])
    async def list_db_profiles(workspace_id: str | None = None) -> list[DbProfileRecord]:
        return await get_svc().store.list_db_profiles(workspace_id)

    @r.post("/db-profiles", response_model=DbProfileRecord, status_code=201)
    async def create_db_profile(body: DbProfileCreate) -> DbProfileRecord:
        return await get_svc().store.create_db_profile(body)

    @r.get("/db-profiles/{profile_id}", response_model=DbProfileRecord)
    async def get_db_profile(profile_id: str) -> DbProfileRecord:
        return await get_svc().store.get_db_profile(profile_id)

    @r.patch("/db-profiles/{profile_id}", response_model=DbProfileRecord)
    async def update_db_profile(profile_id: str, body: DbProfileUpdate) -> DbProfileRecord:
        return await get_svc().store.update_db_profile(profile_id, body)

    @r.delete("/db-profiles/{profile_id}", status_code=204)
    async def delete_db_profile(profile_id: str) -> Response:
        await get_svc().store.delete_db_profile(profile_id)
        return Response(status_code=204)

    @r.post("/db-profiles/{profile_id}/test", response_model=DbTestResult)
    async def test_db_profile(profile_id: str) -> DbTestResult:
        return await get_svc().test_db(profile_id)

    @r.post("/db-profiles/{profile_id}/query", response_model=DbQueryResult)
    async def run_query(profile_id: str, body: QueryRequest) -> DbQueryResult:
        return await get_svc().db_query(
            profile_id, body.query, actor="user", reason=body.reason, max_rows=body.max_rows
        )

    # ------------------------------------------------------------------ classification preview
    @r.post("/classify", response_model=ClassifyResponse)
    async def classify(body: ClassifyRequest) -> ClassifyResponse:
        if body.language == "shell":
            return _classified(classify_shell(body.text))
        if body.language == "sql":
            return _classified(classify_sql(body.text, body.dialect))
        if body.language == "redis":
            return _classified(classify_redis(body.text))
        return _classified(classify_mongo(body.text))

    # ------------------------------------------------------------------ audit
    def _filter(
        kind: AuditKind,
        target_id: str | None,
        environment: str | None,
        actor: str | None,
        klass: str | None,
        denied: bool | None,
        workspace_id: str | None,
        since: datetime | None,
        until: datetime | None,
        q: str | None,
    ) -> AuditFilter:
        return AuditFilter(
            kind=kind,
            target_id=target_id,
            environment=environment,
            actor=actor,
            klass=klass,
            denied=denied,
            workspace_id=workspace_id,
            since=since,
            until=until,
            text=q,
        )

    @r.get("/audit", response_model=AuditPage)
    async def audit(
        kind: AuditKind = "all",
        target_id: str | None = None,
        environment: str | None = None,
        actor: str | None = None,
        klass: str | None = None,
        denied: bool | None = None,
        workspace_id: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        q: str | None = None,
        before_id: int | None = None,
        limit: int = 200,
    ) -> AuditPage:
        flt = _filter(kind, target_id, environment, actor, klass, denied, workspace_id, since, until, q)
        return await query_audit(get_svc().ctx.events, flt, before_id=before_id, limit=limit)

    @r.get("/audit/export")
    async def audit_export(
        format: Literal["csv", "json"] = "csv",
        kind: AuditKind = "all",
        target_id: str | None = None,
        environment: str | None = None,
        actor: str | None = None,
        klass: str | None = None,
        denied: bool | None = None,
        workspace_id: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        q: str | None = None,
    ) -> Response:
        svc = get_svc()
        flt = _filter(kind, target_id, environment, actor, klass, denied, workspace_id, since, until, q)
        body = await export_audit(svc.ctx.events, flt, format)
        await svc.ctx.events.append(
            "remote.audit.exported", {"format": format, "kind": kind, "bytes": len(body)}, actor="user"
        )
        media = "text/csv; charset=utf-8" if format == "csv" else "application/json"
        filename = f"aistudio-remote-audit.{format}"
        return Response(
            content=body, media_type=media, headers={"content-disposition": f'attachment; filename="{filename}"'}
        )

    return r
