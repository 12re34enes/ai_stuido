"""Fixtures for the Codex adapter tests: fake CLI, recording sink, tool host and permissions."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

from aistudio.adapters.codex import CodexAdapter
from aistudio.contracts.agents import (
    AgentEventPayload,
    AgentState,
    PermissionDecision,
    PermissionRequest,
    StatusChanged,
)
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolResult, ToolSpec

from .local_transport import LocalTestTransport

HERE = Path(__file__).parent
FAKE_CLI = HERE / "fake_app_server.py"
REPO_ROOT = HERE.parents[2]
FIXTURES = REPO_ROOT / "fixtures" / "codex"
SCENARIOS = FIXTURES / "scenarios"


def load_scenario(name: str) -> dict[str, Any]:
    return json.loads((SCENARIOS / f"{name}.json").read_text(encoding="utf-8"))


class RecordingSink:
    def __init__(self) -> None:
        self.events: list[AgentEventPayload] = []
        self.limit_batches: list[list[LimitWindow]] = []
        self._changed = asyncio.Event()

    async def emit(self, payload: AgentEventPayload) -> None:
        self.events.append(payload)
        self._changed.set()

    async def limits(self, windows: list[LimitWindow]) -> None:
        self.limit_batches.append(windows)
        self._changed.set()

    def of[T](self, kind: type[T]) -> list[T]:
        return [e for e in self.events if isinstance(e, kind)]

    def states(self) -> list[AgentState]:
        return [e.state for e in self.events if isinstance(e, StatusChanged)]

    def types(self) -> list[str]:
        return [type(e).__name__ for e in self.events]

    async def wait_for(self, predicate: Callable[[], bool], timeout: float = 10.0) -> None:
        async def _loop() -> None:
            while not predicate():
                self._changed.clear()
                await self._changed.wait()

        await asyncio.wait_for(_loop(), timeout)


@dataclass
class FakeToolHost:
    tool_specs: list[ToolSpec] = field(
        default_factory=lambda: [
            ToolSpec(
                name="memory_read",
                description="Read workspace memory",
                input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
            ),
            ToolSpec(
                name="deploy_request",
                description="Request a deploy",
                input_schema={"type": "object", "properties": {}},
                mutating=True,
            ),
        ]
    )
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    fail: bool = False

    def specs(self) -> list[ToolSpec]:
        return list(self.tool_specs)

    async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
        self.calls.append((name, args))
        if self.fail:
            return ToolResult(content="memory unavailable", is_error=True)
        return ToolResult(content=f"{name}: kod stili PEP8", data={"ok": True})


@dataclass
class Permissions:
    """Permission handler double: ``allow`` is a bool or a function of the request."""

    allow: bool | Callable[[PermissionRequest], bool] = True
    requests: list[PermissionRequest] = field(default_factory=list)
    gate: asyncio.Event | None = None

    async def __call__(self, req: PermissionRequest) -> PermissionDecision:
        self.requests.append(req)
        if self.gate is not None:
            await self.gate.wait()
        ok = self.allow(req) if callable(self.allow) else self.allow
        return PermissionDecision(allow=ok, reason=None if ok else "politika reddetti", decided_by="policy")


@dataclass
class Harness:
    adapter: CodexAdapter
    transport: LocalTestTransport
    log_path: Path
    scenario_path: Path

    def client_log(self) -> list[dict[str, Any]]:
        if not self.log_path.exists():
            return []
        return [json.loads(line) for line in self.log_path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def sent(self, method: str) -> list[dict[str, Any]]:
        return [e["recv"] for e in self.client_log() if e["recv"].get("method") == method]

    def responses_to(self, method: str) -> list[dict[str, Any]]:
        return [e["recv"] for e in self.client_log() if e.get("respondsTo") == method]


MakeHarness = Callable[..., Harness]


@pytest.fixture
def make_harness(tmp_path: Path) -> MakeHarness:
    counter = {"n": 0}

    def _make(scenario: dict[str, Any] | str, *, extra_env: dict[str, str] | None = None, **kwargs: Any) -> Harness:
        counter["n"] += 1
        data = load_scenario(scenario) if isinstance(scenario, str) else scenario
        scenario_path = tmp_path / f"scenario-{counter['n']}.json"
        scenario_path.write_text(json.dumps(data), encoding="utf-8")
        log_path = tmp_path / f"client-{counter['n']}.jsonl"
        env = {
            "PATH": os.environ.get("PATH", ""),
            "HOME": str(tmp_path / "home"),
            "FAKE_CODEX_SCENARIO": str(scenario_path),
            "FAKE_CODEX_LOG": str(log_path),
            **(extra_env or {}),
        }
        adapter = CodexAdapter(command=[sys.executable, str(FAKE_CLI)], base_env=env, **kwargs)
        return Harness(adapter, LocalTestTransport(home_dir=str(tmp_path / "home")), log_path, scenario_path)

    return _make


@pytest.fixture
def workdir(tmp_path: Path) -> Path:
    d = tmp_path / "repo"
    d.mkdir()
    return d


async def eventually(check: Callable[[], Awaitable[bool]] | Callable[[], bool], timeout: float = 5.0) -> None:
    async def _loop() -> None:
        while True:
            res = check()
            if asyncio.iscoroutine(res):
                res = await res
            if res:
                return
            await asyncio.sleep(0.02)

    await asyncio.wait_for(_loop(), timeout)
