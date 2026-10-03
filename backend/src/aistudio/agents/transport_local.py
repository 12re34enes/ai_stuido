"""Local process/file transport and the scrubbed agent environment.

``LocalTransport`` implements :class:`aistudio.contracts.transport.Transport` with asyncio
subprocesses. Agent CLIs stream JSON lines that can be several megabytes long (tool results,
file contents), so stdout lines are read without a size cap. stderr is drained continuously in
the background (bounded buffer) so a chatty child can never block on a full pipe.

Children are started in their own session/process group so ``terminate``/``kill`` also reach
the tools and MCP servers the CLI spawned.

``scrubbed_env`` builds the environment agents run with (spec §8, layer 4): only an allowlist
of harmless variables survives, so agents use the CLI's own subscription login and cannot reach
remote systems directly (no ``SSH_AUTH_SOCK``, no cloud or API credentials).
"""

from __future__ import annotations

import asyncio
import contextlib
import glob as globlib
import os
import re
import shutil
import signal
import tempfile
import time
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Literal

from aistudio.contracts.transport import CompletedProcess

# asyncio StreamReader buffer limit; lines longer than this are still read (in chunks).
STDOUT_LIMIT = 16 * 1024 * 1024
STDERR_KEEP_BYTES = 1024 * 1024
_STDERR_DRAIN_GRACE = 2.0

# --------------------------------------------------------------------------- environment

_KEEP_EXACT = frozenset(
    {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"}
)
_KEEP_PREFIXES = ("LC_",)

_SENSITIVE_EXACT = frozenset(
    {
        "SSH_AUTH_SOCK",
        "SSH_AGENT_PID",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GITLAB_TOKEN",
        "GL_TOKEN",
        "NPM_TOKEN",
        "KUBECONFIG",
        "DOCKER_HOST",
        "DOCKER_CONTEXT",
        "DOCKER_CONFIG",
        "CONTAINER_HOST",
        "DATABASE_URL",
        "REDIS_URL",
        "MONGODB_URI",
        "MONGO_URL",
        "GPG_AGENT_INFO",
        "GIT_ASKPASS",
        "SSH_ASKPASS",
        "SUDO_ASKPASS",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
    }
)
_SENSITIVE_PREFIXES = (
    "SSH_",
    "AWS_",
    "GOOGLE_",
    "GCLOUD_",
    "GCP_",
    "CLOUDSDK_",
    "AZURE_",
    "ARM_",
    "DIGITALOCEAN_",
    "HEROKU_",
    "VAULT_",
    "PG",  # PGPASSWORD, PGHOST, ...
    "MYSQL_",
    "MONGO",
    "REDIS_",
    "OP_",  # 1Password CLI session
)
_SENSITIVE_SUFFIXES = (
    "_TOKEN",
    "_SECRET",
    "_PASSWORD",
    "_PASSWD",
    "_PASS",
    "_PWD",
    "_API_KEY",
    "_APIKEY",
    "_ACCESS_KEY",
    "_PRIVATE_KEY",
    "_CREDENTIALS",
    "_CREDENTIAL",
    "_AUTH",
    "_SESSION",
    "_COOKIE",
    "_DSN",
)
_SENSITIVE_PARTS = re.compile(r"SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|PRIVATE_?KEY|API_?KEY|ACCESS_?KEY")

# Common install locations of the agent CLIs and their runtimes (studiod may run under launchd
# with a minimal PATH). Only directories that exist are appended.
_EXTRA_PATH_DIRS = (
    "~/.local/bin",
    "~/.claude/local",
    "~/.npm-global/bin",
    "~/.bun/bin",
    "~/.volta/bin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
)
_FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def is_sensitive_env_name(name: str) -> bool:
    """True for variables that may carry credentials or grant direct remote access."""
    upper = name.upper()
    if upper in _SENSITIVE_EXACT:
        return True
    if upper.startswith(_SENSITIVE_PREFIXES) or upper.endswith(_SENSITIVE_SUFFIXES):
        return True
    return bool(_SENSITIVE_PARTS.search(upper))


def _keep(name: str) -> bool:
    if is_sensitive_env_name(name):
        return False
    return name in _KEEP_EXACT or name.startswith(_KEEP_PREFIXES)


def _augment_path(path: str, extra_dirs: Iterable[str]) -> str:
    parts = [p for p in path.split(os.pathsep) if p]
    for raw in extra_dirs:
        d = os.path.expanduser(raw)
        if d not in parts and os.path.isdir(d):
            parts.append(d)
    return os.pathsep.join(parts)


def sanitize_extra_env(extra: Mapping[str, str] | None) -> dict[str, str]:
    """Drop credential-like names from user/profile supplied extra variables."""
    return {k: v for k, v in (extra or {}).items() if k and not is_sensitive_env_name(k)}


def scrubbed_env(
    source: Mapping[str, str] | None = None,
    *,
    extra: Mapping[str, str] | None = None,
    augment_path: bool = True,
) -> dict[str, str]:
    """The base environment for agent processes.

    Keeps PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_*, TERM, TMPDIR and, when set,
    CLAUDE_CONFIG_DIR / CODEX_HOME. Everything else (SSH agent socket, API keys, cloud
    credentials, tokens, passwords, database URLs...) is dropped. ``extra`` is applied on top
    after the same credential filter.
    """
    src = os.environ if source is None else source
    env = {k: v for k, v in src.items() if _keep(k)}
    env.setdefault("HOME", str(Path.home()))
    path = env.get("PATH") or _FALLBACK_PATH
    env["PATH"] = _augment_path(path, _EXTRA_PATH_DIRS) if augment_path else path
    env.update(sanitize_extra_env(extra))
    return env


# --------------------------------------------------------------------------- process


def _signal_group(proc: asyncio.subprocess.Process, sig: signal.Signals) -> None:
    if proc.returncode is not None:
        return
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        with contextlib.suppress(ProcessLookupError):
            proc.send_signal(sig)


class LocalProcess:
    """:class:`aistudio.contracts.transport.Process` backed by an asyncio subprocess."""

    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self._stderr = bytearray()
        self._read_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()
        self._stderr_task: asyncio.Task[None] | None = (
            asyncio.create_task(self._drain_stderr(), name=f"stderr-{proc.pid}") if proc.stderr else None
        )

    @property
    def pid(self) -> int | None:
        return self._proc.pid

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode

    async def _drain_stderr(self) -> None:
        stream = self._proc.stderr
        assert stream is not None
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                return
            self._stderr.extend(chunk)
            overflow = len(self._stderr) - STDERR_KEEP_BYTES
            if overflow > 0:
                del self._stderr[:overflow]

    async def write(self, data: bytes) -> None:
        stdin = self._proc.stdin
        if stdin is None or stdin.is_closing():
            raise BrokenPipeError("stdin is closed")
        async with self._write_lock:
            stdin.write(data)
            await stdin.drain()

    async def close_stdin(self) -> None:
        stdin = self._proc.stdin
        if stdin is None or stdin.is_closing():
            return
        stdin.close()
        with contextlib.suppress(BrokenPipeError, ConnectionResetError, OSError):
            await stdin.wait_closed()

    async def readline(self) -> bytes:
        stdout = self._proc.stdout
        if stdout is None:
            return b""
        async with self._read_lock:
            parts: list[bytes] = []
            while True:
                try:
                    parts.append(await stdout.readuntil(b"\n"))
                    break
                except asyncio.IncompleteReadError as e:  # EOF: whatever is left (maybe b"")
                    parts.append(e.partial)
                    break
                except asyncio.LimitOverrunError as e:  # very long line: take what is buffered, go on
                    parts.append(await stdout.readexactly(e.consumed))
            return b"".join(parts)

    async def read_stderr(self) -> bytes:
        task = self._stderr_task
        if task is not None and not task.done():
            # Grandchildren may keep the pipe open after the CLI exits; don't wait forever.
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(task), timeout=_STDERR_DRAIN_GRACE)
        return bytes(self._stderr)

    async def wait(self) -> int:
        return await self._proc.wait()

    async def terminate(self) -> None:
        _signal_group(self._proc, signal.SIGTERM)

    async def kill(self) -> None:
        _signal_group(self._proc, signal.SIGKILL)


# --------------------------------------------------------------------------- transport


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


def _glob(pattern: str) -> list[str]:
    expanded = os.path.expanduser(pattern)
    return sorted({os.path.abspath(p) for p in globlib.glob(expanded, recursive=True)})


class LocalTransport:
    """Runs processes and file operations on this Mac."""

    kind: Literal["local", "ssh"] = "local"
    host_id: str | None = None

    def __init__(self, env: Mapping[str, str] | None = None) -> None:
        self._env = dict(env) if env is not None else scrubbed_env()

    @property
    def env(self) -> dict[str, str]:
        """A copy of the default (scrubbed) environment."""
        return dict(self._env)

    async def spawn(
        self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None
    ) -> LocalProcess:
        if not argv:
            raise ValueError("argv must not be empty")
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env if env is not None else self.env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=STDOUT_LIMIT,
            start_new_session=True,
        )
        return LocalProcess(proc)

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        """Run to completion. A missing binary yields returncode 127 (like a shell); a timeout
        kills the whole process group and raises ``TimeoutError``."""
        if not argv:
            raise ValueError("argv must not be empty")
        started = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=cwd,
                env=env if env is not None else self.env,
                stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                limit=STDOUT_LIMIT,
                start_new_session=True,
            )
        except (FileNotFoundError, PermissionError, NotADirectoryError) as e:
            return CompletedProcess(
                argv=argv,
                returncode=127,
                stdout="",
                stderr=str(e),
                duration_ms=int((time.monotonic() - started) * 1000),
            )
        try:
            out, err = await asyncio.wait_for(proc.communicate(input), timeout=timeout)
        except BaseException:  # timeout or cancellation: never leave the group running
            _signal_group(proc, signal.SIGKILL)
            with contextlib.suppress(Exception):
                await asyncio.shield(proc.wait())
            raise
        return CompletedProcess(
            argv=argv,
            returncode=proc.returncode if proc.returncode is not None else -1,
            stdout=out.decode(errors="replace"),
            stderr=err.decode(errors="replace"),
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    async def read_file(self, path: str) -> bytes:
        return await asyncio.to_thread(Path(os.path.expanduser(path)).read_bytes)

    async def write_file(self, path: str, data: bytes) -> None:
        await asyncio.to_thread(_atomic_write, Path(os.path.expanduser(path)), data)

    async def exists(self, path: str) -> bool:
        return await asyncio.to_thread(os.path.exists, os.path.expanduser(path))

    async def glob(self, pattern: str) -> list[str]:
        return await asyncio.to_thread(_glob, pattern)

    async def home(self) -> str:
        return self._env.get("HOME") or str(Path.home())

    async def which(self, binary: str) -> str | None:
        if os.sep in binary:
            path = os.path.expanduser(binary)
            return path if os.path.isfile(path) and os.access(path, os.X_OK) else None
        search = _augment_path(self._env.get("PATH") or _FALLBACK_PATH, _EXTRA_PATH_DIRS)
        return await asyncio.to_thread(shutil.which, binary, path=search)
