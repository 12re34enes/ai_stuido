"""Minimal local Transport for the codex adapter tests (the real LocalTransport lives in agents)."""

from __future__ import annotations

import asyncio
import contextlib
import glob
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from aistudio.contracts.transport import CompletedProcess
from aistudio.core import proc as procmod

STREAM_LIMIT = 16 * 1024 * 1024


class LocalProcess:
    def __init__(self, p: asyncio.subprocess.Process) -> None:
        self._p = p
        self._stderr = bytearray()
        self._stderr_task = asyncio.create_task(self._drain_stderr())

    async def _drain_stderr(self) -> None:
        assert self._p.stderr is not None
        while chunk := await self._p.stderr.read(65536):
            self._stderr += chunk
            if len(self._stderr) > 1024 * 1024:
                del self._stderr[: len(self._stderr) - 1024 * 1024]

    @property
    def pid(self) -> int | None:
        return self._p.pid

    async def write(self, data: bytes) -> None:
        assert self._p.stdin is not None
        self._p.stdin.write(data)
        await self._p.stdin.drain()

    async def close_stdin(self) -> None:
        stdin = self._p.stdin
        if stdin is not None and not stdin.is_closing():
            stdin.close()
            with contextlib.suppress(Exception):
                await stdin.wait_closed()

    async def readline(self) -> bytes:
        assert self._p.stdout is not None
        return await self._p.stdout.readline()

    async def read_stderr(self) -> bytes:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(self._stderr_task), 5)
        return bytes(self._stderr)

    async def wait(self) -> int:
        return await self._p.wait()

    async def terminate(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._p.terminate()

    async def kill(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._p.kill()


@dataclass
class SpawnRecord:
    argv: list[str]
    cwd: str | None
    env: dict[str, str] | None


@dataclass
class LocalTestTransport:
    kind: Literal["local", "ssh"] = "local"
    host_id: str | None = None
    home_dir: str | None = None
    spawned: list[SpawnRecord] = field(default_factory=list)
    processes: list[LocalProcess] = field(default_factory=list)

    async def spawn(
        self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None
    ) -> LocalProcess:
        self.spawned.append(SpawnRecord(argv=list(argv), cwd=cwd, env=dict(env) if env is not None else None))
        p = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=STREAM_LIMIT,
        )
        lp = LocalProcess(p)
        self.processes.append(lp)
        return lp

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        return await procmod.run(argv, cwd=cwd, env=env, timeout=timeout, input=input)

    async def read_file(self, path: str) -> bytes:
        return await asyncio.to_thread(Path(path).read_bytes)

    async def write_file(self, path: str, data: bytes) -> None:
        await asyncio.to_thread(Path(path).write_bytes, data)

    async def exists(self, path: str) -> bool:
        return os.path.exists(path)

    async def glob(self, pattern: str) -> list[str]:
        return sorted(glob.glob(pattern, recursive=True))

    async def home(self) -> str:
        return self.home_dir or str(Path.home())

    async def which(self, binary: str) -> str | None:
        return shutil.which(binary)
