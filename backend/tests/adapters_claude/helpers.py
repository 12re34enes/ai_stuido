"""Test doubles for the Claude adapter: a minimal local Transport (asyncio subprocesses), a
recording event sink, a fake ToolHost and a scripted permission handler."""

from __future__ import annotations

import asyncio
import contextlib
import glob as _glob
import json
import os
import shutil
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, Literal

from aistudio.adapters.claude import ClaudeAdapter
from aistudio.contracts.agents import (
    AgentEventPayload,
    AgentState,
    PermissionDecision,
    PermissionRequest,
    StatusChanged,
)
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolResult, ToolSpec
from aistudio.contracts.transport import CompletedProcess
from aistudio.core import proc as core_proc

HERE = Path(__file__).resolve().parent
FAKE_CLI = HERE / "fake_claude.py"
FIXTURES = HERE.parents[2] / "fixtures" / "claude"
STREAM_LIMIT = 64 * 1024 * 1024


class LocalTestProcess:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self._stderr = bytearray()
        self._stderr_task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        assert self._proc.stderr is not None
        while True:
            chunk = await self._proc.stderr.read(65536)
            if not chunk:
                return
            self._stderr += chunk

    @property
    def pid(self) -> int | None:
        return self._proc.pid

    async def write(self, data: bytes) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.write(data)
        await self._proc.stdin.drain()

    async def close_stdin(self) -> None:
        stdin = self._proc.stdin
        if stdin is not None and not stdin.is_closing():
            stdin.close()
            with contextlib.suppress(Exception):
                await stdin.wait_closed()

    async def readline(self) -> bytes:
        assert self._proc.stdout is not None
        return await self._proc.stdout.readline()

    async def read_stderr(self) -> bytes:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(self._stderr_task), 5.0)
        return bytes(self._stderr)

    async def wait(self) -> int:
        return await self._proc.wait()

    async def terminate(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._proc.terminate()

    async def kill(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._proc.kill()


class LocalTestTransport:
    kind: Literal["local", "ssh"] = "local"
    host_id: str | None = None

    def __init__(self, home: str | None = None) -> None:
        self._home = home
        self.spawned: list[list[str]] = []
        self.processes: list[LocalTestProcess] = []

    async def spawn(
        self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None
    ) -> LocalTestProcess:
        self.spawned.append(list(argv))
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=STREAM_LIMIT,
        )
        p = LocalTestProcess(proc)
        self.processes.append(p)
        return p

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        return await core_proc.run(argv, cwd=cwd, env=env, timeout=timeout, input=input)

    async def read_file(self, path: str) -> bytes:
        return await asyncio.to_thread(Path(path).read_bytes)

    async def write_file(self, path: str, data: bytes) -> None:
        await asyncio.to_thread(Path(path).write_bytes, data)

    async def exists(self, path: str) -> bool:
        return Path(path).exists()

    async def glob(self, pattern: str) -> list[str]:
        return sorted(_glob.glob(pattern, recursive=True))

    async def home(self) -> str:
        return self._home or str(Path.home())

    async def which(self, binary: str) -> str | None:
        return shutil.which(binary)


class RecordingSink:
    def __init__(self) -> None:
        self.events: list[AgentEventPayload] = []
        self.limit_batches: list[list[LimitWindow]] = []

    async def emit(self, payload: AgentEventPayload) -> None:
        self.events.append(payload)

    async def limits(self, windows: list[LimitWindow]) -> None:
        self.limit_batches.append(windows)

    def of[T](self, cls: type[T]) -> list[T]:
        return [e for e in self.events if isinstance(e, cls)]

    def states(self) -> list[AgentState]:
        return [e.state for e in self.events if isinstance(e, StatusChanged)]

    def types(self) -> list[str]:
        return [type(e).__name__ for e in self.events]


class FakeToolHost:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def specs(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                name="memory_read",
                description="Read a shared memory file",
                input_schema={"type": "object", "properties": {"key": {"type": "string"}}, "required": ["key"]},
            ),
            ToolSpec(name="report_status", description="Report progress", mutating=True),
        ]

    async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
        self.calls.append((name, args))
        if name == "memory_read":
            return ToolResult(content=f"memory:{args.get('key')}", data={"key": args.get("key")})
        return ToolResult(content=f"Unknown or not permitted tool: {name}", is_error=True)


class ScriptedPermissions:
    """Permission handler: ``decide(request) -> PermissionDecision`` (default: allow all)."""

    def __init__(
        self,
        decide: Callable[[PermissionRequest], PermissionDecision] | None = None,
        *,
        delay: float = 0.0,
    ) -> None:
        self.requests: list[PermissionRequest] = []
        self._decide = decide or (lambda _r: PermissionDecision(allow=True, decided_by="policy"))
        self._delay = delay
        self.cancelled = 0

    async def __call__(self, request: PermissionRequest) -> PermissionDecision:
        self.requests.append(request)
        try:
            if self._delay:
                await asyncio.sleep(self._delay)
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        return self._decide(request)


def write_scenario(tmp_path: Path, scenario: dict[str, Any], name: str = "scenario.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(scenario), encoding="utf-8")
    return path


def load_fixture_scenario(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def make_adapter(tmp_path: Path, scenario: dict[str, Any], **kwargs: Any) -> tuple[ClaudeAdapter, Path]:
    """Adapter driving the fake CLI; returns (adapter, log path)."""
    scenario_path = write_scenario(tmp_path, scenario)
    log_path = tmp_path / "fake.log"
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    base_env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home),
        "FAKE_CLAUDE_SCENARIO": str(scenario_path),
        "FAKE_CLAUDE_LOG": str(log_path),
        "ANTHROPIC_API_KEY": "not-a-real-key",
        "CLAUDECODE": "1",
    }
    kwargs.setdefault("init_timeout", 15.0)
    kwargs.setdefault("close_timeout", 5.0)
    adapter = ClaudeAdapter(binary=[sys.executable, str(FAKE_CLI)], base_env=base_env, **kwargs)
    return adapter, log_path


def read_log(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
