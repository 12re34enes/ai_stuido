"""``DeployService`` (spec §14).

Kinds: ``ci`` (GitHostingService pipeline, polled until done), ``ssh`` (script on one or more
hosts, sequential or rolling, through the remote transport), ``command`` (local subprocess).

Safety: production deploys and rollbacks ALWAYS wait for a locked, critical approval first
(any SSH target or health-check host on production makes the deploy production). Deploys
requested by agents always need approval. SSH deploys follow the remote.exec permission
levels: unless every target host is non-production with ``full`` permission, the deploy
approval is required, and it is the approval recorded on each host's ``remote.command`` event
(the script is not approved twice).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import shlex
import signal
import time
from collections.abc import Mapping
from datetime import timedelta
from typing import Any

import httpx
import sqlalchemy as sa
from pydantic import BaseModel, ValidationError

from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalRequest, ApprovalService, ApprovalStatus
from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.deploy import DeployProfile, DeployResult
from aistudio.contracts.git_hosting import GitHostingService
from aistudio.contracts.remote import Host, RemoteService
from aistudio.contracts.transport import CompletedProcess
from aistudio.contracts.workspaces import WorkspaceService
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, NotFound, StudioError, ValidationFailed
from aistudio.core.events import ET, Severity
from aistudio.core.ids import new_id
from aistudio.core.text import truncate
from aistudio.deploy.models import (
    CONFIG_MODELS,
    FINAL_STATUSES,
    CiConfig,
    CommandConfig,
    DeployProfileCreate,
    DeployProfileUpdate,
    DeployRun,
    HealthCheck,
    SshConfig,
)
from aistudio.deploy.tables import deploy_profiles as profiles_t
from aistudio.deploy.tables import deploy_runs as runs_t

log = logging.getLogger(__name__)

# A flow's deploy-gate approval may stand in for the service's own approval this long.
PREAPPROVAL_MAX_AGE = timedelta(minutes=60)

MAX_LOG_CHARS = 256 * 1024


class _Failed(Exception):
    """A deploy step failed with a Turkish, user-facing message."""


def _kill_group(pid: int) -> None:
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pid, signal.SIGKILL)


async def run_local(
    argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None, timeout: float
) -> CompletedProcess:
    """Local subprocess in its own process group: a timeout or cancellation kills the whole tree
    (children of ``sh -c`` must not outlive a deploy step). stderr is merged into stdout."""
    started = time.monotonic()
    process = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    try:
        out, _ = await asyncio.wait_for(process.communicate(), timeout)
    except BaseException:
        _kill_group(process.pid)
        with contextlib.suppress(Exception):
            await asyncio.wait_for(process.wait(), 5)
        raise
    return CompletedProcess(
        argv=argv,
        returncode=process.returncode if process.returncode is not None else -1,
        stdout=out.decode(errors="replace"),
        stderr="",
        duration_ms=int((time.monotonic() - started) * 1000),
    )


def _validate(model: type[BaseModel], data: Mapping[str, Any] | None, what: str) -> BaseModel:
    try:
        return model.model_validate(dict(data or {}))
    except ValidationError as e:
        first = e.errors()[0]
        loc = ".".join(str(x) for x in first.get("loc", ())) or what
        raise ValidationFailed(f"Geçersiz {what}: {loc} — {first.get('msg', '')}") from None


def _profile_from_row(row: Mapping[Any, Any]) -> DeployProfile:
    return DeployProfile(
        id=row["id"],
        workspace_id=row["workspace_id"],
        name=row["name"],
        kind=row["kind"],
        environment=Environment(row["environment"]),
        config=dict(row["config"] or {}),
        health_check=dict(row["health_check"]) if row["health_check"] else None,
        rollback=dict(row["rollback"]) if row["rollback"] else None,
        created_at=row["created_at"],
    )


def _run_from_row(row: Mapping[Any, Any]) -> DeployRun:
    return DeployRun(**{k: row[k] for k in DeployRun.model_fields})


class _Execution:
    """Mutable state of one running deploy (log buffer, approval)."""

    def __init__(self, svc: DeployServiceImpl, run: DeployRun) -> None:
        self.svc = svc
        self.run = run
        self.lines: list[str] = []
        self.approval: Approval | None = None

    def log(self, line: str) -> None:
        masked = self.svc.ctx.masker.mask(line.rstrip("\n"))
        stamp = utcnow().strftime("%H:%M:%S")
        for part in masked.splitlines() or [""]:
            self.lines.append(f"[{stamp}] {part}")
        self.svc.ctx.events.publish_ephemeral(
            "deploy.log",
            {"deploy_id": self.run.id, "line": masked[:4000]},
            workspace_id=self.run.workspace_id,
            task_id=self.run.task_id,
            run_id=self.run.run_id,
        )

    def text(self) -> str:
        text = "\n".join(self.lines)
        if len(text) > MAX_LOG_CHARS:
            text = "… [günlüğün başı kısaltıldı]\n" + text[-MAX_LOG_CHARS:]
        return text


class DeployServiceImpl:
    def __init__(self, ctx: AppContext) -> None:
        self.ctx = ctx
        self.approval_timeout: float = 3600.0
        self._profile_locks: dict[str, asyncio.Lock] = {}
        self._tasks: dict[str, asyncio.Task[Any]] = {}

    # ================================================================== profiles
    async def _validate_profile(
        self,
        kind: str,
        config: Mapping[str, Any],
        health: Mapping[str, Any] | None,
        rollback: Mapping[str, Any] | None,
    ) -> tuple[dict[str, Any], dict[str, Any] | None, dict[str, Any] | None]:
        model = CONFIG_MODELS[kind]
        cfg = _validate(model, config, "deploy yapılandırması")
        hc = _validate(HealthCheck, health, "sağlık kontrolü") if health else None
        rb = _validate(model, rollback, "geri alma yapılandırması") if rollback else None
        remote = self.ctx.services.maybe(RemoteService)  # type: ignore[type-abstract]
        host_ids: list[str] = []
        for c in (cfg, rb):
            if isinstance(c, SshConfig):
                host_ids.extend(c.host_ids)
        if isinstance(hc, HealthCheck) and hc.host_id:
            host_ids.append(hc.host_id)
        if host_ids:
            if remote is None:
                raise ValidationFailed("Uzak bağlantı modülü hazır değil; SSH hostları doğrulanamadı.")
            for host_id in host_ids:
                try:
                    await remote.get_host(host_id)
                except NotFound:
                    raise ValidationFailed(f"Host bulunamadı: {host_id}") from None
        return (
            cfg.model_dump(),
            hc.model_dump(exclude_none=True) if hc else None,
            rb.model_dump() if rb else None,
        )

    async def list_profiles(self, workspace_id: str | None = None) -> list[DeployProfile]:
        stmt = sa.select(profiles_t).order_by(profiles_t.c.name)
        if workspace_id is not None:
            stmt = stmt.where(profiles_t.c.workspace_id == workspace_id)
        async with self.ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [_profile_from_row(r) for r in rows]

    async def get_profile(self, profile_id: str) -> DeployProfile:
        async with self.ctx.db.connect() as conn:
            row = (await conn.execute(sa.select(profiles_t).where(profiles_t.c.id == profile_id))).mappings().first()
        if row is None:
            raise NotFound("Deploy profili bulunamadı.", details={"profile_id": profile_id})
        return _profile_from_row(row)

    async def resolve_profile(self, ref: str, workspace_id: str | None) -> DeployProfile:
        profiles = await self.list_profiles(workspace_id)
        for p in profiles:
            if p.id == ref:
                return p
        matches = [p for p in profiles if p.name.casefold() == ref.strip().casefold()]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValidationFailed(f"'{ref}' adında birden fazla deploy profili var; id kullanın.")
        available = ", ".join(f"{p.name} ({p.environment.value})" for p in profiles) or "yok"
        raise NotFound(f"Deploy profili bulunamadı: {ref}. Kullanılabilir profiller: {available}")

    async def create_profile(self, body: DeployProfileCreate, *, actor: str = "user") -> DeployProfile:
        for p in await self.list_profiles(body.workspace_id):
            if p.name.casefold() == body.name.casefold():
                raise Conflict(f"'{body.name}' adında bir deploy profili zaten var.")
        config, health, rollback = await self._validate_profile(
            body.kind, body.config, body.health_check, body.rollback
        )
        profile_id = new_id("dep")
        now = utcnow()
        async with self.ctx.db.begin() as conn:
            await conn.execute(
                profiles_t.insert().values(
                    id=profile_id,
                    workspace_id=body.workspace_id,
                    name=body.name,
                    kind=body.kind,
                    environment=body.environment.value,
                    config=config,
                    health_check=health,
                    rollback=rollback,
                    created_at=now,
                    updated_at=now,
                )
            )
        await self.ctx.events.append(
            "deploy.profile.created",
            {"profile_id": profile_id, "name": body.name, "kind": body.kind, "environment": body.environment.value},
            severity=Severity.normal,
            actor=actor,
            workspace_id=body.workspace_id,
        )
        return await self.get_profile(profile_id)

    async def update_profile(self, profile_id: str, body: DeployProfileUpdate, *, actor: str = "user") -> DeployProfile:
        current = await self.get_profile(profile_id)
        given = body.model_fields_set
        name = body.name if "name" in given and body.name else current.name
        environment = body.environment if "environment" in given and body.environment else current.environment
        config = body.config if "config" in given and body.config is not None else current.config
        health = body.health_check if "health_check" in given else current.health_check
        rollback = body.rollback if "rollback" in given else current.rollback
        config_v, health_v, rollback_v = await self._validate_profile(current.kind, config, health, rollback)
        if name.casefold() != current.name.casefold():
            for p in await self.list_profiles(current.workspace_id):
                if p.id != profile_id and p.name.casefold() == name.casefold():
                    raise Conflict(f"'{name}' adında bir deploy profili zaten var.")
        async with self.ctx.db.begin() as conn:
            await conn.execute(
                profiles_t.update()
                .where(profiles_t.c.id == profile_id)
                .values(
                    name=name,
                    environment=environment.value,
                    config=config_v,
                    health_check=health_v,
                    rollback=rollback_v,
                    updated_at=utcnow(),
                )
            )
        changed = sorted(given)
        await self.ctx.events.append(
            "deploy.profile.updated",
            {"profile_id": profile_id, "name": name, "changed": changed, "environment": environment.value},
            severity=Severity.high if "environment" in given else Severity.normal,
            actor=actor,
            workspace_id=current.workspace_id,
        )
        return await self.get_profile(profile_id)

    async def delete_profile(self, profile_id: str, *, actor: str = "user") -> None:
        profile = await self.get_profile(profile_id)
        lock = self._profile_locks.get(profile_id)
        if lock is not None and lock.locked():
            raise Conflict("Bu profil için süren bir deploy var.")
        async with self.ctx.db.begin() as conn:
            await conn.execute(profiles_t.delete().where(profiles_t.c.id == profile_id))
        await self.ctx.events.append(
            "deploy.profile.deleted",
            {"profile_id": profile_id, "name": profile.name},
            actor=actor,
            workspace_id=profile.workspace_id,
        )

    # ================================================================== runs
    async def list_runs(
        self,
        *,
        profile_id: str | None = None,
        workspace_id: str | None = None,
        environment: Environment | None = None,
        limit: int = 100,
    ) -> list[DeployRun]:
        stmt = sa.select(runs_t).order_by(runs_t.c.started_at.desc()).limit(max(1, min(limit, 1000)))
        if profile_id is not None:
            stmt = stmt.where(runs_t.c.profile_id == profile_id)
        if workspace_id is not None:
            stmt = stmt.where(runs_t.c.workspace_id == workspace_id)
        if environment is not None:
            stmt = stmt.where(runs_t.c.environment == environment.value)
        async with self.ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [_run_from_row(r) for r in rows]

    async def get_run(self, deploy_id: str) -> DeployRun:
        async with self.ctx.db.connect() as conn:
            row = (await conn.execute(sa.select(runs_t).where(runs_t.c.id == deploy_id))).mappings().first()
        if row is None:
            raise NotFound("Deploy kaydı bulunamadı.", details={"deploy_id": deploy_id})
        return _run_from_row(row)

    async def _update_run(self, run_id: str, **values: Any) -> DeployRun:
        async with self.ctx.db.begin() as conn:
            await conn.execute(runs_t.update().where(runs_t.c.id == run_id).values(**values))
        return await self.get_run(run_id)

    async def _effective_environment(self, profile: DeployProfile, config: BaseModel) -> Environment:
        """Production if the profile or ANY SSH/health target is production."""
        if profile.environment == Environment.production:
            return Environment.production
        host_ids: list[str] = list(config.host_ids) if isinstance(config, SshConfig) else []
        hc = profile.health_check or {}
        if hc.get("host_id"):
            host_ids.append(str(hc["host_id"]))
        if host_ids:
            remote = self.ctx.services.get(RemoteService)  # type: ignore[type-abstract]
            for host_id in host_ids:
                host = await remote.get_host(host_id)
                if host.environment == Environment.production:
                    return Environment.production
        return profile.environment

    async def _hosts(self, config: SshConfig) -> list[Host]:
        remote = self.ctx.services.get(RemoteService)  # type: ignore[type-abstract]
        return [await remote.get_host(h) for h in config.host_ids]

    async def _create_run(
        self,
        profile: DeployProfile,
        *,
        environment: Environment,
        ref: str | None,
        actor: str,
        task_id: str | None,
        run_id: str | None,
        summary: str | None,
        rollback_of: str | None,
    ) -> DeployRun:
        deploy_id = new_id("dpl")
        async with self.ctx.db.begin() as conn:
            await conn.execute(
                runs_t.insert().values(
                    id=deploy_id,
                    profile_id=profile.id,
                    workspace_id=profile.workspace_id,
                    profile_name=profile.name,
                    kind=profile.kind,
                    environment=environment.value,
                    status="running",
                    ref=ref,
                    summary=summary,
                    actor=actor,
                    task_id=task_id,
                    run_id=run_id,
                    rollback_of=rollback_of,
                    rollback_available=False,
                    log="",
                    started_at=utcnow(),
                )
            )
        return await self.get_run(deploy_id)

    # ================================================================== contract
    async def deploy(
        self,
        profile_id: str,
        *,
        ref: str | None,
        actor: str,
        task_id: str | None = None,
        run_id: str | None = None,
        summary: str | None = None,
        approval_id: str | None = None,
    ) -> DeployResult:
        run, lock, config = await self._prepare(profile_id, ref, actor, task_id, run_id, summary, rollback_of=None)
        final = await self._execute(run, config, lock, preapproval_id=approval_id)
        return self.to_result(final)

    async def rollback(self, deploy_id: str, *, actor: str) -> DeployResult:
        run, lock, config = await self._prepare_rollback(deploy_id, actor)
        final = await self._execute(run, config, lock)
        return self.to_result(final)

    # ------------------------------------------------------------------ background variants (API)
    async def start(
        self,
        profile_id: str,
        *,
        ref: str | None,
        actor: str,
        task_id: str | None = None,
        run_id: str | None = None,
        summary: str | None = None,
    ) -> DeployRun:
        run, lock, config = await self._prepare(profile_id, ref, actor, task_id, run_id, summary, rollback_of=None)
        self._spawn(run, config, lock)
        return run

    async def start_rollback(self, deploy_id: str, *, actor: str) -> DeployRun:
        run, lock, config = await self._prepare_rollback(deploy_id, actor)
        self._spawn(run, config, lock)
        return run

    def _spawn(self, run: DeployRun, config: BaseModel, lock: asyncio.Lock) -> None:
        task = self.ctx.spawn(self._execute(run, config, lock), name=f"deploy:{run.id}")
        self._tasks[run.id] = task
        task.add_done_callback(lambda _t: self._tasks.pop(run.id, None))

    async def wait(self, deploy_id: str, timeout: float | None = None) -> DeployRun:
        task = self._tasks.get(deploy_id)
        if task is not None:
            await asyncio.wait_for(asyncio.shield(task), timeout)
        return await self.get_run(deploy_id)

    async def cancel(self, deploy_id: str, *, actor: str = "user") -> DeployRun:
        run = await self.get_run(deploy_id)
        if run.status in FINAL_STATUSES:
            raise Conflict("Bu deploy zaten sonuçlandı.")
        task = self._tasks.get(deploy_id)
        if task is None:
            # Orphaned (e.g. after a restart): mark it cancelled.
            return await self._update_run(deploy_id, status="cancelled", finished_at=utcnow(), error="İptal edildi.")
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        return await self.get_run(deploy_id)

    async def shutdown(self) -> None:
        """Cancel running deploys so their status is persisted before the database closes."""
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await asyncio.wait_for(task, 5)

    @staticmethod
    def to_result(run: DeployRun) -> DeployResult:
        status = run.status if run.status in FINAL_STATUSES else "failed"
        return DeployResult(
            id=run.id,
            profile_id=run.profile_id,
            environment=run.environment,
            status=status,  # type: ignore[arg-type]
            ref=run.ref,
            log=run.log,
            health_ok=run.health_ok,
            approved_by=run.approved_by,
            started_at=run.started_at,
            finished_at=run.finished_at,
        )

    # ================================================================== preparation
    def _acquire(self, profile_id: str) -> asyncio.Lock:
        lock = self._profile_locks.setdefault(profile_id, asyncio.Lock())
        if lock.locked():
            raise Conflict("Bu profil için zaten süren bir deploy var.")
        return lock

    async def _prepare(
        self,
        profile_id: str,
        ref: str | None,
        actor: str,
        task_id: str | None,
        run_id: str | None,
        summary: str | None,
        *,
        rollback_of: str | None,
    ) -> tuple[DeployRun, asyncio.Lock, BaseModel]:
        profile = await self.get_profile(profile_id)
        config = _validate(CONFIG_MODELS[profile.kind], profile.config, "deploy yapılandırması")
        lock = self._acquire(profile.id)
        await lock.acquire()
        try:
            environment = await self._effective_environment(profile, config)
            run = await self._create_run(
                profile,
                environment=environment,
                ref=ref,
                actor=actor,
                task_id=task_id,
                run_id=run_id,
                summary=summary,
                rollback_of=rollback_of,
            )
        except BaseException:
            lock.release()
            raise
        return run, lock, config

    async def _prepare_rollback(self, deploy_id: str, actor: str) -> tuple[DeployRun, asyncio.Lock, BaseModel]:
        original = await self.get_run(deploy_id)
        if original.status not in FINAL_STATUSES:
            raise Conflict("Süren bir deploy geri alınamaz.")
        profile = await self.get_profile(original.profile_id)
        if not profile.rollback:
            raise ValidationFailed("Bu profil için geri alma tanımlı değil.")
        config = _validate(CONFIG_MODELS[profile.kind], profile.rollback, "geri alma yapılandırması")
        lock = self._acquire(profile.id)
        await lock.acquire()
        try:
            environment = await self._effective_environment(profile, config)
            run = await self._create_run(
                profile,
                environment=environment,
                ref=original.ref,
                actor=actor,
                task_id=original.task_id,
                run_id=original.run_id,
                summary=f"Geri alma: {original.id}",
                rollback_of=original.id,
            )
        except BaseException:
            lock.release()
            raise
        return run, lock, config

    # ================================================================== execution
    async def _needs_approval(self, run: DeployRun, config: BaseModel) -> tuple[bool, str]:
        if run.environment == Environment.production:
            return True, "Production deploy: kilitli onay gerekir."
        if run.actor.startswith("agent:"):
            return True, "Ajan tarafından istenen deploy: onay gerekir."
        if isinstance(config, SshConfig):
            for host in await self._hosts(config):
                if host.permission_level != PermissionLevel.full:
                    return True, f"{host.name} hostunda tam yetki yok: deploy betiği onay gerektirir."
        return False, ""

    def _approval_payload(self, run: DeployRun, profile: DeployProfile, config: BaseModel, why: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "deploy_id": run.id,
            "profile_id": profile.id,
            "profile_name": profile.name,
            "kind": profile.kind,
            "environment": run.environment.value,
            "ref": run.ref,
            "summary": run.summary,
            "actor": run.actor,
            "rollback_of": run.rollback_of,
            "reason": why,
        }
        if isinstance(config, SshConfig):
            payload.update(host_ids=config.host_ids, strategy=config.strategy, script=config.script)
        elif isinstance(config, CommandConfig):
            payload.update(command=config.command, cwd=config.cwd)
        elif isinstance(config, CiConfig):
            payload.update(repo_id=config.repo_id, workflow=config.workflow, variables=config.variables)
        if profile.health_check:
            payload["health_check"] = profile.health_check
        return payload

    async def _request_approval(
        self, ex: _Execution, profile: DeployProfile, config: BaseModel, why: str
    ) -> str | None:
        """Returns a Turkish denial reason, or None when approved."""
        run = ex.run
        production = run.environment == Environment.production
        svc = self.ctx.services.get(ApprovalService)  # type: ignore[type-abstract]
        what = "geri alma" if run.rollback_of else "deploy"
        title = f"Production {what}: {profile.name}" if production else f"{what.capitalize()} onayı: {profile.name}"
        summary = run.summary or (f"ref: {run.ref}" if run.ref else None)
        request_task = asyncio.ensure_future(
            svc.request(
                ApprovalRequest(
                    kind=ApprovalKind.deploy,
                    title=self.ctx.masker.mask(title),
                    summary=self.ctx.masker.mask(summary) if summary else None,
                    payload=self.ctx.masker.mask_obj(self._approval_payload(run, profile, config, why)),
                    severity=Severity.critical if production else Severity.high,
                    production=production,
                    workspace_id=run.workspace_id,
                    task_id=run.task_id,
                    run_id=run.run_id,
                    requested_by=run.actor,
                    expires_at=utcnow() + timedelta(seconds=self.approval_timeout),
                )
            )
        )
        try:
            approval = await asyncio.shield(request_task)
        except asyncio.CancelledError:

            async def cleanup() -> None:
                with contextlib.suppress(Exception):
                    created = await request_task
                    await svc.cancel(created.id, "Deploy iptal edildi.")

            self.ctx.spawn(cleanup(), name="deploy:approval-cleanup")
            raise
        ex.approval = approval
        try:
            ex.run = await self._update_run(run.id, status="pending_approval", approval_id=approval.id)
            ex.log(f"Onay bekleniyor ({approval.id}): {why}")
            decided = await svc.wait(approval.id, timeout=self.approval_timeout + 5)
        except TimeoutError:
            with contextlib.suppress(StudioError):
                decided = await svc.cancel(approval.id, "Onay zaman aşımına uğradı.")
                ex.approval = decided
            return "Onay zaman aşımına uğradı."
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await asyncio.shield(svc.cancel(approval.id, "Deploy iptal edildi."))
            raise
        ex.approval = decided
        if decided.status != ApprovalStatus.approved:
            note = f": {decided.decision_note}" if decided.decision_note else ""
            return {
                ApprovalStatus.rejected: f"Onay reddedildi{note}.",
                ApprovalStatus.expired: "Onay süresi doldu.",
                ApprovalStatus.cancelled: "Onay iptal edildi.",
            }.get(decided.status, "Onay alınamadı.")
        ex.log(f"Onaylandı: {decided.decided_by} ({decided.channel})")
        return None

    def _event_base(self, run: DeployRun) -> dict[str, Any]:
        return {
            "deploy_id": run.id,
            "profile_id": run.profile_id,
            "profile_name": run.profile_name,
            "kind": run.kind,
            "environment": run.environment.value,
            "ref": run.ref,
            "actor": run.actor,
            "approval_id": run.approval_id,
            "approved_by": run.approved_by,
            "rollback_of": run.rollback_of,
        }

    async def _emit(self, type_: str, run: DeployRun, severity: Severity, **extra: Any) -> None:
        await self.ctx.events.append(
            type_,
            {**self._event_base(run), **extra},
            severity=severity,
            actor=run.actor,
            workspace_id=run.workspace_id,
            task_id=run.task_id,
            run_id=run.run_id,
        )

    async def _accept_preapproval(self, run: DeployRun, profile: DeployProfile, approval_id: str) -> Approval | None:
        """Validate an approval granted earlier in the same flow run (the deploy_approval gate) so
        the user is not asked twice. Any mismatch returns None and a fresh approval is requested."""
        if run.rollback_of is not None or run.actor.startswith("agent:") or run.task_id is None:
            return None
        svc = self.ctx.services.get(ApprovalService)  # type: ignore[type-abstract]
        try:
            approval = await svc.get(approval_id)
        except NotFound:
            return None
        if approval.kind != ApprovalKind.deploy or approval.status != ApprovalStatus.approved:
            return None
        if approval.task_id != run.task_id or approval.run_id != run.run_id:
            return None
        if run.environment == Environment.production and not approval.production:
            return None
        if approval.decided_at is None or utcnow() - approval.decided_at > PREAPPROVAL_MAX_AGE:
            return None
        profiles = approval.payload.get("profiles") or []
        if not any(isinstance(p, dict) and p.get("profile_id") == profile.id for p in profiles):
            return None
        async with self.ctx.db.connect() as conn:
            used = (
                await conn.execute(
                    sa.select(sa.func.count())
                    .select_from(runs_t)
                    .where(runs_t.c.approval_id == approval.id, runs_t.c.id != run.id)
                )
            ).scalar()
        if used:
            return None  # single use: an approval never authorizes two deploys
        return approval

    async def _execute(
        self, run: DeployRun, config: BaseModel, lock: asyncio.Lock, *, preapproval_id: str | None = None
    ) -> DeployRun:
        ex = _Execution(self, run)
        production = run.environment == Environment.production
        try:
            profile = await self.get_profile(run.profile_id)
            needs, why = await self._needs_approval(run, config)
            preapproval = (
                await self._accept_preapproval(run, profile, preapproval_id) if needs and preapproval_id else None
            )
            if preapproval is not None:
                ex.approval = preapproval
                ex.run = await self._update_run(run.id, approval_id=preapproval.id)
                ex.log(f"Akıştaki deploy onayı kullanıldı ({preapproval.id}); tekrar sorulmadı.")
            elif needs:
                denial = await self._request_approval(ex, profile, config, why)
                if denial is not None:
                    ex.log(denial)
                    final = await self._update_run(
                        run.id, status="rejected", error=denial, log=ex.text(), finished_at=utcnow()
                    )
                    await self._emit(
                        "deploy.rejected", final, Severity.high if production else Severity.normal, reason=denial
                    )
                    return final
            approved_by = ex.approval.decided_by if ex.approval else None
            ex.run = await self._update_run(run.id, status="running", approved_by=approved_by)
            await self._emit(ET.DEPLOY_STARTED, ex.run, Severity.high if production else Severity.normal)
            ok = False
            error: str | None = None
            try:
                await self._run_kind(ex, profile, config)
                ok = True
            except _Failed as e:
                error = str(e)
                ex.log(f"HATA: {error}")
            health_ok: bool | None = None
            if ok and profile.health_check:
                hc = HealthCheck.model_validate(profile.health_check)
                health_ok = await self._health_check(ex, hc)
                if not health_ok:
                    ok = False
                    error = "Sağlık kontrolü başarısız."
            rollback_available = (not ok) and bool(profile.rollback) and run.rollback_of is None
            if rollback_available:
                ex.log("Geri alma kullanılabilir.")
            final = await self._update_run(
                run.id,
                status="succeeded" if ok else "failed",
                health_ok=health_ok,
                error=error,
                rollback_available=rollback_available,
                log=ex.text(),
                finished_at=utcnow(),
            )
            if ok:
                await self._emit(
                    ET.DEPLOY_SUCCEEDED, final, Severity.high if production else Severity.normal, health_ok=health_ok
                )
            else:
                await self._emit(
                    ET.DEPLOY_FAILED,
                    final,
                    Severity.critical if production else Severity.high,
                    error=error,
                    health_ok=health_ok,
                    rollback_available=rollback_available,
                )
            return final
        except asyncio.CancelledError:
            ex.log("Deploy iptal edildi.")
            with contextlib.suppress(Exception):
                final = await asyncio.shield(
                    self._update_run(
                        run.id, status="cancelled", error="İptal edildi.", log=ex.text(), finished_at=utcnow()
                    )
                )
                await asyncio.shield(self._emit(ET.DEPLOY_FAILED, final, Severity.high, error="İptal edildi."))
            raise
        except Exception as e:
            message = e.message if isinstance(e, StudioError) else f"{type(e).__name__}: {e}"
            log.exception("deploy %s crashed", run.id)
            ex.log(f"HATA: {message}")
            final = await self._update_run(run.id, status="failed", error=message, log=ex.text(), finished_at=utcnow())
            await self._emit(ET.DEPLOY_FAILED, final, Severity.critical if production else Severity.high, error=message)
            return final
        finally:
            lock.release()

    async def _run_kind(self, ex: _Execution, profile: DeployProfile, config: BaseModel) -> None:
        if isinstance(config, CiConfig):
            await self._run_ci(ex, config)
        elif isinstance(config, SshConfig):
            await self._run_ssh(ex, config)
        elif isinstance(config, CommandConfig):
            await self._run_command(ex, config)
        else:  # pragma: no cover - validated earlier
            raise _Failed(f"Desteklenmeyen deploy türü: {profile.kind}")

    def _deploy_env(self, run: DeployRun) -> dict[str, str]:
        return {"DEPLOY_ID": run.id, "DEPLOY_ENV": run.environment.value, "DEPLOY_REF": run.ref or ""}

    # ------------------------------------------------------------------ ci
    async def _run_ci(self, ex: _Execution, cfg: CiConfig) -> None:
        hosting = self.ctx.services.get(GitHostingService)  # type: ignore[type-abstract]
        ref = ex.run.ref
        if not ref:
            workspaces = self.ctx.services.maybe(WorkspaceService)  # type: ignore[type-abstract]
            ref = (await workspaces.get_repo(cfg.repo_id)).default_branch if workspaces else "main"
        ex.log(f"Pipeline tetikleniyor: repo={cfg.repo_id} ref={ref} workflow={cfg.workflow or '-'}")
        try:
            external_id = await hosting.trigger_pipeline(
                cfg.repo_id, ref=ref, workflow=cfg.workflow, variables=cfg.variables or None
            )
        except StudioError as e:
            raise _Failed(f"Pipeline tetiklenemedi: {e.message}") from None
        ex.run = await self._update_run(ex.run.id, external_id=str(external_id))
        ex.log(f"Pipeline başlatıldı: {external_id}")
        deadline = time.monotonic() + cfg.timeout_s
        last: str | None = None
        while True:
            try:
                check = await hosting.pipeline_status(cfg.repo_id, str(external_id))
            except StudioError as e:
                ex.log(f"Durum alınamadı: {e.message}")
                check = None
            if check is not None:
                state = f"{check.status}/{check.conclusion or '-'}"
                if state != last:
                    ex.log(f"Pipeline durumu: {state}" + (f" ({check.url})" if check.url else ""))
                    last = state
                if check.status == "completed":
                    if check.conclusion != "success":
                        raise _Failed(f"Pipeline başarısız: {check.conclusion}")
                    return
            if time.monotonic() >= deadline:
                raise _Failed("Pipeline zaman aşımına uğradı.")
            await asyncio.sleep(min(cfg.poll_interval_s, max(0.0, deadline - time.monotonic())))

    # ------------------------------------------------------------------ ssh
    async def _run_ssh(self, ex: _Execution, cfg: SshConfig) -> None:
        hosts = await self._hosts(cfg)
        size = cfg.batch_size if cfg.strategy == "rolling" else 1
        batches = [hosts[i : i + size] for i in range(0, len(hosts), size)]
        hc_raw = (await self.get_profile(ex.run.profile_id)).health_check
        for index, batch in enumerate(batches, 1):
            ex.log(f"Adım {index}/{len(batches)}: " + ", ".join(h.name for h in batch))
            results = await asyncio.gather(*(self._run_on_host(ex, host, cfg) for host in batch))
            failed = [h.name for h, ok in zip(batch, results, strict=True) if not ok]
            if failed:
                raise _Failed("Betik başarısız: " + ", ".join(failed))
            if cfg.strategy == "rolling" and hc_raw and index < len(batches):
                ex.log("Ara sağlık kontrolü…")
                if not await self._health_check(ex, HealthCheck.model_validate(hc_raw)):
                    raise _Failed(f"Ara sağlık kontrolü başarısız ({index}. adımdan sonra); dağıtım durduruldu.")

    async def _audit_remote(
        self,
        ex: _Execution,
        host: Host,
        command: str,
        *,
        outcome: str,
        exit_code: int | None,
        duration_ms: int | None,
        output: str,
        error: str | None,
        purpose: str,
    ) -> None:
        approval = ex.approval
        approved = approval is not None and approval.status == ApprovalStatus.approved
        production = host.environment == Environment.production
        await self.ctx.events.append(
            ET.REMOTE_COMMAND,
            {
                "host_id": host.id,
                "host_name": host.name,
                "hostname": host.hostname,
                "environment": host.environment.value,
                "permission_level": host.permission_level.value,
                "command": truncate(command, 8000),
                "classification": {
                    "klass": "write" if purpose == "deploy" else "unknown",
                    "reasons": [f"Deploy {purpose} komutu; deploy onayı kapsamında çalıştırıldı"],
                },
                "outcome": outcome,
                "decision": "approve" if approval else "allow",
                "policy_reason": "Deploy profili",
                "approval_id": approval.id if approval else None,
                "approved_by": approval.decided_by if approved and approval else None,
                "approval_status": approval.status.value if approval else None,
                "exit_code": exit_code,
                "duration_ms": duration_ms,
                "output_preview": truncate(self.ctx.masker.mask(output), 2000),
                "denied": False,
                "error": error,
                "reason": ex.run.summary,
                "source": "deploy",
                "deploy_id": ex.run.id,
                "actor_kind": "agent" if ex.run.actor.startswith("agent:") else "user",
            },
            severity=Severity.high if production else Severity.normal,
            actor=ex.run.actor,
            workspace_id=ex.run.workspace_id,
            task_id=ex.run.task_id,
            run_id=ex.run.run_id,
        )

    async def _run_on_host(self, ex: _Execution, host: Host, cfg: SshConfig) -> bool:
        remote = self.ctx.services.get(RemoteService)  # type: ignore[type-abstract]
        prelude = "".join(f"export {k}={shlex.quote(v)}\n" for k, v in self._deploy_env(ex.run).items())
        script = prelude + cfg.script.rstrip("\n") + "\n"
        started = time.monotonic()
        try:
            transport = await remote.transport(host.id)
            result = await transport.run(["sh", "-s"], cwd=cfg.cwd, input=script.encode(), timeout=cfg.timeout_s)
        except TimeoutError:
            message = f"{host.name}: zaman aşımı ({cfg.timeout_s:g} sn)"
            ex.log(message)
            await self._audit_remote(
                ex,
                host,
                cfg.script,
                outcome="failed",
                exit_code=None,
                duration_ms=None,
                output="",
                error=message,
                purpose="deploy",
            )
            return False
        except (StudioError, OSError) as e:
            message = e.message if isinstance(e, StudioError) else str(e)
            ex.log(f"{host.name}: {message}")
            await self._audit_remote(
                ex,
                host,
                cfg.script,
                outcome="failed",
                exit_code=None,
                duration_ms=None,
                output="",
                error=message,
                purpose="deploy",
            )
            return False
        output = (result.stdout + ("\n" + result.stderr if result.stderr.strip() else "")).strip()
        for line in output.splitlines()[-400:]:
            ex.log(f"[{host.name}] {line}")
        ex.log(f"{host.name}: çıkış kodu {result.returncode}")
        await self._audit_remote(
            ex,
            host,
            cfg.script,
            outcome="executed",
            exit_code=result.returncode,
            duration_ms=int((time.monotonic() - started) * 1000),
            output=output,
            error=None,
            purpose="deploy",
        )
        return result.returncode == 0

    # ------------------------------------------------------------------ local command
    async def _run_command(self, ex: _Execution, cfg: CommandConfig) -> None:
        env = {**os.environ, **cfg.env, **self._deploy_env(ex.run)}
        ex.log(f"$ {cfg.command}")
        try:
            result = await run_local(["/bin/sh", "-c", cfg.command], cwd=cfg.cwd, env=env, timeout=cfg.timeout_s)
        except TimeoutError:
            raise _Failed(f"Komut zaman aşımına uğradı ({cfg.timeout_s:g} sn).") from None
        except OSError as e:
            raise _Failed(f"Komut çalıştırılamadı: {e}") from None
        for line in (result.stdout + result.stderr).splitlines()[-1000:]:
            ex.log(line)
        if result.returncode != 0:
            raise _Failed(f"Komut başarısız (çıkış kodu {result.returncode}).")

    # ------------------------------------------------------------------ health check
    async def _health_check(self, ex: _Execution, hc: HealthCheck) -> bool:
        deadline = time.monotonic() + hc.timeout_s
        attempt = 0
        while True:
            attempt += 1
            remaining = max(0.5, deadline - time.monotonic())
            ok = await (self._probe_url(ex, hc, remaining) if hc.url else self._probe_command(ex, hc, remaining))
            if ok:
                ex.log(f"Sağlık kontrolü başarılı ({attempt}. deneme).")
                return True
            if time.monotonic() >= deadline:
                ex.log(f"Sağlık kontrolü {hc.timeout_s:g} sn içinde başarılı olmadı.")
                return False
            await asyncio.sleep(min(hc.interval_s, max(0.0, deadline - time.monotonic())))

    async def _probe_url(self, ex: _Execution, hc: HealthCheck, remaining: float) -> bool:
        assert hc.url is not None
        try:
            async with httpx.AsyncClient(timeout=min(10.0, remaining), follow_redirects=True) as client:
                response = await client.get(hc.url)
        except httpx.HTTPError as e:
            ex.log(f"Sağlık kontrolü: {hc.url} -> {type(e).__name__}")
            return False
        ok = response.status_code in hc.expect_status if hc.expect_status else 200 <= response.status_code < 300
        ex.log(f"Sağlık kontrolü: {hc.url} -> HTTP {response.status_code}")
        return ok

    async def _probe_command(self, ex: _Execution, hc: HealthCheck, remaining: float) -> bool:
        assert hc.command is not None
        timeout = min(60.0, remaining)
        if hc.host_id:
            remote = self.ctx.services.get(RemoteService)  # type: ignore[type-abstract]
            host = await remote.get_host(hc.host_id)
            started = time.monotonic()
            try:
                transport = await remote.transport(hc.host_id)
                result = await transport.run(["sh", "-c", hc.command], timeout=timeout)
            except (TimeoutError, StudioError, OSError) as e:
                message = e.message if isinstance(e, StudioError) else (str(e) or type(e).__name__)
                ex.log(f"Sağlık kontrolü ({host.name}): {message}")
                await self._audit_remote(
                    ex,
                    host,
                    hc.command,
                    outcome="failed",
                    exit_code=None,
                    duration_ms=None,
                    output="",
                    error=message,
                    purpose="health",
                )
                return False
            output = (result.stdout + result.stderr).strip()
            await self._audit_remote(
                ex,
                host,
                hc.command,
                outcome="executed",
                exit_code=result.returncode,
                duration_ms=int((time.monotonic() - started) * 1000),
                output=output,
                error=None,
                purpose="health",
            )
        else:
            try:
                result = await run_local(["/bin/sh", "-c", hc.command], timeout=timeout)
            except (TimeoutError, OSError) as e:
                ex.log(f"Sağlık kontrolü komutu: {type(e).__name__}")
                return False
            output = (result.stdout + result.stderr).strip()
        ex.log(f"Sağlık kontrolü komutu çıkış kodu {result.returncode}" + (f": {output[-500:]}" if output else ""))
        return result.returncode == 0
