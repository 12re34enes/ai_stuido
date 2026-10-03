"""SSH connections (asyncssh): a per-host connection pool with ProxyJump, strict host key
checking, keepalive and reconnect, plus :class:`SSHTransport` implementing
``contracts.transport.Transport`` for agent adapters and gitops.

Commands are sent to the remote login shell as a single string, so argv/env are quoted with
:func:`shlex.quote` and wrapped as ``cd <cwd> && exec env -i K=V ... <argv>`` (sshd normally
ignores environment requests). The login shell must be POSIX-compatible (sh/bash/zsh/dash/ksh).
"""

from __future__ import annotations

import asyncio
import contextlib
import glob as globmod
import logging
import os
import re
import shlex
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

import asyncssh

from aistudio.contracts.transport import CompletedProcess
from aistudio.core.errors import PermissionDenied, Unavailable, ValidationFailed
from aistudio.remote.knownhosts import KnownHostsStore, fingerprint
from aistudio.remote.models import HostRecord

log = logging.getLogger(__name__)

HostLoader = Callable[[str], Awaitable[HostRecord]]
SecretLoader = Callable[[str, str], str | None]

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_BINARY_NAME = re.compile(r"^[A-Za-z0-9._+\-]+$")
_CHANNEL_ERRORS: tuple[type[BaseException], ...] = (
    asyncssh.ChannelOpenError,
    asyncssh.ConnectionLost,
    asyncssh.DisconnectError,
    BrokenPipeError,
    ConnectionResetError,
)
_COMMON_BIN_DIRS = (
    "$HOME/.local/bin",
    "$HOME/.claude/local",
    "$HOME/.npm-global/bin",
    "$HOME/.bun/bin",
    "$HOME/.volta/bin",
    "$HOME/.cargo/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
)


# ----------------------------------------------------------------------------- errors


class HostKeyUnknown(PermissionDenied):
    status_code = 409
    code = "host_key_unknown"


class HostKeyChanged(PermissionDenied):
    code = "host_key_changed"


class HostKeyRevoked(PermissionDenied):
    code = "host_key_revoked"


# ----------------------------------------------------------------------------- pool


class _Client(asyncssh.SSHClient):
    """Records the host key the server offered when it is not in known_hosts (rejecting it)."""

    def __init__(self) -> None:
        super().__init__()
        self.offered: tuple[str, int, asyncssh.SSHKey] | None = None
        self.closed = False

    def validate_host_public_key(self, host: str, addr: str, port: int, key: asyncssh.SSHKey) -> bool:
        self.offered = (addr, port, key)
        return False

    def connection_lost(self, exc: Exception | None) -> None:
        self.closed = True


@dataclass
class _Entry:
    conn: asyncssh.SSHClientConnection
    client: _Client
    sftp: asyncssh.SFTPClient | None = None


class SSHPool:
    def __init__(
        self,
        load_host: HostLoader,
        load_secret: SecretLoader,
        known_hosts: KnownHostsStore,
        *,
        keepalive_interval: float = 15.0,
        connect_timeout: float = 15.0,
    ) -> None:
        self._load_host = load_host
        self._load_secret = load_secret
        self.known_hosts = known_hosts
        self._keepalive = keepalive_interval
        self._connect_timeout = connect_timeout
        self._entries: dict[str, _Entry] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._sftp_locks: dict[str, asyncio.Lock] = {}

    async def connection(self, host_id: str) -> asyncssh.SSHClientConnection:
        return (await self._get(host_id, ())).conn

    async def sftp(self, host_id: str) -> asyncssh.SFTPClient:
        entry = await self._get(host_id, ())
        async with self._sftp_locks.setdefault(host_id, asyncio.Lock()):
            if entry.sftp is None:
                try:
                    entry.sftp = await entry.conn.start_sftp_client()
                except (asyncssh.Error, OSError) as e:
                    raise Unavailable(f"SFTP oturumu açılamadı: {e}") from None
            return entry.sftp

    async def drop(self, host_id: str) -> None:
        entry = self._entries.pop(host_id, None)
        if entry is not None:
            with contextlib.suppress(Exception):
                entry.conn.close()

    async def close(self) -> None:
        entries = list(self._entries.values())
        self._entries.clear()
        for entry in entries:
            with contextlib.suppress(Exception):
                entry.conn.close()
        for entry in entries:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(entry.conn.wait_closed(), 5)

    async def _get(self, host_id: str, chain: tuple[str, ...]) -> _Entry:
        async with self._locks.setdefault(host_id, asyncio.Lock()):
            entry = self._entries.get(host_id)
            if entry is not None and not entry.client.closed and not entry.conn.is_closed():
                return entry
            if entry is not None:
                self._entries.pop(host_id, None)
                with contextlib.suppress(Exception):
                    entry.conn.close()
            host = await self._load_host(host_id)
            entry = await self._connect(host, chain)
            self._entries[host_id] = entry
            return entry

    async def _auth_kwargs(self, host: HostRecord) -> dict[str, Any]:
        # Keychain reads can block: keep them off the event loop.
        if host.auth == "key":
            path = os.path.expanduser(host.key_path or "")
            if not path or not os.path.isfile(path):
                raise ValidationFailed(f"Anahtar dosyası bulunamadı: {host.key_path}")
            passphrase = (
                await asyncio.to_thread(self._load_secret, host.id, "passphrase") if host.has_passphrase else None
            )
            return {"client_keys": [path], "passphrase": passphrase, "agent_path": None}
        if host.auth == "password":
            password = await asyncio.to_thread(self._load_secret, host.id, "password")
            if not password:
                raise ValidationFailed("Bu hostun parolası Anahtar Zinciri'nde bulunamadı.")
            return {"client_keys": None, "password": password}
        return {}  # ssh-agent (SSH_AUTH_SOCK) and default identity files

    async def _tunnel(self, host: HostRecord, chain: tuple[str, ...]) -> asyncssh.SSHClientConnection | None:
        if not host.jump_host_id:
            return None
        if host.jump_host_id in (*chain, host.id):
            raise ValidationFailed("Atlama hostu zinciri döngü oluşturuyor.")
        return (await self._get(host.jump_host_id, (*chain, host.id))).conn

    def _base_kwargs(
        self, host: HostRecord, client: _Client, tunnel: asyncssh.SSHClientConnection | None
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "username": host.username,
            "known_hosts": self.known_hosts.load(),
            "client_factory": lambda: client,
            "config": [],  # never read ~/.ssh/config implicitly; hosts are explicit records
            "keepalive_interval": self._keepalive,
            "keepalive_count_max": 4,
            "connect_timeout": self._connect_timeout,
            "login_timeout": self._connect_timeout * 2,
            "agent_forwarding": False,
        }
        if tunnel is not None:
            kwargs["tunnel"] = tunnel
        return kwargs

    def host_key_error(self, host: HostRecord, client: _Client) -> PermissionDenied | Unavailable:
        if client.offered is None:
            return HostKeyRevoked(
                f"{host.hostname}:{host.port} host anahtarı doğrulanamadı (iptal edilmiş olabilir); "
                "bağlantı reddedildi.",
                details={"host_id": host.id, "hostname": host.hostname, "port": host.port},
            )
        addr, _, key = client.offered
        fp = fingerprint(key)
        details = {
            "host_id": host.id,
            "host_name": host.name,
            "hostname": host.hostname,
            "port": host.port,
            "fingerprint": fp,
            "key_type": key.get_algorithm(),
        }
        if self.known_hosts.is_revoked(host.hostname, host.port, key, addr):
            return HostKeyRevoked("Host anahtarı iptal edilmiş (revoked); bağlantı reddedildi.", details=details)
        trusted, _ = self.known_hosts.trusted(host.hostname, host.port, addr)
        if trusted:
            return HostKeyChanged(
                f"UYARI: {host.hostname}:{host.port} host anahtarı değişmiş! Sunucu farklı bir anahtar sunuyor "
                f"({key.get_algorithm()} {fp}). Bu bir ortadaki adam saldırısı olabilir; bağlantı reddedildi.",
                details=details,
            )
        return HostKeyUnknown(
            f"Bilinmeyen host anahtarı: {host.hostname}:{host.port} ({key.get_algorithm()} {fp}). "
            "Parmak izini doğruladıktan sonra hostu güvenilir olarak ekleyin.",
            details=details,
        )

    async def _connect(self, host: HostRecord, chain: tuple[str, ...]) -> _Entry:
        tunnel = await self._tunnel(host, chain)
        client = _Client()
        kwargs = {**self._base_kwargs(host, client, tunnel), **(await self._auth_kwargs(host))}
        try:
            conn = await asyncssh.connect(host.hostname, host.port, **kwargs)
        except asyncssh.HostKeyNotVerifiable:
            raise self.host_key_error(host, client) from None
        except asyncssh.PermissionDenied:
            raise PermissionDenied(
                f"SSH kimlik doğrulaması başarısız: {host.username}@{host.hostname}",
                details={"host_id": host.id},
            ) from None
        except (asyncssh.KeyImportError, asyncssh.KeyEncryptionError) as e:
            raise ValidationFailed(f"Özel anahtar okunamadı (parola gerekebilir): {e}") from None
        except (OSError, asyncssh.Error, TimeoutError) as e:
            raise Unavailable(
                f"SSH bağlantısı kurulamadı ({host.hostname}:{host.port}): {e}", details={"host_id": host.id}
            ) from None
        return _Entry(conn, client)

    async def probe_host_key(self, host_id: str) -> tuple[HostRecord, asyncssh.SSHKey | None]:
        """The key the server offers if it is NOT yet trusted; ``None`` if it already is.

        Uses the same negotiation as a normal connection and sends no credentials."""
        host = await self._load_host(host_id)
        tunnel = await self._tunnel(host, ())
        client = _Client()
        kwargs = {**self._base_kwargs(host, client, tunnel), "client_keys": None, "password": None}
        try:
            conn = await asyncssh.connect(host.hostname, host.port, **kwargs)
        except asyncssh.HostKeyNotVerifiable:
            if client.offered is None:
                raise self.host_key_error(host, client) from None
            return host, client.offered[2]
        except asyncssh.PermissionDenied:
            return host, None  # key accepted, auth (deliberately) failed
        except (OSError, asyncssh.Error, TimeoutError) as e:
            raise Unavailable(f"SSH bağlantısı kurulamadı ({host.hostname}:{host.port}): {e}") from None
        conn.close()
        return host, None


# ----------------------------------------------------------------------------- output


class OutputCollector:
    """Keeps the head and tail of a stream within ``limit`` bytes (memory stays bounded)."""

    def __init__(self, limit: int) -> None:
        self.limit = max(1024, limit)
        self.head_limit = self.limit * 3 // 4
        self.tail_limit = self.limit - self.head_limit
        self.head = bytearray()
        self.tail = bytearray()
        self.total = 0

    def feed(self, data: bytes) -> None:
        self.total += len(data)
        if len(self.head) < self.head_limit:
            take = self.head_limit - len(self.head)
            self.head += data[:take]
            data = data[take:]
        if data:
            self.tail += data
            if len(self.tail) > self.tail_limit:
                del self.tail[: len(self.tail) - self.tail_limit]

    @property
    def truncated(self) -> bool:
        return self.total > len(self.head) + len(self.tail)

    def text(self) -> str:
        head = self.head.decode(errors="replace")
        tail = self.tail.decode(errors="replace")
        if self.truncated:
            omitted = self.total - len(self.head) - len(self.tail)
            return f"{head}\n… [{omitted} bayt kısaltıldı] …\n{tail}"
        return head + tail


@dataclass
class ShellRun:
    exit_code: int | None
    output: str
    truncated: bool
    timed_out: bool
    duration_ms: int


# ----------------------------------------------------------------------------- process


def _returncode(proc: asyncssh.SSHClientProcess[Any]) -> int:
    code = proc.returncode
    return code if code is not None else -1


class SSHProcess:
    """``contracts.transport.Process`` over an SSH channel (stdio as bytes)."""

    def __init__(self, proc: asyncssh.SSHClientProcess[Any]) -> None:
        self._p = proc

    @property
    def pid(self) -> int | None:
        return None  # remote pid is not exposed by SSH

    async def write(self, data: bytes) -> None:
        self._p.stdin.write(data)
        await self._p.stdin.drain()

    async def close_stdin(self) -> None:
        with contextlib.suppress(Exception):
            self._p.stdin.write_eof()

    async def readline(self) -> bytes:
        try:
            line = await self._p.stdout.readline()
        except (asyncssh.Error, OSError):
            return b""
        return bytes(line)

    async def read_stderr(self) -> bytes:
        try:
            return bytes(await self._p.stderr.read())
        except (asyncssh.Error, OSError):
            return b""

    async def wait(self) -> int:
        await self._p.wait_closed()
        return _returncode(self._p)

    async def terminate(self) -> None:
        with contextlib.suppress(Exception):
            self._p.terminate()
        with contextlib.suppress(Exception):
            self._p.stdin.write_eof()

    async def kill(self) -> None:
        with contextlib.suppress(Exception):
            self._p.kill()
        with contextlib.suppress(Exception):
            self._p.close()


# ----------------------------------------------------------------------------- transport


def _quote_path(path: str) -> str:
    if path == "~":
        return "~"
    if path.startswith("~/"):
        return "~/" + shlex.quote(path[2:])
    return shlex.quote(path)


def build_command(argv: list[str], cwd: str | None = None, env: dict[str, str] | None = None) -> str:
    """``cd <cwd> && exec [env -i K=V ...] argv...`` with every value shell-quoted."""
    if not argv:
        raise ValueError("argv must not be empty")
    parts: list[str] = []
    if cwd:
        parts.append(f"cd {_quote_path(cwd)} &&")
    parts.append("exec")
    if env is not None:
        if argv[0].startswith("-") or "=" in argv[0]:
            raise ValueError(f"program name not allowed with env: {argv[0]!r}")
        parts.append("env -i")
        for key, value in env.items():
            if not _ENV_NAME.match(key):
                raise ValueError(f"invalid environment variable name: {key!r}")
            parts.append(shlex.quote(f"{key}={value}"))
    parts.extend(shlex.quote(a) for a in argv)
    return " ".join(parts)


class SSHTransport:
    """Transport over a pooled SSH connection (``RemoteService.transport(host_id)``)."""

    kind: Literal["local", "ssh"] = "ssh"

    def __init__(self, pool: SSHPool, host_id: str) -> None:
        self._pool = pool
        self.host_id: str | None = host_id
        self._host = host_id
        self._home: str | None = None

    async def _create_process(self, command: str | None, **kwargs: Any) -> asyncssh.SSHClientProcess[Any]:
        for attempt in (1, 2):
            conn = await self._pool.connection(self._host)
            try:
                if command is None:
                    return await conn.create_process(encoding=None, **kwargs)
                return await conn.create_process(command, encoding=None, **kwargs)
            except _CHANNEL_ERRORS as e:
                # The channel never opened, so nothing ran: safe to reconnect and retry once.
                await self._pool.drop(self._host)
                if attempt == 2:
                    raise Unavailable(f"SSH kanalı açılamadı: {e}") from None
        raise AssertionError("unreachable")

    async def spawn(self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None) -> SSHProcess:
        proc = await self._create_process(build_command(argv, cwd, env))
        return SSHProcess(proc)

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        started = time.monotonic()
        proc = await self._create_process(build_command(argv, cwd, env))
        try:
            async with asyncio.timeout(timeout):
                if input:
                    out, err = await proc.communicate(input)
                else:
                    proc.stdin.write_eof()
                    out, err = await proc.communicate()
        except TimeoutError:
            with contextlib.suppress(Exception):
                proc.kill()
            proc.close()
            raise
        return CompletedProcess(
            argv=argv,
            returncode=_returncode(proc),
            stdout=bytes(out or b"").decode(errors="replace"),
            stderr=bytes(err or b"").decode(errors="replace"),
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    async def run_shell(self, command: str, *, timeout: float, limit: int = 64 * 1024) -> ShellRun:
        """Run a shell command line with ``/bin/sh -c`` (stderr merged), bounded output."""
        started = time.monotonic()
        proc = await self._create_process(f"exec /bin/sh -c {shlex.quote(command)}", stderr=asyncssh.STDOUT)
        with contextlib.suppress(Exception):
            proc.stdin.write_eof()
        collector = OutputCollector(limit)
        timed_out = False
        try:
            async with asyncio.timeout(timeout):
                while True:
                    chunk = await proc.stdout.read(65536)
                    if not chunk:
                        break
                    collector.feed(bytes(chunk))
                await proc.wait_closed()
        except TimeoutError:
            timed_out = True
            with contextlib.suppress(Exception):
                proc.kill()
            proc.close()
        return ShellRun(
            exit_code=None if timed_out else proc.returncode,
            output=collector.text(),
            truncated=collector.truncated,
            timed_out=timed_out,
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    async def open_terminal(
        self, *, cols: int, rows: int, term: str = "xterm-256color"
    ) -> asyncssh.SSHClientProcess[Any]:
        return await self._create_process(None, term_type=term, term_size=(cols, rows))

    # ------------------------------------------------------------------ files (SFTP)
    async def _abspath(self, path: str) -> str:
        if path == "~" or path.startswith("~/"):
            return (await self.home()).rstrip("/") + path[1:]
        return path

    async def read_file(self, path: str) -> bytes:
        sftp = await self._pool.sftp(self._host)
        target = await self._abspath(path)
        try:
            async with sftp.open(target, "rb") as f:
                return bytes(await f.read())
        except asyncssh.SFTPNoSuchFile:
            raise FileNotFoundError(target) from None
        except asyncssh.SFTPError as e:
            raise OSError(f"{target}: {e}") from None

    async def write_file(self, path: str, data: bytes) -> None:
        sftp = await self._pool.sftp(self._host)
        target = await self._abspath(path)
        parent = target.rsplit("/", 1)[0] if "/" in target else ""
        tmp = f"{target}.aistudio-{uuid.uuid4().hex[:8]}.tmp"
        try:
            if parent:
                await sftp.makedirs(parent, exist_ok=True)
            async with sftp.open(tmp, "wb") as f:
                await f.write(data)
            try:
                await sftp.posix_rename(tmp, target)
            except asyncssh.SFTPOpUnsupported:
                with contextlib.suppress(asyncssh.SFTPNoSuchFile):
                    await sftp.remove(target)
                await sftp.rename(tmp, target)
        except asyncssh.SFTPError as e:
            with contextlib.suppress(Exception):
                await sftp.remove(tmp)
            raise OSError(f"{target}: {e}") from None

    async def exists(self, path: str) -> bool:
        sftp = await self._pool.sftp(self._host)
        return bool(await sftp.exists(await self._abspath(path)))

    async def glob(self, pattern: str) -> list[str]:
        home = (await self.home()).rstrip("/")
        if pattern == "~" or pattern.startswith("~/"):
            pattern = home + pattern[1:]
        elif not pattern.startswith("/"):
            pattern = f"{home}/{pattern}"
        parts = pattern.split("/")
        base_parts: list[str] = []
        for part in parts:
            if any(c in part for c in "*?["):
                break
            base_parts.append(part)
        if len(base_parts) == len(parts):
            return [pattern] if await self.exists(pattern) else []
        base = "/".join(base_parts) or "/"
        rest = parts[len(base_parts) :]
        argv = ["find", base, "-mindepth", "1"]
        if "**" not in rest:
            argv += ["-maxdepth", str(len(rest))]
        argv.append("-print0")
        result = await self.run(argv, timeout=120)
        regex = re.compile(globmod.translate(pattern, recursive=True, include_hidden=True, seps="/"))
        return sorted(p for p in result.stdout.split("\0") if p and regex.match(p))

    async def home(self) -> str:
        if self._home is None:
            result = await self.run(["sh", "-c", 'printf %s "$HOME"'], timeout=30)
            home = result.stdout.strip()
            if not home:
                sftp = await self._pool.sftp(self._host)
                home = str(await sftp.realpath("."))
            self._home = home
        return self._home

    async def which(self, binary: str) -> str | None:
        if binary.startswith("/"):
            result = await self.run(["test", "-x", binary], timeout=30)
            return binary if result.returncode == 0 else None
        if not _BINARY_NAME.match(binary):
            raise ValueError(f"invalid binary name: {binary!r}")
        probe = 'command -v -- "$1" 2>/dev/null'
        for argv in (["sh", "-c", probe, "sh", binary], ["sh", "-lc", probe, "sh", binary]):
            with contextlib.suppress(TimeoutError, Unavailable):
                result = await self.run(argv, timeout=30)
                path = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
                if result.returncode == 0 and path.startswith("/"):
                    return path
        dirs = " ".join(f'"{d}"' for d in _COMMON_BIN_DIRS)
        script = f'for d in {dirs}; do if [ -x "$d/$1" ]; then printf "%s\\n" "$d/$1"; exit 0; fi; done; exit 1'
        result = await self.run(["sh", "-c", script, "sh", binary], timeout=30)
        path = result.stdout.strip()
        return path if result.returncode == 0 and path.startswith("/") else None
