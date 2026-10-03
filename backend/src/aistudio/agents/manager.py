"""Agent manager (``AgentManager``): sessions, resume, discovery, import and the stall watchdog.

Session start (spec §6, §8, §10):

* transport - local: ``LocalTransport``; remote: ``RemoteService.transport(host_id)``.
* boundaries - workspace (memory ``boundaries.md``) ∩ profile ∩ spec (``Boundaries.merged``);
  advisors are always read-only.
* system prompt - memory context + role preamble + profile instructions + ``spec.system_append``.
* tools - ``ToolRegistry.bind`` (no mutating tools for advisors).
* sink - :class:`aistudio.agents.sink.SessionSink`; permissions - :class:`PermissionGate`.

Events emitted here (besides the adapter stream and permission events):
    agent.session.created   {session_id, provider, role, label, origin, cwd, location, ...}
    agent.session.resumed   {native_id}
    agent.session.imported  {native_id, provider, events}
    agent.stalled           {minutes, state, last_activity_at, label}   (critical)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

from aistudio.agents.live import LiveSession
from aistudio.agents.permissions import PermissionGate
from aistudio.agents.policy import DEFAULT_SAFE_COMMANDS, PolicyContext
from aistudio.agents.profiles import AgentProfileOut, ProfileStore
from aistudio.agents.roles import PROVIDER_NAMES, default_label, role_preamble
from aistudio.agents.sessions import RUNNING_STATES, SessionRepo
from aistudio.agents.sink import SessionSink
from aistudio.agents.subagents import SubagentIndex, SubagentView
from aistudio.agents.transport_local import LocalTransport, sanitize_extra_env
from aistudio.contracts.agents import (
    EPHEMERAL_PAYLOADS,
    PAYLOAD_EVENT_TYPE,
    AdapterHealth,
    AdapterRegistry,
    AgentAdapter,
    AgentProfile,
    AgentRole,
    AgentSessionHandle,
    AgentState,
    Boundaries,
    NativeSessionInfo,
    SandboxLevel,
    SessionRecord,
    SessionSpec,
    SessionStarted,
    StartSessionRequest,
    TurnCompleted,
    Usage,
)
from aistudio.contracts.common import PROVIDERS, Environment, Location, Provider
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.remote import RemoteService
from aistudio.contracts.tools import ToolContext, ToolHost, ToolRegistry, ToolResult, ToolSpec
from aistudio.contracts.transport import Transport
from aistudio.contracts.workspaces import WorkspaceService
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, NotFound, StudioError, Unavailable, ValidationFailed
from aistudio.core.events import ET, Severity
from aistudio.core.ids import new_id
from aistudio.core.text import truncate

log = logging.getLogger(__name__)

SETTING_STALL_MINUTES = "agents.stall_minutes"
DEFAULT_STALL_MINUTES = 10
_ADAPTER_CALL_TIMEOUT = 60.0
_CLOSE_TIMEOUT = 15.0

# Credentials and app internals agents must never touch through their tools (spec §8 layer 4).
PROTECTED_HOME_PATHS: tuple[str, ...] = (
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".docker/config.json",
    ".config/gcloud",
    ".azure",
    ".netrc",
    ".pgpass",
    ".my.cnf",
    ".git-credentials",
    ".codex/auth.json",
    ".claude/.credentials.json",
    "Library/Keychains",
)
_PROJECT_COMMAND_KEYS = ("lint", "typecheck", "test", "build")


class _NoTools:
    """Tool host used when the tools module is not available."""

    def specs(self) -> list[ToolSpec]:
        return []

    async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
        return ToolResult(content=f"Unknown or not permitted tool: {name}", is_error=True)


@dataclass
class _Prepared:
    spec: SessionSpec
    tools: ToolHost
    policy: PolicyContext
    production: bool


class AgentManagerImpl:
    def __init__(self, ctx: AppContext, registry: AdapterRegistry, local: LocalTransport) -> None:
        self._ctx = ctx
        self._registry = registry
        self._local = local
        self.profiles = ProfileStore(ctx.db, ctx.events)
        self.repo = SessionRepo(ctx.db)
        self.subagents = SubagentIndex(ctx.db)
        self._live: dict[str, LiveSession] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    # ------------------------------------------------------------------ lifecycle
    async def start(self) -> None:
        await self.profiles.seed_defaults()
        recovered = await self.repo.recover_after_restart()
        if recovered:
            log.info("marked %d stale agent sessions as interrupted", recovered)
        stale_subagents = await self.subagents.recover_after_restart()
        if stale_subagents:
            log.info("marked %d stale subagents as interrupted", stale_subagents)
        self._ctx.spawn(self._watchdog_loop(), name="agents-stall-watchdog")

    async def stop(self) -> None:
        alive = [live for live in self._live.values() if live.is_alive()]
        if alive:
            await asyncio.gather(*(self._close_live(live, timeout=5.0) for live in alive), return_exceptions=True)
        self._live.clear()

    # ------------------------------------------------------------------ helpers
    def _lock(self, session_id: str) -> asyncio.Lock:
        return self._locks.setdefault(session_id, asyncio.Lock())

    async def _setting_float(self, key: str, default: float) -> float:
        try:
            value = await self._ctx.store.get(key)
        except Exception:
            return default
        return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else default

    async def _check_workspace(self, workspace_id: str) -> None:
        ws = self._ctx.services.maybe(WorkspaceService)  # type: ignore[type-abstract]
        if ws is not None:
            await ws.get(workspace_id)

    async def transport_for(self, location: Location) -> Transport:
        if location.kind == "local":
            return self._local
        if not location.host_id:
            raise ValidationFailed("Uzak konum için host_id gerekli.")
        remote = self._ctx.services.maybe(RemoteService)  # type: ignore[type-abstract]
        if remote is None:
            raise Unavailable("Uzak bağlantı servisi hazır değil.")
        return await remote.transport(location.host_id)

    async def _is_production(self, location: Location) -> bool:
        if location.kind != "remote" or not location.host_id:
            return False
        remote = self._ctx.services.maybe(RemoteService)  # type: ignore[type-abstract]
        if remote is None:
            return False
        try:
            host = await remote.get_host(location.host_id)
        except StudioError:
            return False
        return host.environment == Environment.production

    async def _workspace_boundaries(self, workspace_id: str) -> Boundaries:
        memory = self._ctx.services.maybe(MemoryService)  # type: ignore[type-abstract]
        if memory is None:
            return Boundaries()
        try:
            return await memory.boundaries(workspace_id)
        except Exception:
            log.exception("could not read workspace boundaries for %s", workspace_id)
            return Boundaries()

    async def _memory_context(self, workspace_id: str, role: AgentRole) -> str:
        memory = self._ctx.services.maybe(MemoryService)  # type: ignore[type-abstract]
        if memory is None:
            return ""
        try:
            return await memory.context_for_agent(workspace_id, role=role)
        except Exception:
            log.exception("could not build memory context for %s", workspace_id)
            return ""

    async def _workspace_roots(self, workspace_id: str, location: Location) -> tuple[list[str], list[str]]:
        """(repo paths readable by the agent, the repos' own lint/test/build commands)."""
        ws = self._ctx.services.maybe(WorkspaceService)  # type: ignore[type-abstract]
        if ws is None:
            return [], []
        try:
            repos = await ws.repos(workspace_id)
        except StudioError:
            return [], []
        roots: list[str] = []
        commands: list[str] = []
        for repo in repos:
            same_place = repo.host_id is None if location.kind == "local" else repo.host_id == location.host_id
            if not same_place:
                continue
            roots.append(repo.path)
            defined = repo.commands.defined()
            commands.extend(defined[k] for k in _PROJECT_COMMAND_KEYS if k in defined)
        return roots, commands

    def _protected_paths(self, home: str, local: bool) -> tuple[tuple[str, ...], tuple[str, ...]]:
        forbidden = [os.path.join(home, p) for p in PROTECTED_HOME_PATHS]
        readonly: list[str] = []
        if local:
            paths = self._ctx.settings.paths
            db = str(paths.db)
            forbidden += [db, f"{db}-wal", f"{db}-shm", f"{db}-journal", str(paths.runtime_file), str(paths.backups)]
            readonly += [str(paths.workspaces), str(paths.checkpoints)]
        return tuple(forbidden), tuple(readonly)

    def _bind_tools(self, tool_ctx: ToolContext, names: list[str] | None, role: AgentRole) -> ToolHost:
        registry = self._ctx.services.maybe(ToolRegistry)  # type: ignore[type-abstract]
        if registry is None:
            return _NoTools()
        return registry.bind(tool_ctx, names, allow_mutating=role != "advisor")

    async def _maybe_profile(self, profile_id: str | None) -> AgentProfileOut | None:
        if not profile_id:
            return None
        try:
            return await self.profiles.get(profile_id)
        except NotFound:
            return None

    async def _prepare(
        self,
        *,
        session_id: str,
        workspace_id: str,
        base: SessionSpec,
        role: AgentRole,
        model: str | None,
        effort: str | None,
        profile: AgentProfile | None,
        tool_names: list[str] | None,
        transport: Transport,
        label: str,
        task_id: str | None,
        run_id: str | None,
        node_id: str | None,
    ) -> _Prepared:
        bounds = await self._workspace_boundaries(workspace_id)
        if profile is not None:
            bounds = bounds.merged(profile.boundaries)
        bounds = bounds.merged(base.boundaries)
        if role == "advisor":
            bounds = bounds.model_copy(update={"sandbox": SandboxLevel.read_only})

        tools = self._bind_tools(
            ToolContext(
                workspace_id=workspace_id,
                session_id=session_id,
                provider=base.provider,
                location=base.location,
                task_id=task_id,
                run_id=run_id,
                node_id=node_id,
                agent_label=label,
            ),
            tool_names,
            role,
        )
        preamble = role_preamble(
            role,
            cwd=base.cwd,
            boundaries=bounds,
            tool_names=[s.name for s in tools.specs()],
            extra_dirs=base.extra_dirs,
        )
        memory_ctx = await self._memory_context(workspace_id, role)
        sections = [memory_ctx, preamble, profile.instructions if profile else "", base.system_append]
        spec = base.model_copy(
            update={
                "model": model,
                "effort": effort,
                "role": role,
                "system_append": "\n\n".join(s.strip() for s in sections if s and s.strip()),
                "boundaries": bounds,
                "env": sanitize_extra_env(base.env),
                "title": base.title or label,
            }
        )

        local = base.location.kind == "local"
        try:
            home = await transport.home()
        except Exception:
            home = os.path.expanduser("~") if local else "/"
        read_roots, project_commands = await self._workspace_roots(workspace_id, base.location)
        forbidden, readonly = self._protected_paths(home, local)
        policy = PolicyContext(
            role=role,
            cwd=base.cwd,
            boundaries=bounds,
            extra_dirs=tuple(base.extra_dirs),
            read_roots=tuple(read_roots),
            safe_commands=DEFAULT_SAFE_COMMANDS,
            project_commands=tuple(project_commands),
            home=home,
            protected_forbidden=forbidden,
            protected_readonly=readonly,
            realpath=os.path.realpath if local else None,
        )
        return _Prepared(spec=spec, tools=tools, policy=policy, production=await self._is_production(base.location))

    def _make_live(
        self,
        record: SessionRecord,
        prepared: _Prepared,
    ) -> tuple[LiveSession, SessionSink, PermissionGate]:
        live = LiveSession(
            id=record.id,
            workspace_id=record.workspace_id,
            provider=record.provider,
            role=record.role,
            label=record.label or default_label(record.provider, record.role),
            location=record.location,
            cwd=record.cwd,
            spec=prepared.spec,
            policy=prepared.policy,
            task_id=record.task_id,
            run_id=record.run_id,
            node_id=record.node_id,
            production=prepared.production,
            native_id=record.native_id,
        )
        sink = SessionSink(self._ctx, self.repo, live, self._on_ended, self.subagents)
        gate = PermissionGate(self._ctx, live, self._set_live_state, self.subagents)
        return live, sink, gate

    async def _set_live_state(self, live: LiveSession, state: AgentState) -> None:
        if live.state == state:
            return
        live.state = state
        await self.repo.update(live.id, state=state)

    async def _on_ended(self, live: LiveSession) -> None:
        if self._live.get(live.id) is live:
            self._live.pop(live.id, None)

    async def _launch(
        self,
        adapter: AgentAdapter,
        transport: Transport,
        live: LiveSession,
        sink: SessionSink,
        gate: PermissionGate,
        tools: ToolHost,
    ) -> AgentSessionHandle:
        self._live[live.id] = live
        try:
            handle = await adapter.start(live.spec, transport=transport, sink=sink, tools=tools, permissions=gate)
        except Exception as e:
            self._live.pop(live.id, None)
            live.ended = True
            live.state = AgentState.error
            await self.repo.update(live.id, state=AgentState.error)
            message = e.message if isinstance(e, StudioError) else f"Ajan başlatılamadı: {e}"
            await self._ctx.events.append(
                ET.AGENT_ERROR,
                {"message": message, "retryable": False, "code": "start_failed"},
                severity=Severity.high,
                actor=live.actor,
                **live.ids(),
            )
            if isinstance(e, StudioError):
                raise
            raise Unavailable(message) from e
        live.handle = handle
        if not live.ended:
            native = _safe_native_id(handle)
            if native and native != live.native_id:
                live.native_id = native
                await self.repo.update(live.id, native_id=native)
        return handle

    # ------------------------------------------------------------------ AgentManager
    async def start_session(self, req: StartSessionRequest) -> SessionRecord:
        await self._check_workspace(req.workspace_id)
        base = req.spec
        profile = await self.profiles.get(req.profile_id) if req.profile_id else None
        if profile is not None and profile.provider != base.provider:
            raise ValidationFailed("Profilin sağlayıcısı oturumun sağlayıcısıyla uyuşmuyor.")
        role: AgentRole = base.role if ("role" in base.model_fields_set or profile is None) else profile.role
        model = base.model or (profile.model if profile else None)
        effort = base.effort or (profile.effort if profile else None)
        adapter = self._registry.get(base.provider)
        transport = await self.transport_for(base.location)

        session_id = new_id("ses")
        label = req.label or (profile.name if profile else default_label(base.provider, role))
        prepared = await self._prepare(
            session_id=session_id,
            workspace_id=req.workspace_id,
            base=base,
            role=role,
            model=model,
            effort=effort,
            profile=profile,
            tool_names=req.tool_names,
            transport=transport,
            label=label,
            task_id=req.task_id,
            run_id=req.run_id,
            node_id=req.node_id,
        )
        now = utcnow()
        record = SessionRecord(
            id=session_id,
            workspace_id=req.workspace_id,
            provider=base.provider,
            profile_id=req.profile_id,
            native_id=base.resume_native_id if not base.fork else None,
            location=base.location,
            cwd=base.cwd,
            worktree_id=req.worktree_id,
            task_id=req.task_id,
            run_id=req.run_id,
            node_id=req.node_id,
            label=label,
            role=role,
            model=model,
            effort=effort,
            state=AgentState.starting,
            origin="created",
            title=prepared.spec.title,
            created_at=now,
            updated_at=now,
        )
        await self.repo.insert(
            record, request={"spec": base.model_dump(mode="json"), "tool_names": req.tool_names, "effort": effort}
        )
        await self._emit_created(record)
        live, sink, gate = self._make_live(record, prepared)
        handle = await self._launch(adapter, transport, live, sink, gate, prepared.tools)
        if req.initial_prompt:
            await handle.send(req.initial_prompt)
        return await self.repo.get(session_id)

    async def _emit_created(self, record: SessionRecord) -> None:
        await self._ctx.events.append(
            "agent.session.created",
            {
                "session_id": record.id,
                "provider": record.provider,
                "role": record.role,
                "label": record.label,
                "profile_id": record.profile_id,
                "origin": record.origin,
                "cwd": record.cwd,
                "location": record.location.model_dump(mode="json"),
                "model": record.model,
                "title": record.title,
                "native_id": record.native_id,
                "worktree_id": record.worktree_id,
                "node_id": record.node_id,
            },
            actor="system",
            workspace_id=record.workspace_id,
            task_id=record.task_id,
            run_id=record.run_id,
            session_id=record.id,
        )

    async def handle(self, session_id: str) -> AgentSessionHandle:
        live = self._live.get(session_id)
        if live is not None and live.is_alive() and live.handle is not None:
            return live.handle
        async with self._lock(session_id):
            live = self._live.get(session_id)
            if live is not None and live.is_alive() and live.handle is not None:
                return live.handle
            return await self._resume(session_id)

    async def _resume(self, session_id: str) -> AgentSessionHandle:
        record = await self.repo.get(session_id)
        if not record.native_id:
            raise Conflict("Bu oturum devam ettirilemiyor: CLI oturum kimliği bilinmiyor.")
        request = await self.repo.get_request(session_id)
        tool_names: list[str] | None = None
        if request and isinstance(request.get("spec"), dict):
            base = SessionSpec.model_validate(request["spec"])
            raw_names = request.get("tool_names")
            tool_names = [str(n) for n in raw_names] if isinstance(raw_names, list) else None
        else:
            base = SessionSpec(
                provider=record.provider, cwd=record.cwd, location=record.location, role=record.role, title=record.title
            )
        base = base.model_copy(
            update={"resume_native_id": record.native_id, "fork": False, "cwd": record.cwd, "location": record.location}
        )
        profile = await self._maybe_profile(record.profile_id)
        adapter = self._registry.get(record.provider)
        transport = await self.transport_for(record.location)
        label = record.label or default_label(record.provider, record.role)
        prepared = await self._prepare(
            session_id=record.id,
            workspace_id=record.workspace_id,
            base=base,
            role=record.role,
            model=base.model or record.model or (profile.model if profile else None),
            effort=base.effort or (profile.effort if profile else None),
            profile=profile,
            tool_names=tool_names,
            transport=transport,
            label=label,
            task_id=record.task_id,
            run_id=record.run_id,
            node_id=record.node_id,
        )
        await self.repo.update(record.id, state=AgentState.starting)
        record = record.model_copy(update={"state": AgentState.starting})
        live, sink, gate = self._make_live(record, prepared)
        await self._ctx.events.append(
            "agent.session.resumed", {"native_id": record.native_id}, actor="system", **live.ids()
        )
        return await self._launch(adapter, transport, live, sink, gate, prepared.tools)

    async def get(self, session_id: str) -> SessionRecord:
        return await self.repo.get(session_id)

    async def list(
        self, *, workspace_id: str | None = None, run_id: str | None = None, active_only: bool = False
    ) -> list[SessionRecord]:
        ids = [sid for sid, live in self._live.items() if live.is_alive()] if active_only else None
        return await self.repo.list(workspace_id=workspace_id, run_id=run_id, ids=ids)

    def is_live(self, session_id: str) -> bool:
        live = self._live.get(session_id)
        return live is not None and live.is_alive()

    async def health(self, location: Location | None = None) -> list[AdapterHealth]:
        transport = await self.transport_for(location or Location())
        adapters: dict[Provider, AgentAdapter] = {a.provider: a for a in self._registry.all()}

        async def one(provider: Provider) -> AdapterHealth:
            adapter = adapters.get(provider)
            if adapter is None:
                return AdapterHealth(
                    provider=provider, installed=False, message="Bu sağlayıcı için adaptör yüklü değil."
                )
            try:
                return await asyncio.wait_for(adapter.health(transport), timeout=_ADAPTER_CALL_TIMEOUT)
            except Exception as e:
                log.exception("health check failed for %s", provider)
                return AdapterHealth(provider=provider, installed=False, message=f"Durum alınamadı: {e}")

        providers: list[Provider] = [*PROVIDERS, *(p for p in adapters if p not in PROVIDERS)]
        return list(await asyncio.gather(*(one(p) for p in providers)))

    async def discover(self, location: Location, *, cwd: str | None = None) -> list[NativeSessionInfo]:
        transport = await self.transport_for(location)
        adapters = self._registry.all()

        async def one(adapter: AgentAdapter) -> list[NativeSessionInfo]:
            try:
                return await asyncio.wait_for(
                    adapter.list_native_sessions(transport, cwd=cwd), timeout=_ADAPTER_CALL_TIMEOUT
                )
            except Exception:
                log.exception("session discovery failed for %s", adapter.provider)
                return []

        found: dict[tuple[str, str], NativeSessionInfo] = {}
        for batch in await asyncio.gather(*(one(a) for a in adapters)):
            for info in batch:
                if info.location != location:
                    info = info.model_copy(update={"location": location})
                found.setdefault((info.provider, info.native_id), info)

        def recency(info: NativeSessionInfo) -> float:
            ts = info.updated_at or info.created_at
            return ts.timestamp() if ts is not None else 0.0

        return sorted(found.values(), key=recency, reverse=True)

    async def imported_index(self, infos: list[NativeSessionInfo]) -> dict[tuple[str, str], str]:
        return await self.repo.native_index((i.provider, i.native_id) for i in infos)

    async def import_native(self, workspace_id: str, info: NativeSessionInfo) -> SessionRecord:
        await self._check_workspace(workspace_id)
        existing = await self.repo.find_native(workspace_id, info.provider, info.native_id, info.location)
        if existing is not None:
            return existing
        adapter = self._registry.get(info.provider)
        transport = await self.transport_for(info.location)
        history = await adapter.read_native_history(transport, info.native_id, cwd=info.cwd)
        cwd = info.cwd or await transport.home()
        now = utcnow()
        provider_name = PROVIDER_NAMES.get(info.provider, info.provider)
        record = SessionRecord(
            id=new_id("ses"),
            workspace_id=workspace_id,
            provider=info.provider,
            native_id=info.native_id,
            location=info.location,
            cwd=cwd,
            label=truncate(info.title, 80, marker="…") if info.title else f"{provider_name} oturumu",
            role="writer",
            model=info.model,
            state=AgentState.idle,
            origin="imported",
            title=info.title,
            created_at=now,
            updated_at=now,
        )
        await self.repo.insert(record, request=None)
        await self._emit_created(record)
        ids: dict[str, Any] = {"workspace_id": workspace_id, "session_id": record.id}
        actor = f"agent:{record.id}"
        last_usage: Usage | None = None
        model = info.model
        count = 0
        for payload in history:
            etype = PAYLOAD_EVENT_TYPE.get(type(payload))
            if etype is None or isinstance(payload, EPHEMERAL_PAYLOADS):
                continue
            await self._ctx.events.append(etype, payload.model_dump(mode="json"), actor=actor, **ids)
            count += 1
            await self.subagents.apply(record.id, payload)
            if isinstance(payload, Usage) and payload.subagent_id is None:
                last_usage = payload
            elif isinstance(payload, TurnCompleted) and payload.usage is not None:
                last_usage = payload.usage
            elif isinstance(payload, SessionStarted) and payload.model:
                model = payload.model
        await self.subagents.end_session(record.id)  # nothing runs in an imported history
        self.subagents.forget(record.id)
        await self._ctx.events.append(
            "agent.session.imported",
            {
                "native_id": info.native_id,
                "provider": info.provider,
                "events": count,
                "location": info.location.model_dump(mode="json"),
                "file_path": info.file_path,
            },
            actor="user",
            **ids,
        )
        changes: dict[str, Any] = {}
        if last_usage is not None:
            changes["last_usage"] = last_usage
        if model != record.model:
            changes["model"] = model
        if changes:
            await self.repo.update(record.id, **changes)
        return await self.repo.get(record.id)

    async def resolve_profile(self, profile_id: str) -> AgentProfile:
        return await self.profiles.get(profile_id)

    # ------------------------------------------------------------------ session control (API helpers)
    async def send(self, session_id: str, text: str) -> str:
        if not text.strip():
            raise ValidationFailed("Mesaj boş olamaz.")
        handle = await self.handle(session_id)
        return await handle.send(text)

    async def steer(self, session_id: str, text: str) -> None:
        if not text.strip():
            raise ValidationFailed("Mesaj boş olamaz.")
        handle = await self.handle(session_id)
        await handle.steer(text)

    async def interrupt(self, session_id: str) -> None:
        await self.repo.get(session_id)
        live = self._live.get(session_id)
        if live is not None and live.is_alive() and live.handle is not None:
            await live.handle.interrupt()

    async def close(self, session_id: str) -> SessionRecord:
        record = await self.repo.get(session_id)
        live = self._live.get(session_id)
        if live is not None and live.is_alive():
            await self._close_live(live, timeout=_CLOSE_TIMEOUT)
        if record.state not in (AgentState.done, AgentState.error):
            await self.repo.update(session_id, state=AgentState.done)
        return await self.repo.get(session_id)

    async def _close_live(self, live: LiveSession, *, timeout: float) -> None:
        live.closing = True
        handle = live.handle
        if handle is not None:
            try:
                await asyncio.wait_for(handle.close(), timeout=timeout)
            except Exception:
                log.exception("closing session %s failed", live.id)
        live.ended = True
        live.state = AgentState.done
        if self._live.get(live.id) is live:
            self._live.pop(live.id, None)
        try:  # normally done by the sink on SessionEnded; covers adapters that never sent it
            await self.subagents.end_session(live.id)
        except Exception:
            log.exception("could not close subagents of session %s", live.id)
        self.subagents.forget(live.id)

    async def list_subagents(self, session_id: str) -> list[SubagentView]:
        await self.repo.get(session_id)  # 404 for unknown sessions
        return await self.subagents.list(session_id)

    # ------------------------------------------------------------------ stall watchdog
    async def check_stalls(self, minutes: float | None = None) -> list[str]:
        """Emit ``agent.stalled`` (critical, once per stall) for running sessions that produced
        no event for ``minutes``. Returns the ids flagged by this call."""
        if minutes is None:
            minutes = await self._setting_float(SETTING_STALL_MINUTES, DEFAULT_STALL_MINUTES)
        if minutes <= 0:
            return []
        now = time.monotonic()
        flagged: list[str] = []
        for live in list(self._live.values()):
            if live.ended or live.stalled or live.state not in RUNNING_STATES:
                continue
            if now - live.last_activity < minutes * 60:
                continue
            live.stalled = True
            flagged.append(live.id)
            await self._ctx.events.append(
                ET.AGENT_STALLED,
                {
                    "minutes": minutes,
                    "state": live.state.value,
                    "last_activity_at": live.last_activity_at.isoformat(),
                    "label": live.label,
                    "provider": live.provider,
                },
                severity=Severity.critical,
                actor="system",
                **live.ids(),
            )
        return flagged

    async def _watchdog_loop(self) -> None:
        while True:
            minutes = await self._setting_float(SETTING_STALL_MINUTES, DEFAULT_STALL_MINUTES)
            # at most 5 s so a changed setting takes effect quickly; checks are in-memory and cheap
            interval = min(5.0, max(0.05, minutes * 60 / 4)) if minutes > 0 else 5.0
            await asyncio.sleep(interval)
            try:
                await self.check_stalls(minutes)
            except Exception:
                log.exception("stall check failed")


def _safe_native_id(handle: AgentSessionHandle) -> str | None:
    try:
        return handle.native_id
    except Exception:
        return None
