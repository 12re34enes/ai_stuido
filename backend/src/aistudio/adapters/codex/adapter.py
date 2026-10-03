"""CodexAdapter: drives ``codex app-server`` (stdio JSON-RPC, protocol v2) through a Transport.

Process model: one app-server process per session (a thread). A process could host several
threads, but per-session processes keep cwd/env/sandbox isolated, contain crashes to one agent and
behave identically over SSH. Short-lived processes answer discovery, history and limit probes.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from collections.abc import AsyncIterator, Mapping
from typing import Any

from pydantic import ValidationError

from aistudio import __version__ as studio_version
from aistudio.adapters.codex import discovery
from aistudio.adapters.codex import mapping as m
from aistudio.adapters.codex import protocol as p
from aistudio.adapters.codex.rpc import RpcClosed, RpcConnection, RpcError
from aistudio.adapters.codex.session import CodexSession
from aistudio.contracts.agents import (
    AdapterHealth,
    AgentErrorEv,
    AgentEventPayload,
    AgentEventSink,
    AgentSessionHandle,
    AgentState,
    NativeSessionInfo,
    PermissionHandler,
    SessionSpec,
    SessionStarted,
    StatusChanged,
)
from aistudio.contracts.common import Location, Provider
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolHost
from aistudio.contracts.transport import Transport
from aistudio.core.errors import NotFound, StudioError, Unavailable

log = logging.getLogger(__name__)

# Removed from the agent environment: API keys would make codex bill the API instead of using the
# ChatGPT subscription login, and the SSH agent must never be reachable by agents (spec §8).
STRIPPED_ENV = frozenset(
    {
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "AZURE_OPENAI_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
    }
)
CANDIDATE_PATHS = (
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "~/.local/bin/codex",
    "~/.npm-global/bin/codex",
    "~/.volta/bin/codex",
    "~/.bun/bin/codex",
)
INSTALL_HINT = "Kurmak için: npm install -g @openai/codex"
RPC_TIMEOUT = 60.0
PROBE_TIMEOUT = 30.0
PAGE_SIZE = 100
TURN_PAGE_SIZE = 50
MAX_HISTORY_TURNS = 5000


class CodexAdapter:
    provider: Provider = "codex"

    def __init__(
        self,
        *,
        command: list[str] | None = None,
        base_env: Mapping[str, str] | None = None,
        app_server_args: list[str] | None = None,
        client_name: str = "aistudio",
    ) -> None:
        """``command``: argv prefix for the CLI (default: ``codex`` resolved on the transport).
        ``base_env``: environment to start from instead of ``os.environ`` / the remote env (tests)."""
        self._command = list(command) if command else None
        self._base_env = dict(base_env) if base_env is not None else None
        self._app_server_args = list(app_server_args or [])
        self._client_name = client_name

    # ================================================================== health

    async def health(self, transport: Transport) -> AdapterHealth:
        tested = p.TESTED_RANGE
        try:
            command = await self._resolve_command(transport)
        except Exception as e:
            return AdapterHealth(
                provider="codex", installed=False, tested_range=tested, message=f"Codex CLI aranamadı: {e}"
            )
        if command is None:
            return AdapterHealth(
                provider="codex",
                installed=False,
                tested_range=tested,
                message=f"Codex CLI bulunamadı. {INSTALL_HINT}",
            )
        binary = command[-1] if self._command else command[0]
        env = await self._env(transport, command, None)
        health = AdapterHealth(provider="codex", installed=True, binary=binary, tested_range=tested)
        problems: list[str] = []
        try:
            res = await transport.run([*command, "--version"], env=env, timeout=20)
            version = m.parse_version(res.stdout + res.stderr)
            if res.returncode != 0 or version is None:
                problems.append("Codex CLI sürümü okunamadı.")
            else:
                health.version = ".".join(map(str, version))
                health.compatible = m.is_compatible(version)
                if not health.compatible:
                    problems.append(
                        f"Codex CLI {health.version} test edilen aralığın ({tested}) dışında; "
                        "beklenmedik sorunlar olabilir."
                    )
        except Exception as e:
            problems.append(f"Codex CLI çalıştırılamadı: {e}")
        try:
            res = await transport.run([*command, "login", "status"], env=env, timeout=20)
            out = (res.stdout + "\n" + res.stderr).lower()
            health.logged_in = res.returncode == 0 and "not logged in" not in out
            if not health.logged_in:
                problems.append("Codex'e giriş yapılmamış. Terminalde `codex login` çalıştırın.")
            elif "api key" in out:
                problems.append(
                    "Codex API anahtarıyla giriş yapmış; abonelik kullanımı için `codex login` ile "
                    "ChatGPT hesabınızla giriş yapın."
                )
        except Exception as e:
            problems.append(f"Codex giriş durumu okunamadı: {e}")
        health.message = " ".join(problems) or None
        return health

    # ================================================================== sessions

    async def start(
        self,
        spec: SessionSpec,
        *,
        transport: Transport,
        sink: AgentEventSink,
        tools: ToolHost,
        permissions: PermissionHandler,
    ) -> AgentSessionHandle:
        exposed = m.exposed_tool_specs(tools.specs(), spec)
        session = CodexSession(
            spec=spec, sink=sink, tools=tools, permissions=permissions, tool_names={s.name for s in exposed}
        )
        await session.emit(StatusChanged(state=AgentState.starting))
        try:
            command = await self._resolve_command(transport)
            if command is None:
                raise Unavailable(f"Codex CLI bulunamadı. {INSTALL_HINT}")
            env = await self._env(transport, command, spec.env)
            proc = await transport.spawn([*command, "app-server", *self._app_server_args], cwd=spec.cwd, env=env)
        except Unavailable:
            await session.set_state(AgentState.error, "Codex bulunamadı.")
            raise
        except Exception as e:
            await session.set_state(AgentState.error, "Codex başlatılamadı.")
            raise Unavailable(f"Codex app-server başlatılamadı: {e}") from e
        conn = RpcConnection(
            proc,
            on_notification=session.on_notification,
            on_request=session.on_request,
            on_closed=session.on_closed,
            label="codex",
        )
        session.attach(conn)
        conn.start()
        try:
            cli_version = await self._initialize(conn)
            resp = await self._open_thread(conn, spec, exposed)
        except Exception as e:
            await conn.close(grace=2.0)
            message = _error_text(e)
            if conn.stderr_tail:
                message += f"\n{conn.stderr_tail[-800:]}"
            await session.emit(AgentErrorEv(message=f"Codex oturumu başlatılamadı: {message}", code="start_failed"))
            await session.set_state(AgentState.error, "Codex oturumu başlatılamadı.")
            if isinstance(e, RpcError) and spec.resume_native_id:
                raise NotFound(f"Codex oturumu açılamadı ({spec.resume_native_id}): {e.message}") from e
            raise Unavailable(f"Codex oturumu başlatılamadı: {message}") from e
        thread = resp.thread
        session.mark_started(thread.id, model=resp.model, cli_version=cli_version or thread.cli_version)
        if spec.title and (not spec.resume_native_id or spec.fork):
            with contextlib.suppress(RpcError, RpcClosed, TimeoutError):
                await conn.request(
                    "thread/name/set", p.ThreadSetNameParams(thread_id=thread.id, name=spec.title).wire(), timeout=10
                )
        await session.emit(
            SessionStarted(
                native_id=thread.id, model=resp.model, cwd=resp.cwd or spec.cwd, cli_version=session.cli_version
            )
        )
        await session.set_state(AgentState.idle)
        return session

    async def _initialize(self, conn: RpcConnection) -> str | None:
        params = p.InitializeParams(
            client_info=p.ClientInfo(name=self._client_name, title="AI Studio", version=studio_version),
            capabilities=p.InitializeCapabilities(experimental_api=True, request_attestation=False),
        )
        raw = await conn.request("initialize", params.wire(), timeout=RPC_TIMEOUT)
        await conn.notify("initialized")
        try:
            return m.version_from_user_agent(p.InitializeResponse.model_validate(raw).user_agent)
        except ValidationError:
            return None

    async def _open_thread(self, conn: RpcConnection, spec: SessionSpec, exposed: list[Any]) -> p.ThreadStartResponse:
        overrides = m.thread_overrides(spec)
        if spec.resume_native_id and spec.fork:
            raw = await conn.request(
                "thread/fork",
                p.ThreadForkParams(thread_id=spec.resume_native_id, exclude_turns=True, **overrides).wire(),
                timeout=RPC_TIMEOUT,
            )
            return p.ThreadForkResponse.model_validate(raw)
        if spec.resume_native_id:
            # Dynamic tools are persisted with the thread (session_meta.dynamic_tools) and cannot be
            # changed on resume; threads created outside AI Studio have none.
            raw = await conn.request(
                "thread/resume",
                p.ThreadResumeParams(thread_id=spec.resume_native_id, exclude_turns=True, **overrides).wire(),
                timeout=RPC_TIMEOUT,
            )
            return p.ThreadResumeResponse.model_validate(raw)
        tools = m.dynamic_tools(exposed)
        raw = await conn.request(
            "thread/start", p.ThreadStartParams(dynamic_tools=tools or None, **overrides).wire(), timeout=RPC_TIMEOUT
        )
        return p.ThreadStartResponse.model_validate(raw)

    # ================================================================== discovery / history / limits

    async def list_native_sessions(
        self, transport: Transport, *, cwd: str | None = None, limit: int = 200
    ) -> list[NativeSessionInfo]:
        location = _location(transport)
        try:
            async with self._probe(transport) as conn:
                out: list[NativeSessionInfo] = []
                cursor: str | None = None
                while len(out) < limit:
                    params = p.ThreadListParams(
                        cursor=cursor,
                        limit=min(PAGE_SIZE, limit - len(out)),
                        sort_key="updated_at",
                        sort_direction="desc",
                        source_kinds=m.LIST_SOURCE_KINDS,
                        cwd=cwd,
                    )
                    raw = await conn.request("thread/list", params.wire(), timeout=RPC_TIMEOUT)
                    resp = p.ThreadListResponse.model_validate(raw)
                    out.extend(m.native_session_info(t, location) for t in resp.data)
                    cursor = resp.next_cursor
                    if not cursor or not resp.data:
                        break
                return out[:limit]
        except Exception as e:  # best effort: any CLI or transport failure
            log.info("codex: thread/list failed (%s); scanning rollout files", _error_text(e))
            return await discovery.scan_rollouts(transport, location=location, cwd=cwd, limit=limit)

    async def read_native_history(
        self, transport: Transport, native_id: str, *, cwd: str | None = None
    ) -> list[AgentEventPayload]:
        try:
            async with self._probe(transport) as conn:
                raw = await conn.request(
                    "thread/read",
                    p.ThreadReadParams(thread_id=native_id, include_turns=False).wire(),
                    timeout=RPC_TIMEOUT,
                )
                thread = p.ThreadReadResponse.model_validate(raw).thread
                turns: list[p.Turn] = []
                cursor: str | None = None
                while len(turns) < MAX_HISTORY_TURNS:
                    params = p.ThreadTurnsListParams(
                        thread_id=native_id,
                        cursor=cursor,
                        limit=TURN_PAGE_SIZE,
                        sort_direction="asc",
                        items_view="full",
                    )
                    page = p.ThreadTurnsListResponse.model_validate(
                        await conn.request("thread/turns/list", params.wire(), timeout=RPC_TIMEOUT)
                    )
                    turns.extend(page.data)
                    cursor = page.next_cursor
                    if not cursor or not page.data:
                        break
        except RpcError as e:
            raise NotFound(f"Codex oturumu okunamadı ({native_id}): {e.message}") from e
        except StudioError:
            raise
        except Exception as e:
            raise Unavailable(f"Codex oturum geçmişi okunamadı: {_error_text(e)}") from e
        return m.history_payloads(thread, turns)

    async def read_limits(self, transport: Transport) -> list[LimitWindow]:
        """``account/rateLimits/read`` on a short-lived app-server; costs no quota."""
        try:
            async with self._probe(transport) as conn:
                raw = await conn.request(
                    "account/rateLimits/read",
                    p.GetAccountRateLimitsParams(exclude_reset_credit_details=True).wire(),
                    timeout=PROBE_TIMEOUT,
                )
                return m.limit_windows_from_read(p.GetAccountRateLimitsResponse.model_validate(raw))
        except Exception as e:  # best effort: any CLI or transport failure
            log.info("codex: rate limits unavailable: %s", _error_text(e))
            return []

    async def read_account(self, transport: Transport) -> p.GetAccountResponse | None:
        """``account/read`` (works without login: ``account`` is null then)."""
        try:
            async with self._probe(transport) as conn:
                raw = await conn.request("account/read", p.GetAccountParams().wire(), timeout=PROBE_TIMEOUT)
                return p.GetAccountResponse.model_validate(raw)
        except Exception as e:  # best effort: any CLI or transport failure
            log.info("codex: account/read failed: %s", _error_text(e))
            return None

    @contextlib.asynccontextmanager
    async def _probe(self, transport: Transport) -> AsyncIterator[RpcConnection]:
        command = await self._resolve_command(transport)
        if command is None:
            raise Unavailable(f"Codex CLI bulunamadı. {INSTALL_HINT}")
        env = await self._env(transport, command, None)
        proc = await transport.spawn([*command, "app-server", *self._app_server_args], env=env)
        conn = RpcConnection(proc, label="codex-probe")
        conn.start()
        try:
            await asyncio.wait_for(self._initialize(conn), PROBE_TIMEOUT)
            yield conn
        finally:
            await conn.close(grace=3.0)

    # ================================================================== process setup

    async def _resolve_command(self, transport: Transport) -> list[str] | None:
        if self._command:
            return list(self._command)
        found = await transport.which("codex")
        if found:
            return [found]
        home = await transport.home()
        for candidate in CANDIDATE_PATHS:
            path = candidate.replace("~", home, 1) if candidate.startswith("~") else candidate
            if await transport.exists(path):
                return [path]
        return None

    async def _env(
        self, transport: Transport, command: list[str], extra: Mapping[str, str] | None
    ) -> dict[str, str] | None:
        """Complete environment for the CLI process (Transport.spawn expects the full env)."""
        if self._base_env is not None:
            base: dict[str, str] | None = dict(self._base_env)
        elif transport.kind == "local":
            # LocalTransport.env is the scrubbed allowlist environment (spec §8); bare transports
            # (tests) fall back to os.environ.
            transport_env = getattr(transport, "env", None)
            base = dict(transport_env) if isinstance(transport_env, Mapping) else dict(os.environ)
        else:
            base = await _remote_env(transport)
        if base is None:
            if extra:
                log.warning("codex: could not read the remote environment; extra env vars are not applied")
            return None
        env = {k: v for k, v in base.items() if k not in STRIPPED_ENV}
        env["PATH"] = m.env_path_with(command[0], env.get("PATH"))
        if extra:
            env.update(extra)
        return env


async def _remote_env(transport: Transport) -> dict[str, str] | None:
    try:
        res = await transport.run(["env"], timeout=15)
    except Exception as e:
        log.info("codex: remote env failed: %s", e)
        return None
    if res.returncode != 0:
        return None
    env: dict[str, str] = {}
    last: str | None = None
    for line in res.stdout.splitlines():
        key, sep, value = line.partition("=")
        if sep and key and key.replace("_", "").isalnum():
            env[key] = value
            last = key
        elif last is not None:  # continuation of a multi-line value
            env[last] += "\n" + line
    return env or None


def _location(transport: Transport) -> Location:
    if transport.kind == "ssh" and transport.host_id:
        return Location.remote(transport.host_id)
    return Location.local()


def _error_text(e: BaseException) -> str:
    if isinstance(e, RpcError):
        return e.message
    if isinstance(e, TimeoutError):
        return "zaman aşımı"
    return str(e) or type(e).__name__
