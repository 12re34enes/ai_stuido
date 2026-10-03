"""Process/file transport: the same adapter code runs locally or over SSH.

Implementations: ``LocalTransport`` (aistudio.agents.transport_local) and ``SSHTransport``
(aistudio.remote, obtained via ``RemoteService.transport(host_id)``).
"""

from __future__ import annotations

from typing import Literal, Protocol

from pydantic import BaseModel


class CompletedProcess(BaseModel):
    argv: list[str]
    returncode: int
    stdout: str
    stderr: str
    duration_ms: int


class Process(Protocol):
    """A spawned child with piped stdio (bytes)."""

    @property
    def pid(self) -> int | None: ...

    async def write(self, data: bytes) -> None: ...
    async def close_stdin(self) -> None: ...
    async def readline(self) -> bytes:
        """Next stdout line including ``\\n``; ``b""`` at EOF."""
        ...

    async def read_stderr(self) -> bytes:
        """Drain remaining stderr (call after exit)."""
        ...

    async def wait(self) -> int: ...
    async def terminate(self) -> None: ...
    async def kill(self) -> None: ...


class Transport(Protocol):
    kind: Literal["local", "ssh"]
    host_id: str | None

    async def spawn(self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None) -> Process:
        """Start a long-lived process. ``env`` is the COMPLETE environment (not merged)."""
        ...

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        """Run to completion. ``env`` None = inherit the transport's default (scrubbed) environment."""
        ...

    async def read_file(self, path: str) -> bytes: ...
    async def write_file(self, path: str, data: bytes) -> None: ...
    async def exists(self, path: str) -> bool: ...
    async def glob(self, pattern: str) -> list[str]:
        """Absolute paths matching a glob (``**`` supported), sorted."""
        ...

    async def home(self) -> str: ...
    async def which(self, binary: str) -> str | None: ...
