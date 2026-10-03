"""``ClaudeAdapter``: the :class:`AgentAdapter` for Claude Code CLI 2.1.x.

Everything goes through the given :class:`Transport`, so the same code drives a local process
or one on an SSH host (spec §2, §6).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import posixpath
import uuid
from collections.abc import Mapping, Sequence
from typing import Any

from aistudio.adapters.claude import protocol
from aistudio.adapters.claude.config import (
    ENTRYPOINT,
    SCRUBBED_ENV,
    LaunchOptions,
    build_argv,
    probe_argv,
    scrub_env,
)
from aistudio.adapters.claude.history import (
    SNAPSHOT_SCRIPT,
    STAT_SCRIPT,
    FileSnapshot,
    history_payloads,
    new_marker,
    parse_snapshot_output,
    parse_stat_output,
    project_dir_name,
    session_info,
    snapshot_from_text,
    valid_session_id,
)
from aistudio.adapters.claude.limits import windows_from_usage_response
from aistudio.adapters.claude.protocol import TESTED_RANGE, as_dict, as_str
from aistudio.adapters.claude.session import ClaudeSession
from aistudio.contracts.agents import (
    AdapterHealth,
    AgentEventPayload,
    AgentEventSink,
    NativeSessionInfo,
    PermissionHandler,
    SessionSpec,
)
from aistudio.contracts.common import Location, Provider
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolHost
from aistudio.contracts.transport import Process, Transport
from aistudio.core.clock import utcnow
from aistudio.core.errors import NotFound, Unavailable, ValidationFailed

log = logging.getLogger(__name__)

# Where the CLI usually lives when it is not on the (often minimal, launchd) PATH.
BINARY_CANDIDATES: tuple[str, ...] = (
    "~/.claude/local/claude",
    "~/.local/bin/claude",
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "~/.npm-global/bin/claude",
    "~/.bun/bin/claude",
    "~/.volta/bin/claude",
)
INSTALL_HINT = "Kurulum için terminalde `curl -fsSL https://claude.ai/install.sh | bash` çalıştırın."
LOGIN_HINT = "Giriş için terminalde `claude auth login` çalıştırın."

_STAT_CHUNK = 300
_SNAPSHOT_CHUNK = 40
_READ_CONCURRENCY = 8


def _transport_key(transport: Transport) -> str:
    return f"{transport.kind}:{transport.host_id or ''}"


class ClaudeAdapter:
    provider: Provider = "claude"

    def __init__(
        self,
        *,
        binary: str | Sequence[str] | None = None,
        base_env: Mapping[str, str] | None = None,
        options: LaunchOptions | None = None,
        config_dir: str | None = None,
        init_timeout: float = 90.0,
        close_timeout: float = 10.0,
        command_timeout: float = 30.0,
        probe_timeout: float = 45.0,
    ) -> None:
        """``binary``: path or argv prefix (e.g. ``[python, fake_claude.py]`` in tests); None =
        discover. ``base_env``: environment for local processes before scrubbing (None = the
        current ``os.environ``). ``config_dir``: Claude config dir (None = ``~/.claude`` or
        ``CLAUDE_CONFIG_DIR``)."""
        if isinstance(binary, str):
            self._binary: list[str] | None = [binary]
        else:
            self._binary = list(binary) if binary else None
        self._base_env = dict(base_env) if base_env is not None else None
        self._options = options or LaunchOptions()
        self._config_dir = config_dir
        self._init_timeout = init_timeout
        self._close_timeout = close_timeout
        self._command_timeout = command_timeout
        self._probe_timeout = probe_timeout
        self._resolved: dict[str, list[str]] = {}
        self._versions: dict[str, str] = {}
        self._live: dict[str, ClaudeSession] = {}

    # ------------------------------------------------------------------ environment / binary

    def _local_env(self, extra: Mapping[str, str], transport: Transport | None = None) -> dict[str, str]:
        # Prefer the transport's scrubbed base environment (LocalTransport.env: allowlist without
        # SSH agent / cloud credentials); fall back to os.environ for bare test transports.
        transport_env = getattr(transport, "env", None)
        if self._base_env is not None:
            base = dict(self._base_env)
        elif isinstance(transport_env, Mapping):
            base = dict(transport_env)
        else:
            base = dict(os.environ)
        env = scrub_env(base)
        env.update(extra)
        return env

    def _command(
        self, transport: Transport, argv: list[str], extra_env: Mapping[str, str] | None = None
    ) -> tuple[list[str], dict[str, str] | None]:
        """Final argv + env. Local: a complete scrubbed environment. Remote: the host's default
        environment, adjusted through an ``env -u ... K=V`` prefix (POSIX on Linux and macOS)."""
        extra = dict(extra_env or {})
        if transport.kind == "local":
            return argv, self._local_env(extra, transport)
        prefix = ["env"]
        for name in sorted(SCRUBBED_ENV):
            prefix += ["-u", name]
        extra.setdefault("CLAUDE_CODE_ENTRYPOINT", ENTRYPOINT)
        prefix += [f"{k}={v}" for k, v in extra.items()]
        return [*prefix, *argv], None

    async def _resolve_binary(self, transport: Transport) -> list[str] | None:
        if self._binary:
            return self._binary
        key = _transport_key(transport)
        if key in self._resolved:
            return self._resolved[key]
        found = await transport.which("claude")
        if not found:
            home = await transport.home()
            for cand in BINARY_CANDIDATES:
                path = home + cand[1:] if cand.startswith("~") else cand
                if await transport.exists(path):
                    found = path
                    break
        if not found:
            return None
        self._resolved[key] = [found]
        return self._resolved[key]

    # ------------------------------------------------------------------ health

    async def health(self, transport: Transport) -> AdapterHealth:
        binary = await self._resolve_binary(transport)
        if binary is None:
            return AdapterHealth(
                provider="claude",
                installed=False,
                tested_range=TESTED_RANGE,
                message=f"Claude Code CLI bulunamadı. {INSTALL_HINT}",
            )
        display = " ".join(binary)
        argv, env = self._command(transport, [*binary, "--version"])
        try:
            proc = await transport.run(argv, env=env, timeout=self._command_timeout)
        except Exception as e:
            return AdapterHealth(
                provider="claude",
                installed=True,
                binary=display,
                tested_range=TESTED_RANGE,
                message=f"Claude Code CLI çalıştırılamadı: {e}",
            )
        version = protocol.parse_version(proc.stdout) or protocol.parse_version(proc.stderr)
        version_text = protocol.format_version(version) if version else None
        if version_text:
            self._versions[_transport_key(transport)] = version_text
        compatible = protocol.version_in_tested_range(version) if version else None
        logged_in, auth_method = await self._auth_status(transport, binary)

        problems: list[str] = []
        if version is None:
            problems.append("Claude Code sürümü okunamadı.")
        elif not compatible:
            problems.append(
                f"Claude Code {version_text} sürümü test edilen aralığın ({TESTED_RANGE}) dışında; sorun çıkabilir."
            )
        if logged_in is False:
            problems.append(f"Claude Code'a giriş yapılmamış. {LOGIN_HINT}")
        elif auth_method and "api" in auth_method.lower() and "key" in auth_method.lower():
            problems.append("Claude Code abonelik yerine API anahtarıyla giriş yapmış; kullanım ücretlendirilebilir.")
        return AdapterHealth(
            provider="claude",
            installed=True,
            binary=display,
            version=version_text,
            logged_in=logged_in,
            compatible=compatible,
            tested_range=TESTED_RANGE,
            message=" ".join(problems) or None,
        )

    async def _auth_status(self, transport: Transport, binary: list[str]) -> tuple[bool | None, str | None]:
        """``claude auth status --json`` (local check, no model call): ``{"loggedIn": bool,
        "authMethod": ...}``. Exit code is non-zero when logged out, so parse regardless."""
        argv, env = self._command(transport, [*binary, "auth", "status", "--json"])
        try:
            proc = await transport.run(argv, env=env, timeout=self._command_timeout)
        except Exception as e:
            log.info("claude auth status failed: %s", e)
            return None, None
        text = proc.stdout.strip()
        start = text.find("{")
        if start < 0:
            return None, None
        try:
            data = json.loads(text[start:])
        except ValueError:
            return None, None
        if not isinstance(data, dict):
            return None, None
        logged = data.get("loggedIn")
        return (logged if isinstance(logged, bool) else None), as_str(data.get("authMethod"))

    # ------------------------------------------------------------------ sessions

    async def start(
        self,
        spec: SessionSpec,
        *,
        transport: Transport,
        sink: AgentEventSink,
        tools: ToolHost,
        permissions: PermissionHandler,
    ) -> ClaudeSession:
        binary = await self._resolve_binary(transport)
        if binary is None:
            raise Unavailable(f"Claude Code CLI bulunamadı. {INSTALL_HINT}")
        if spec.resume_native_id and not valid_session_id(spec.resume_native_id):
            raise ValidationFailed("Geçersiz Claude oturum kimliği.")
        if spec.resume_native_id and not spec.fork:
            live = self._live.get(spec.resume_native_id)
            if live is not None and not live.closed:
                raise Unavailable("Bu Claude oturumu zaten çalışıyor.")
        native_id = spec.resume_native_id if spec.resume_native_id and not spec.fork else str(uuid.uuid4())
        argv, env = self._command(
            transport, build_argv(binary, spec, session_id=native_id, options=self._options), spec.env
        )
        try:
            proc = await transport.spawn(argv, cwd=spec.cwd, env=env)
        except Exception as e:
            raise Unavailable(f"Claude Code başlatılamadı: {e}") from e
        session = ClaudeSession(
            proc=proc,
            spec=spec,
            sink=sink,
            tools=tools,
            permissions=permissions,
            native_id=native_id,
            cli_version=self._versions.get(_transport_key(transport)),
            on_closed=self._forget,
            init_timeout=self._init_timeout,
            close_timeout=self._close_timeout,
        )
        self._live[native_id] = session
        try:
            await session.start()
        except BaseException:
            self._live.pop(native_id, None)
            raise
        return session

    def _forget(self, session: ClaudeSession) -> None:
        for key, value in list(self._live.items()):
            if value is session:
                del self._live[key]

    # ------------------------------------------------------------------ discovery

    async def _projects_dir(self, transport: Transport) -> str:
        if self._config_dir:
            return posixpath.join(self._config_dir, "projects")
        if transport.kind == "local":
            base = self._base_env if self._base_env is not None else os.environ
            custom = base.get("CLAUDE_CONFIG_DIR")
            if custom:
                return posixpath.join(custom, "projects")
        home = await transport.home()
        return posixpath.join(home, ".claude", "projects")

    def _location(self, transport: Transport) -> Location:
        if transport.kind == "local":
            return Location.local()
        return Location.remote(transport.host_id or "")

    async def list_native_sessions(
        self, transport: Transport, *, cwd: str | None = None, limit: int = 200
    ) -> list[NativeSessionInfo]:
        projects = await self._projects_dir(transport)
        want_cwd = posixpath.normpath(cwd) if cwd else None
        paths: list[str] = []
        if want_cwd:
            name = project_dir_name(want_cwd)
            pattern = f"{name}*" if name.endswith("-") and len(name) > 200 else name
            paths = await transport.glob(posixpath.join(projects, pattern, "*.jsonl"))
        if not paths:
            paths = await transport.glob(posixpath.join(projects, "*", "*.jsonl"))
        if not paths:
            return []
        stats = await self._stat(transport, paths)
        ordered = sorted(paths, key=lambda p: stats.get(p, (0.0, 0))[0], reverse=True)
        location = self._location(transport)
        out: list[NativeSessionInfo] = []
        for start in range(0, len(ordered), _SNAPSHOT_CHUNK):
            chunk = ordered[start : start + _SNAPSHOT_CHUNK]
            for snap in await self._snapshots(transport, chunk):
                st = stats.get(snap.path)
                if st is not None:
                    snap.mtime, snap.size = st
                info = session_info(snap, location=location)
                if info is None:
                    continue
                if want_cwd and (not info.cwd or posixpath.normpath(info.cwd) != want_cwd):
                    continue
                live = self._live.get(info.native_id)
                info.running = live is not None and not live.closed
                out.append(info)
                if len(out) >= limit:
                    return out
        return out

    async def _stat(self, transport: Transport, paths: list[str]) -> dict[str, tuple[float, int]]:
        stats: dict[str, tuple[float, int]] = {}
        for start in range(0, len(paths), _STAT_CHUNK):
            chunk = paths[start : start + _STAT_CHUNK]
            try:
                proc = await transport.run(["sh", "-c", STAT_SCRIPT, "sh", *chunk], timeout=self._command_timeout)
            except Exception as e:
                log.info("claude: stat of session files failed: %s", e)
                return stats
            stats.update(parse_stat_output(proc.stdout))
        return stats

    async def _snapshots(self, transport: Transport, paths: list[str]) -> list[FileSnapshot]:
        marker = new_marker()
        try:
            proc = await transport.run(
                ["sh", "-c", SNAPSHOT_SCRIPT, "sh", marker, *paths], timeout=self._command_timeout * 2
            )
            snaps = parse_snapshot_output(proc.stdout, marker)
            if len(snaps) == len(paths):
                return snaps
            log.info("claude: snapshot script returned %d of %d files; reading files", len(snaps), len(paths))
        except Exception as e:
            log.info("claude: snapshot script failed (%s); reading files", e)
        sem = asyncio.Semaphore(_READ_CONCURRENCY)

        async def read(path: str) -> FileSnapshot | None:
            async with sem:
                try:
                    data = await transport.read_file(path)
                except Exception as e:
                    log.info("claude: cannot read %s: %s", path, e)
                    return None
            return snapshot_from_text(path, data.decode("utf-8", errors="replace"))

        results = await asyncio.gather(*(read(p) for p in paths))
        return [s for s in results if s is not None]

    async def _find_session_file(self, transport: Transport, native_id: str, cwd: str | None) -> str | None:
        projects = await self._projects_dir(transport)
        if cwd:
            name = project_dir_name(posixpath.normpath(cwd))
            if not name.endswith("-") or len(name) <= 200:
                path = posixpath.join(projects, name, f"{native_id}.jsonl")
                if await transport.exists(path):
                    return path
        matches = await transport.glob(posixpath.join(projects, "*", f"{native_id}.jsonl"))
        return matches[0] if matches else None

    async def read_native_history(
        self, transport: Transport, native_id: str, *, cwd: str | None = None
    ) -> list[AgentEventPayload]:
        if not valid_session_id(native_id):
            raise ValidationFailed("Geçersiz Claude oturum kimliği.")
        path = await self._find_session_file(transport, native_id, cwd)
        if path is None:
            raise NotFound(f"Claude oturumu bulunamadı: {native_id}")
        data = await transport.read_file(path)
        return history_payloads(data.decode("utf-8", errors="replace"), native_id)

    # ------------------------------------------------------------------ limits

    async def read_limits(self, transport: Transport) -> list[LimitWindow]:
        """Plan limits via the ``get_usage`` control request on a throwaway process that never
        runs a model turn (and writes no transcript). Experimental CLI API: [] on any failure."""
        binary = await self._resolve_binary(transport)
        if binary is None:
            return []
        argv, env = self._command(transport, probe_argv(binary))
        try:
            proc = await transport.spawn(argv, cwd=await transport.home(), env=env)
        except Exception as e:
            log.info("claude: usage probe could not start: %s", e)
            return []
        try:
            async with asyncio.timeout(self._probe_timeout):
                await _probe_request(proc, "init", {"subtype": "initialize"})
                usage = await _probe_request(proc, "usage", {"subtype": "get_usage", "skip_behaviors": True})
        except Exception as e:
            log.info("claude: usage probe failed: %s", e)
            return []
        finally:
            await _stop_process(proc)
        return windows_from_usage_response(usage, observed_at=utcnow())


async def _probe_request(proc: Process, req_id: str, request: dict[str, Any]) -> dict[str, Any]:
    """Write one control request and read stdout until its response (other lines ignored)."""
    await proc.write(protocol.encode(protocol.control_request(req_id, request)))
    while True:
        line = await proc.readline()
        if not line:
            raise Unavailable("Claude süreci yanıt vermeden kapandı.")
        try:
            msg = protocol.decode(line)
        except ValueError:
            continue
        if msg is None:
            continue
        if msg.get("type") == "control_request":  # nothing is expected; refuse politely
            rid = as_str(msg.get("request_id"))
            if rid:
                await proc.write(protocol.encode(protocol.control_error(rid, "not supported by usage probe")))
            continue
        if msg.get("type") != "control_response":
            continue
        response = as_dict(msg.get("response"))
        if response.get("request_id") != req_id:
            continue
        if response.get("subtype") == "error":
            raise Unavailable(as_str(response.get("error")) or "control request failed")
        return as_dict(response.get("response"))


async def _stop_process(proc: Process) -> None:
    with contextlib.suppress(Exception):
        await proc.close_stdin()
    try:
        await asyncio.wait_for(proc.wait(), 5.0)
        return
    except Exception:
        pass
    with contextlib.suppress(Exception):
        await proc.terminate()
    try:
        await asyncio.wait_for(proc.wait(), 3.0)
    except Exception:
        with contextlib.suppress(Exception):
            await proc.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(proc.wait(), 3.0)
