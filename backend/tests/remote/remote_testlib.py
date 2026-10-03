"""Test helpers for the remote module: a real local asyncssh server, fakes and an env wrapper.

Keys are generated at test time (never committed)."""

from __future__ import annotations

import asyncio
import contextlib
import getpass
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import asyncssh

from aistudio.contracts.agents import AgentProfile, Boundaries, SessionRecord
from aistudio.contracts.approvals import Approval, ApprovalService, ApprovalStatus
from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound
from aistudio.core.events import Event, EventFilter
from aistudio.remote.models import DbProfileCreate, DbProfileRecord, HostCreate, HostRecord
from aistudio.remote.service import RemoteServiceImpl
from aistudio.remote.ssh import ShellRun

# ----------------------------------------------------------------------------- SSH server


class _Server(asyncssh.SSHServer):
    def __init__(self, password: str, allow_forwarding: bool) -> None:
        self._password = password
        self._allow_forwarding = allow_forwarding

    def begin_auth(self, username: str) -> bool:
        return True

    def password_auth_supported(self) -> bool:
        return True

    def validate_password(self, username: str, password: str) -> bool:
        return password == self._password

    def connection_requested(self, dest_host: str, dest_port: int, orig_host: str, orig_port: int) -> bool:
        return self._allow_forwarding


async def _pump(reader: asyncio.StreamReader, writer: Any) -> None:
    while True:
        data = await reader.read(65536)
        if not data:
            break
        writer.write(data)


async def _handle(process: asyncssh.SSHServerProcess[bytes]) -> None:
    """Runs the requested command with the local /bin/sh like sshd would (interactive shell when
    no command is given)."""
    if process.command is None:
        proc = await asyncio.create_subprocess_exec(
            "/bin/sh",
            "-i",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    else:
        proc = await asyncio.create_subprocess_shell(
            process.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    assert proc.stdin is not None and proc.stdout is not None

    async def pump_in() -> None:
        assert proc.stdin is not None
        try:
            while True:
                try:
                    data = await process.stdin.read(65536)
                except asyncssh.TerminalSizeChanged:
                    continue  # window-change request from the client
                if not data:
                    break
                proc.stdin.write(data)
                await proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError, asyncssh.Error):
            pass
        finally:
            with contextlib.suppress(Exception):
                proc.stdin.close()

    in_task = asyncio.create_task(pump_in())
    outs = [_pump(proc.stdout, process.stdout)]
    if proc.stderr is not None:
        outs.append(_pump(proc.stderr, process.stderr))
    try:
        await asyncio.gather(*outs)
        code = await proc.wait()
    finally:
        in_task.cancel()
        with contextlib.suppress(BaseException):
            await in_task
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
    process.exit(code)


@dataclass
class SshServer:
    port: int
    host_key: asyncssh.SSHKey
    client_key: asyncssh.SSHKey
    client_key_path: Path
    password: str
    acceptor: asyncssh.SSHAcceptor
    username: str = field(default_factory=lambda: getpass.getuser())

    @property
    def fingerprint(self) -> str:
        return self.host_key.get_fingerprint("sha256")

    def known_hosts_line(self, hostname: str = "127.0.0.1", key: asyncssh.SSHKey | None = None) -> str:
        public = (key or self.host_key).export_public_key("openssh").decode().split()
        return f"[{hostname}]:{self.port} {public[0]} {public[1]}\n"

    async def close(self) -> None:
        self.acceptor.close()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self.acceptor.wait_closed(), 5)


def make_password() -> str:
    """Built at runtime (never a literal secret)."""
    return "pw-" + os.urandom(8).hex()


async def start_ssh_server(base: Path, *, allow_forwarding: bool = False) -> SshServer:
    base.mkdir(parents=True, exist_ok=True)
    host_key = asyncssh.generate_private_key("ssh-ed25519")
    client_key = asyncssh.generate_private_key("ssh-ed25519")
    key_path = base / "id_test"
    client_key.write_private_key(str(key_path))
    os.chmod(key_path, 0o600)
    password = make_password()
    authorized = asyncssh.import_authorized_keys(client_key.export_public_key().decode())
    acceptor = await asyncssh.listen(
        "127.0.0.1",
        0,
        server_factory=lambda: _Server(password, allow_forwarding),
        server_host_keys=[host_key],
        authorized_client_keys=authorized,
        process_factory=_handle,
        encoding=None,
        sftp_factory=True,
        allow_scp=False,
        agent_forwarding=False,
    )
    return SshServer(
        port=acceptor.get_port(),
        host_key=host_key,
        client_key=client_key,
        client_key_path=key_path,
        password=password,
        acceptor=acceptor,
    )


async def start_echo_server() -> tuple[asyncio.Server, int]:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        with contextlib.suppress(Exception):
            while data := await reader.read(65536):
                writer.write(data)
                await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


# ----------------------------------------------------------------------------- fakes


class FakeRunner:
    """Stands in for SSHTransport.run_shell in exec tests."""

    def __init__(self) -> None:
        self.commands: list[str] = []
        self.output = "ok\n"
        self.exit_code: int | None = 0
        self.timed_out = False
        self.truncated = False

    async def run_shell(self, command: str, *, timeout: float, limit: int = 65536) -> ShellRun:
        self.commands.append(command)
        return ShellRun(
            exit_code=None if self.timed_out else self.exit_code,
            output=self.output,
            truncated=self.truncated,
            timed_out=self.timed_out,
            duration_ms=3,
        )


class FakeAgentManager:
    """Only what the boundary resolver uses: get() and resolve_profile()."""

    def __init__(self) -> None:
        self.access: dict[str, str] = {}

    async def get(self, session_id: str) -> SessionRecord:
        if session_id not in self.access:
            raise NotFound("Oturum bulunamadı.")
        now = utcnow()
        return SessionRecord(
            id=session_id,
            workspace_id="ws_test",
            provider="claude",
            profile_id=f"prof_{session_id}",
            cwd="/tmp",
            created_at=now,
            updated_at=now,
        )

    async def resolve_profile(self, profile_id: str) -> AgentProfile:
        session_id = profile_id.removeprefix("prof_")
        return AgentProfile(
            id=profile_id,
            name="test",
            provider="claude",
            boundaries=Boundaries(remote_access=self.access[session_id]),  # type: ignore[arg-type]
        )


class FakeMemory:
    def __init__(self, access: str) -> None:
        self.access = access

    async def boundaries(self, workspace_id: str) -> Boundaries:
        return Boundaries(remote_access=self.access)  # type: ignore[arg-type]


# ----------------------------------------------------------------------------- env


@dataclass
class RemoteEnv:
    ctx: AppContext
    svc: RemoteServiceImpl
    approvals: ApprovalService
    tools: ToolRegistry

    async def add_host(self, **kw: Any) -> HostRecord:
        defaults: dict[str, Any] = {
            "name": f"host-{os.urandom(3).hex()}",
            "hostname": "127.0.0.1",
            "username": getpass.getuser(),
            "auth": "agent",
            "environment": Environment.test,
            "permission_level": PermissionLevel.read,
        }
        defaults.update(kw)
        return await self.svc.store.create_host(HostCreate(**defaults))

    async def add_db(self, **kw: Any) -> DbProfileRecord:
        defaults: dict[str, Any] = {"name": f"db-{os.urandom(3).hex()}", "kind": "sqlite"}
        defaults.update(kw)
        return await self.svc.store.create_db_profile(DbProfileCreate(**defaults))

    async def next_pending(self, timeout: float = 5.0, exclude: set[str] | None = None) -> Approval:
        deadline = asyncio.get_running_loop().time() + timeout
        while True:
            pending = [
                a for a in await self.approvals.list(status=ApprovalStatus.pending) if a.id not in (exclude or set())
            ]
            if pending:
                return pending[-1]
            if asyncio.get_running_loop().time() > deadline:
                raise AssertionError("no pending approval appeared")
            await asyncio.sleep(0.01)

    async def decide_next(self, approve: bool = True, note: str | None = None, channel: str = "app") -> Approval:
        pending = await self.next_pending()
        return await self.approvals.decide(pending.id, approve=approve, note=note, channel=channel, decided_by="user")

    async def events(self, *types: str) -> list[Event]:
        return await self.ctx.events.query(EventFilter(types=list(types)), limit=1000)


def auto_decide(env: RemoteEnv, approve: bool = True, note: str | None = None) -> asyncio.Task[Approval]:
    return asyncio.create_task(env.decide_next(approve=approve, note=note))
