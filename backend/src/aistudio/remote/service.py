"""``RemoteService`` implementation: classify -> boundaries -> policy -> approval -> run -> audit.

Every command and query, including denied and rejected ones, produces exactly one immutable
``remote.command`` / ``db.query`` event in the hash-chained event log.
"""

from __future__ import annotations

import asyncio
import contextlib
import getpass
import hashlib
import hmac
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import timedelta
from pathlib import Path
from typing import Any, Protocol

from pydantic import ValidationError

from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalRequest, ApprovalService, ApprovalStatus
from aistudio.contracts.common import Environment, Provider
from aistudio.contracts.remote import DbQueryResult, Host, RemoteExecResult
from aistudio.contracts.transport import Transport
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, NotFound, StudioError, Unavailable, ValidationFailed
from aistudio.core.events import ET, Severity
from aistudio.core.text import truncate
from aistudio.remote.boundaries import BoundaryResolver, ServicesBoundaryResolver
from aistudio.remote.classify import (
    SQL_DIALECTS,
    ClassifiedCommand,
    classify_query,
    classify_shell,
    parse_mongo,
    split_redis,
    split_sql,
)
from aistudio.remote.dbexec import DbDriver, DbTarget, PreparedQuery, default_drivers
from aistudio.remote.knownhosts import fingerprint
from aistudio.remote.models import (
    DEFAULT_DB_PORTS,
    DbProfileRecord,
    DbTestResult,
    HostCreate,
    HostRecord,
    HostTestResult,
    HostUpdate,
    RemoteAgentInfo,
    SkippedImport,
    SshConfigEntryOut,
    SshImportRequest,
    SshImportResult,
    TrustResult,
)
from aistudio.remote.policy import PolicyDecision, RemoteAccess, actor_kind, agent_session_id, decide, matches_limited
from aistudio.remote.ssh import ShellRun, SSHPool, SSHTransport
from aistudio.remote.sshconfig import parse_jump, parse_ssh_config
from aistudio.remote.store import RemoteStore, pattern_kind_for_db

log = logging.getLogger(__name__)

OUTPUT_LIMIT = 64 * 1024
PREVIEW_CHARS = 2000
MAX_COMMAND_LENGTH = 20_000
MAX_QUERY_LENGTH = 200_000


class ShellRunner(Protocol):
    async def run_shell(self, command: str, *, timeout: float, limit: int = OUTPUT_LIMIT) -> ShellRun: ...


RunnerFactory = Callable[[HostRecord], Awaitable[ShellRunner]]


def _denial_text(approval: Approval) -> str:
    if approval.status == ApprovalStatus.rejected:
        note = f": {approval.decision_note}" if approval.decision_note else ""
        return f"Onay reddedildi{note}."
    if approval.status == ApprovalStatus.expired:
        return "Onay süresi doldu; komut çalıştırılmadı."
    if approval.status == ApprovalStatus.cancelled:
        return "Onay iptal edildi; komut çalıştırılmadı."
    return "Onay alınamadı; komut çalıştırılmadı."


def _local_user() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return "root"


class RemoteServiceImpl:
    def __init__(self, ctx: AppContext, store: RemoteStore, pool: SSHPool) -> None:
        self.ctx = ctx
        self.store = store
        self.pool = pool
        # Injection points (tests, future runners).
        self.boundaries: BoundaryResolver = ServicesBoundaryResolver(ctx.services)
        self.drivers: dict[str, DbDriver] = default_drivers()
        self.runner_factory: RunnerFactory = self._ssh_runner
        self.approval_timeout: float = 1800.0
        self.output_limit: int = OUTPUT_LIMIT
        self.query_timeout: float = 120.0

    async def _ssh_runner(self, host: HostRecord) -> ShellRunner:
        return SSHTransport(self.pool, host.id)

    # ================================================================== contract
    async def get_host(self, host_id: str) -> Host:
        return await self.store.get_host(host_id)

    async def transport(self, host_id: str) -> Transport:
        await self.store.get_host(host_id)
        await self.pool.connection(host_id)  # surface host key / auth problems now
        return SSHTransport(self.pool, host_id)

    async def _agent_access(self, actor: str, session_id: str | None, workspace_id: str | None) -> RemoteAccess | None:
        if actor_kind(actor) != "agent":
            return None
        sid = agent_session_id(actor) or session_id
        return await self.boundaries.remote_access(session_id=sid, workspace_id=workspace_id)

    # ================================================================== approvals
    async def begin_approval(
        self,
        *,
        kind: ApprovalKind,
        title: str,
        summary: str | None,
        payload: dict[str, Any],
        production: bool,
        actor: str,
        workspace_id: str | None,
        task_id: str | None,
        session_id: str | None,
    ) -> Approval:
        """Create a fresh approval. Production approvals are critical and never reused."""
        svc = self.ctx.services.get(ApprovalService)  # type: ignore[type-abstract]
        masker = self.ctx.masker
        req = ApprovalRequest(
            kind=kind,
            title=masker.mask(title),
            summary=masker.mask(summary) if summary else None,
            payload=masker.mask_obj(payload),
            severity=Severity.critical if production else Severity.high,
            production=production,
            workspace_id=workspace_id,
            task_id=task_id,
            session_id=session_id,
            requested_by=actor,
            expires_at=utcnow() + timedelta(seconds=self.approval_timeout),
        )
        task = asyncio.ensure_future(svc.request(req))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # Cancelled while the approval was being created: cancel it as soon as it exists so
            # nothing is left pending that could later be "approved" for a request nobody runs.
            async def cleanup() -> None:
                with contextlib.suppress(Exception):
                    created = await task
                    await svc.cancel(created.id, "İstek iptal edildi.")

            self.ctx.spawn(cleanup(), name="remote:approval-cleanup")
            raise

    async def wait_approval(self, approval: Approval) -> tuple[Approval, str | None]:
        """Block until decided. Returns (final approval, Turkish denial reason or None)."""
        svc = self.ctx.services.get(ApprovalService)  # type: ignore[type-abstract]
        try:
            decided = await svc.wait(approval.id, timeout=self.approval_timeout + 5)
        except TimeoutError:
            cancelled = await self._cancel_quietly(approval.id, "Onay zaman aşımına uğradı.")
            return cancelled or approval, "Onay zaman aşımına uğradı; komut çalıştırılmadı."
        except asyncio.CancelledError:
            await asyncio.shield(self._cancel_quietly(approval.id, "İstek iptal edildi."))
            raise
        if decided.status == ApprovalStatus.approved:
            return decided, None
        return decided, _denial_text(decided)

    async def _cancel_quietly(self, approval_id: str, reason: str) -> Approval | None:
        svc = self.ctx.services.get(ApprovalService)  # type: ignore[type-abstract]
        try:
            return await svc.cancel(approval_id, reason)
        except StudioError:
            with contextlib.suppress(StudioError):
                return await svc.get(approval_id)
        return None

    async def _approve(self, **kwargs: Any) -> tuple[Approval, str | None]:
        approval = await self.begin_approval(**kwargs)
        return await self.wait_approval(approval)

    # ================================================================== audit
    @staticmethod
    def _severity(production: bool, klass: str, denied: bool) -> Severity:
        if denied:
            return Severity.high if production else Severity.normal
        if klass == "read":
            return Severity.info
        return Severity.high if production else Severity.normal

    @staticmethod
    def _approval_fields(approval: Approval | None) -> dict[str, Any]:
        if approval is None:
            return {"approval_id": None, "approved_by": None, "approval_status": None, "approval_channel": None}
        approved = approval.status == ApprovalStatus.approved
        return {
            "approval_id": approval.id,
            "approved_by": approval.decided_by if approved else None,
            "approval_status": approval.status.value,
            "approval_channel": approval.channel,
        }

    async def audit_command(
        self,
        *,
        host: HostRecord,
        command: str,
        cls: ClassifiedCommand,
        actor: str,
        outcome: str,
        decision: PolicyDecision | None = None,
        approval: Approval | None = None,
        workspace_id: str | None = None,
        task_id: str | None = None,
        session_id: str | None = None,
        reason: str | None = None,
        source: str = "api",
        run: ShellRun | None = None,
        output: str = "",
        denial_reason: str | None = None,
        error: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        denied = outcome in ("denied", "rejected")
        production = host.environment == Environment.production
        payload: dict[str, Any] = {
            "host_id": host.id,
            "host_name": host.name,
            "hostname": host.hostname,
            "environment": host.environment.value,
            "permission_level": host.permission_level.value,
            "command": truncate(command, 8000),
            "classification": cls.to_contract().model_dump(),
            "outcome": outcome,
            "decision": decision.action if decision else None,
            "policy_reason": decision.reason if decision else None,
            **self._approval_fields(approval),
            "exit_code": run.exit_code if run else None,
            "duration_ms": run.duration_ms if run else None,
            "output_preview": truncate(self.ctx.masker.mask(output), PREVIEW_CHARS) if output else "",
            "output_truncated": run.truncated if run else False,
            "timed_out": run.timed_out if run else False,
            "denied": denied,
            "denial_reason": denial_reason,
            "error": error,
            "reason": reason,
            "source": source,
            "actor_kind": actor_kind(actor),
            **(extra or {}),
        }
        await self.ctx.events.append(
            ET.REMOTE_COMMAND,
            payload,
            severity=self._severity(production, cls.klass, denied),
            actor=actor,
            workspace_id=workspace_id or host.workspace_id,
            task_id=task_id,
            session_id=session_id,
        )

    async def _audit_query(
        self,
        *,
        profile: DbProfileRecord,
        query: str,
        cls: ClassifiedCommand,
        actor: str,
        outcome: str,
        decision: PolicyDecision | None = None,
        approval: Approval | None = None,
        workspace_id: str | None = None,
        task_id: str | None = None,
        session_id: str | None = None,
        reason: str | None = None,
        source: str = "api",
        result: DbQueryResult | None = None,
        denial_reason: str | None = None,
        error: str | None = None,
    ) -> None:
        denied = outcome in ("denied", "rejected")
        production = profile.environment == Environment.production
        preview = ""
        if result is not None and result.rows:
            preview = truncate(str([result.columns, *result.rows[:5]]), PREVIEW_CHARS)
        payload: dict[str, Any] = {
            "profile_id": profile.id,
            "profile_name": profile.name,
            "kind": profile.kind,
            "database": profile.database,
            "environment": profile.environment.value,
            "permission_level": profile.permission_level.value,
            "query": truncate(query, 8000),
            "classification": cls.to_contract().model_dump(),
            "outcome": outcome,
            "decision": decision.action if decision else None,
            "policy_reason": decision.reason if decision else None,
            "readonly_session": decision.readonly_session if decision else None,
            **self._approval_fields(approval),
            "row_count": result.row_count if result else None,
            "columns": result.columns[:50] if result else [],
            "truncated": result.truncated if result else False,
            "duration_ms": result.duration_ms if result else None,
            "output_preview": preview,
            "denied": denied,
            "denial_reason": denial_reason,
            "error": error,
            "reason": reason,
            "source": source,
            "actor_kind": actor_kind(actor),
        }
        await self.ctx.events.append(
            ET.DB_QUERY,
            payload,
            severity=self._severity(production, cls.klass, denied),
            actor=actor,
            workspace_id=workspace_id or profile.workspace_id,
            task_id=task_id,
            session_id=session_id,
        )

    # ================================================================== exec
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
        source: str = "api",
    ) -> RemoteExecResult:
        command = command.strip()
        if not command:
            raise ValidationFailed("Komut boş olamaz.")
        if len(command) > MAX_COMMAND_LENGTH:
            raise ValidationFailed("Komut çok uzun.")
        host = await self.store.get_host(host_id)
        cls = classify_shell(command)
        access = await self._agent_access(actor, session_id, workspace_id)
        decision = decide(
            environment=host.environment,
            level=host.permission_level,
            klass=cls.klass,
            agent_access=access,
            limited_match=matches_limited(cls, host.limited_write_patterns, "shell"),
        )
        timeout = max(1.0, min(float(timeout), 3600.0))
        common: dict[str, Any] = {
            "host": host,
            "command": command,
            "cls": cls,
            "actor": actor,
            "decision": decision,
            "workspace_id": workspace_id,
            "task_id": task_id,
            "session_id": session_id,
            "reason": reason,
            "source": source,
        }
        classification = cls.to_contract()

        def denied_result(why: str) -> RemoteExecResult:
            return RemoteExecResult(
                host_id=host.id,
                command=command,
                classification=classification,
                approved_by=None,
                denied=True,
                denial_reason=why,
            )

        if decision.action == "deny":
            await self.audit_command(**common, outcome="denied", denial_reason=decision.reason)
            return denied_result(decision.reason)
        approval: Approval | None = None
        if decision.action == "approve":
            production = host.environment == Environment.production
            first_line = command.splitlines()[0][:200]
            approval, denial = await self._approve(
                kind=ApprovalKind.remote_command,
                title=f"Production komutu: {host.name}" if production else f"Uzak komut onayı: {host.name}",
                summary=first_line + (f" — {reason}" if reason else ""),
                payload={
                    "host_id": host.id,
                    "host_name": host.name,
                    "hostname": host.hostname,
                    "port": host.port,
                    "environment": host.environment.value,
                    "permission_level": host.permission_level.value,
                    "command": command,
                    "classification": classification.model_dump(),
                    "policy_reason": decision.reason,
                    "actor": actor,
                    "reason": reason,
                    "source": source,
                },
                production=production,
                actor=actor,
                workspace_id=workspace_id or host.workspace_id,
                task_id=task_id,
                session_id=session_id,
            )
            if denial is not None:
                await self.audit_command(**common, outcome="rejected", approval=approval, denial_reason=denial)
                return denied_result(denial)
        try:
            runner = await self.runner_factory(host)
            run = await runner.run_shell(command, timeout=timeout, limit=self.output_limit)
        except StudioError as e:
            await self.audit_command(**common, outcome="failed", approval=approval, error=e.message)
            raise
        except (OSError, TimeoutError) as e:
            await self.audit_command(**common, outcome="failed", approval=approval, error=str(e))
            raise Unavailable(f"Komut çalıştırılamadı: {e}") from None
        output = self.ctx.masker.mask(run.output)
        if run.timed_out:
            output += f"\n[zaman aşımı: {timeout:g} sn sonra durduruldu]"
        await self.audit_command(**common, outcome="executed", approval=approval, run=run, output=output)
        return RemoteExecResult(
            host_id=host.id,
            command=command,
            classification=classification,
            approved_by=approval.decided_by if approval else None,
            exit_code=run.exit_code,
            output=output,
            duration_ms=run.duration_ms,
        )

    # ================================================================== db_query
    def _prepare(self, kind: str, query: str) -> PreparedQuery:
        if kind in SQL_DIALECTS:
            try:
                return PreparedQuery(sql=split_sql(query, kind))
            except Exception:
                return PreparedQuery(sql=[query.strip()])
        if kind == "redis":
            try:
                return PreparedQuery(redis=split_redis(query))
            except ValueError:
                raise ValidationFailed("Redis komutu ayrıştırılamadı (kapanmamış tırnak).") from None
        if kind == "mongodb":
            try:
                return PreparedQuery(mongo=parse_mongo(query))
            except ValueError as e:
                raise ValidationFailed(str(e)) from None
        raise ValidationFailed(f"Desteklenmeyen veritabanı türü: {kind}")

    @contextlib.asynccontextmanager
    async def db_target(self, profile: DbProfileRecord) -> AsyncIterator[DbTarget]:
        password = await asyncio.to_thread(self.store.db_password, profile.id) if profile.has_password else None
        port = profile.port or DEFAULT_DB_PORTS.get(profile.kind)
        if profile.via_host_id and profile.kind != "sqlite":
            conn = await self.pool.connection(profile.via_host_id)
            try:
                listener = await conn.forward_local_port("127.0.0.1", 0, profile.host or "127.0.0.1", port or 0)
            except Exception as e:
                raise Unavailable(f"SSH tüneli açılamadı: {e}") from None
            try:
                yield DbTarget(
                    kind=profile.kind,
                    host="127.0.0.1",
                    port=listener.get_port(),
                    database=profile.database,
                    username=profile.username,
                    password=password,
                    options=profile.options,
                    tunneled=True,
                )
            finally:
                listener.close()
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(listener.wait_closed(), 5)
        else:
            yield DbTarget(
                kind=profile.kind,
                host=profile.host,
                port=port,
                database=profile.database,
                username=profile.username,
                password=password,
                options=profile.options,
            )

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
        source: str = "api",
    ) -> DbQueryResult:
        if not query.strip():
            raise ValidationFailed("Sorgu boş olamaz.")
        if len(query) > MAX_QUERY_LENGTH:
            raise ValidationFailed("Sorgu çok uzun.")
        profile = await self.store.get_db_profile(profile_id)
        max_rows = max(1, min(int(max_rows), 5000))
        cls = classify_query(profile.kind, query)
        classification = cls.to_contract()
        access = await self._agent_access(actor, session_id, workspace_id)
        decision = decide(
            environment=profile.environment,
            level=profile.permission_level,
            klass=cls.klass,
            agent_access=access,
            limited_match=matches_limited(cls, profile.limited_write_patterns, pattern_kind_for_db(profile.kind)),
        )
        common: dict[str, Any] = {
            "profile": profile,
            "query": query,
            "cls": cls,
            "actor": actor,
            "decision": decision,
            "workspace_id": workspace_id,
            "task_id": task_id,
            "session_id": session_id,
            "reason": reason,
            "source": source,
        }

        def base(**kw: Any) -> DbQueryResult:
            return DbQueryResult(profile_id=profile.id, query=query, classification=classification, **kw)

        try:
            prepared = self._prepare(profile.kind, query)
        except ValidationFailed as e:
            await self._audit_query(**common, outcome="failed", error=e.message)
            return base(error=e.message)
        if decision.action == "deny":
            await self._audit_query(**common, outcome="denied", denial_reason=decision.reason)
            return base(denied=True, denial_reason=decision.reason)
        approval: Approval | None = None
        if decision.action == "approve":
            production = profile.environment == Environment.production
            approval, denial = await self._approve(
                kind=ApprovalKind.db_write,
                title=(
                    f"Production veritabanı yazması: {profile.name}"
                    if production
                    else f"Veritabanı yazma onayı: {profile.name}"
                ),
                summary=" ".join(query.split())[:200] + (f" — {reason}" if reason else ""),
                payload={
                    "profile_id": profile.id,
                    "profile_name": profile.name,
                    "kind": profile.kind,
                    "database": profile.database,
                    "environment": profile.environment.value,
                    "permission_level": profile.permission_level.value,
                    "query": query,
                    "classification": classification.model_dump(),
                    "policy_reason": decision.reason,
                    "actor": actor,
                    "reason": reason,
                    "source": source,
                },
                production=production,
                actor=actor,
                workspace_id=workspace_id or profile.workspace_id,
                task_id=task_id,
                session_id=session_id,
            )
            if denial is not None:
                await self._audit_query(**common, outcome="rejected", approval=approval, denial_reason=denial)
                return base(denied=True, denial_reason=denial)
        approved_by = approval.decided_by if approval else None
        started = time.monotonic()
        driver = self.drivers.get(profile.kind)
        if driver is None:
            raise ValidationFailed(f"Desteklenmeyen veritabanı türü: {profile.kind}")
        try:
            async with self.db_target(profile) as target:
                outcome = await driver.execute(
                    target, prepared, readonly=decision.readonly_session, max_rows=max_rows, timeout=self.query_timeout
                )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            message = self.ctx.masker.mask(e.message if isinstance(e, StudioError) else f"{type(e).__name__}: {e}")
            result = base(approved_by=approved_by, error=message, duration_ms=int((time.monotonic() - started) * 1000))
            await self._audit_query(**common, outcome="failed", approval=approval, result=result, error=message)
            return result
        result = base(
            approved_by=approved_by,
            columns=[self.ctx.masker.mask(c) for c in outcome.columns],
            rows=self.ctx.masker.mask_obj(outcome.rows),
            row_count=outcome.row_count,
            truncated=outcome.truncated,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
        await self._audit_query(**common, outcome="executed", approval=approval, result=result)
        return result

    # ================================================================== hosts: test / trust / agents
    async def test_host(self, host_id: str) -> HostTestResult:
        host = await self.store.get_host(host_id)
        started = time.monotonic()
        try:
            await self.pool.drop(host_id)
            conn = await self.pool.connection(host_id)
            result = await SSHTransport(self.pool, host_id).run(["uname", "-a"], timeout=20)
        except StudioError as e:
            return HostTestResult(ok=False, message=e.message, error_code=e.code, details=e.details)
        except (OSError, TimeoutError) as e:
            return HostTestResult(ok=False, message=f"Bağlantı testi başarısız: {e}", error_code="unavailable")
        latency = int((time.monotonic() - started) * 1000)
        await self.ctx.events.append(
            "remote.host.tested",
            {"host_id": host.id, "name": host.name, "ok": True, "latency_ms": latency},
            actor="user",
            workspace_id=host.workspace_id,
        )
        return HostTestResult(
            ok=True,
            message="Bağlantı başarılı.",
            latency_ms=latency,
            server_version=str(conn.get_extra_info("server_version") or "") or None,
            uname=result.stdout.strip()[:300] or None,
        )

    async def trust_host(
        self, host_id: str, confirmed_fingerprint: str, *, replace: bool, actor: str = "user"
    ) -> TrustResult:
        host, key = await self.pool.probe_host_key(host_id)
        known_path = str(self.pool.known_hosts.app_file)
        wanted = confirmed_fingerprint.strip()
        if key is None:
            return TrustResult(
                host_id=host.id,
                hostname=host.hostname,
                port=host.port,
                fingerprint=wanted,
                key_type="",
                known_hosts_path=known_path,
                already_trusted=True,
            )
        actual = fingerprint(key)
        candidates = {actual, actual.removeprefix("SHA256:")}
        if not any(hmac.compare_digest(wanted, c) for c in candidates):
            raise ValidationFailed("Parmak izi eşleşmiyor; host anahtarı eklenmedi.", details={"fingerprint": actual})
        trusted, _ = self.pool.known_hosts.trusted(host.hostname, host.port)
        if trusted and not replace:
            raise Conflict(
                "Bu host için farklı bir anahtar zaten güvenilir listede. Anahtarın değiştiğinden eminseniz "
                "değiştirmeyi açıkça onaylayın.",
                details={"fingerprint": actual, "key_type": key.get_algorithm()},
            )
        await asyncio.to_thread(self.pool.known_hosts.add, host.hostname, host.port, key, replace=bool(trusted))
        await self.pool.drop(host_id)
        await self.ctx.events.append(
            "remote.host.trusted",
            {
                "host_id": host.id,
                "name": host.name,
                "hostname": host.hostname,
                "port": host.port,
                "fingerprint": actual,
                # Hex form of the same SHA-256: survives secret masking (base64 looks high-entropy).
                "fingerprint_sha256_hex": hashlib.sha256(key.public_data).hexdigest(),
                "key_type": key.get_algorithm(),
                "replaced": bool(trusted),
            },
            severity=Severity.high,
            actor=actor,
            workspace_id=host.workspace_id,
        )
        return TrustResult(
            host_id=host.id,
            hostname=host.hostname,
            port=host.port,
            fingerprint=actual,
            key_type=key.get_algorithm(),
            known_hosts_path=known_path,
        )

    async def detect_agents(self, host_id: str) -> list[RemoteAgentInfo]:
        host = await self.store.get_host(host_id)
        transport = SSHTransport(self.pool, host.id)
        await self.pool.connection(host.id)
        infos: list[RemoteAgentInfo] = []
        providers: tuple[tuple[Provider, str], ...] = (("claude", "claude"), ("codex", "codex"))
        for provider, binary in providers:
            try:
                path = await transport.which(binary)
            except (StudioError, OSError, TimeoutError) as e:
                message = e.message if isinstance(e, StudioError) else str(e)
                infos.append(
                    RemoteAgentInfo(provider=provider, installed=False, message=f"Kontrol edilemedi: {message}")
                )
                continue
            if not path:
                infos.append(
                    RemoteAgentInfo(provider=provider, installed=False, message=f"`{binary}` bu hostta bulunamadı.")
                )
                continue
            version: str | None = None
            with contextlib.suppress(StudioError, OSError, TimeoutError):
                res = await transport.run([path, "--version"], timeout=20)
                text = (res.stdout or res.stderr).strip()
                version = text.splitlines()[0][:200] if text else None
            infos.append(RemoteAgentInfo(provider=provider, installed=True, path=path, version=version))
        return infos

    # ================================================================== db: test
    async def test_db(self, profile_id: str) -> DbTestResult:
        profile = await self.store.get_db_profile(profile_id)
        driver = self.drivers.get(profile.kind)
        if driver is None:
            raise ValidationFailed(f"Desteklenmeyen veritabanı türü: {profile.kind}")
        started = time.monotonic()
        try:
            async with self.db_target(profile) as target:
                version = await driver.ping(target, timeout=20)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            text = e.message if isinstance(e, StudioError) else f"{type(e).__name__}: {e}"
            return DbTestResult(ok=False, message=self.ctx.masker.mask(f"Bağlantı başarısız: {text}"))
        return DbTestResult(
            ok=True,
            message="Bağlantı başarılı.",
            latency_ms=int((time.monotonic() - started) * 1000),
            server_version=self.ctx.masker.mask(version)[:300],
        )

    # ================================================================== ~/.ssh/config import
    @staticmethod
    def _ssh_config_path(path: str | None) -> Path:
        return Path(path).expanduser() if path else Path.home() / ".ssh" / "config"

    async def _read_ssh_config(self, path: str | None) -> list[Any]:
        p = self._ssh_config_path(path)
        if not p.is_file():
            raise NotFound(f"SSH yapılandırma dosyası bulunamadı: {p}")
        text = await asyncio.to_thread(p.read_text, "utf-8", "replace")
        return parse_ssh_config(text, base_dir=p.parent)

    async def list_ssh_config(self, path: str | None, workspace_id: str | None) -> list[SshConfigEntryOut]:
        entries = await self._read_ssh_config(path)
        names = {h.name.casefold() for h in await self.store.list_hosts(workspace_id)}
        return [
            SshConfigEntryOut(
                alias=e.alias,
                hostname=e.hostname,
                user=e.user,
                port=e.port,
                identity_file=e.identity_file,
                proxy_jump=e.proxy_jump,
                exists=e.alias.casefold() in names,
            )
            for e in entries
        ]

    async def import_ssh_config(self, body: SshImportRequest, *, actor: str = "user") -> SshImportResult:
        entries = await self._read_ssh_config(body.path)
        selected = [e for e in entries if body.aliases is None or e.alias in body.aliases]
        known = {h.name.casefold(): h for h in await self.store.list_hosts(body.workspace_id)}
        result = SshImportResult()
        created: dict[str, HostRecord] = {}
        for e in selected:
            if e.alias.casefold() in known:
                result.skipped.append(SkippedImport(alias=e.alias, reason="Bu adla bir host zaten var."))
                continue
            try:
                host = await self.store.create_host(
                    HostCreate(
                        name=e.alias,
                        hostname=e.hostname,
                        port=e.port,
                        username=e.user or _local_user(),
                        workspace_id=body.workspace_id,
                        auth="key" if e.identity_file else "agent",
                        key_path=e.identity_file,
                        environment=body.environment,
                        permission_level=body.permission_level,
                    ),
                    actor=actor,
                )
            except (StudioError, ValidationError) as ex:
                reason = ex.message if isinstance(ex, StudioError) else "Geçersiz host bilgisi."
                result.skipped.append(SkippedImport(alias=e.alias, reason=reason))
                continue
            created[e.alias] = host
            known[e.alias.casefold()] = host
        for e in selected:
            if not e.proxy_jump or e.alias not in created:
                continue
            jump = await self._resolve_jump(e.proxy_jump, known, body, actor)
            if jump is None:
                result.skipped.append(
                    SkippedImport(alias=e.alias, reason=f"Atlama hostu çözümlenemedi: {e.proxy_jump}")
                )
                continue
            try:
                created[e.alias] = await self.store.update_host(
                    created[e.alias].id, HostUpdate(jump_host_id=jump.id), actor=actor
                )
            except StudioError as ex:
                result.skipped.append(SkippedImport(alias=e.alias, reason=ex.message))
        result.created = [await self.store.get_host(h.id) for h in created.values()]
        return result

    async def _resolve_jump(
        self, spec: str, known: dict[str, HostRecord], body: SshImportRequest, actor: str
    ) -> HostRecord | None:
        if spec.casefold() in known:
            return known[spec.casefold()]
        user, hostname, port = parse_jump(spec)
        for h in known.values():
            if h.hostname == hostname and h.port == port and (user is None or h.username == user):
                return h
        try:
            host = await self.store.create_host(
                HostCreate(
                    name=hostname if port == 22 else f"{hostname}:{port}",
                    hostname=hostname,
                    port=port,
                    username=user or _local_user(),
                    workspace_id=body.workspace_id,
                    auth="agent",
                    environment=body.environment,
                    permission_level=body.permission_level,
                ),
                actor=actor,
            )
        except (StudioError, ValidationError):
            return None
        known[host.name.casefold()] = host
        return host
