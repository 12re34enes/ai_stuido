"""Fakes for the agents/limits tests: an in-process adapter + session handle, memory and remote
services. No CLI, no network."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from aistudio.agents.manager import AgentManagerImpl
from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.api.app import setup_modules
from aistudio.contracts.agents import (
    AdapterHealth,
    AgentErrorEv,
    AgentEventPayload,
    AgentEventSink,
    AgentRole,
    AgentState,
    Boundaries,
    Message,
    MessageDelta,
    NativeSessionInfo,
    PermissionDecision,
    PermissionHandler,
    PermissionRequest,
    SessionEnded,
    SessionSpec,
    SessionStarted,
    StatusChanged,
    SubagentCompleted,
    SubagentStarted,
    ToolCall,
    ToolKind,
    ToolResultEv,
    TurnCompleted,
    TurnResult,
    TurnStarted,
    Usage,
)
from aistudio.contracts.approvals import ApprovalService
from aistudio.contracts.common import Environment, PermissionLevel, Provider
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.memory import MemoryDoc, MemoryProposal
from aistudio.contracts.remote import DbQueryResult, Host, RemoteExecResult
from aistudio.contracts.tools import StudioTool, ToolContext, ToolHost, ToolResult, ToolSpec
from aistudio.contracts.transport import Transport
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.module import Module


async def wait_until(predicate: Callable[[], bool], timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


async def wait_until_async(predicate: Callable[[], Awaitable[bool]], timeout: float = 3.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not await predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


class FakeSessionHandle:
    """Runs scripted turns in background tasks.

    Message conventions: ``bash:<cmd>`` asks permission for a shell command, ``edit:<path>``
    for a file edit, ``read:<path>`` for a file read, ``hang`` starts a turn that never
    finishes (stall tests). ``subagents`` runs CLI-native subagents (``sa1`` "explorer" with a
    nested ``sa2``, both finishing); ``subbash:<cmd>`` starts ``sa1`` and asks permission for a
    shell command from inside it (left running); ``subhang`` starts ``sa1`` and never finishes.
    Anything else answers "Merhaba".
    """

    def __init__(
        self,
        *,
        provider: Provider,
        spec: SessionSpec,
        sink: AgentEventSink,
        tools: ToolHost,
        permissions: PermissionHandler,
        native_id: str,
    ) -> None:
        self.provider = provider
        self.spec = spec
        self.sink = sink
        self.tools = tools
        self.permissions = permissions
        self._native_id = native_id
        self._state = AgentState.idle
        self.sent: list[str] = []
        self.steered: list[str] = []
        self.interrupts = 0
        self.closed = False
        self.permission_results: list[PermissionDecision] = []
        self.permission_requests: list[PermissionRequest] = []
        self._tasks: dict[str, asyncio.Task[TurnResult]] = {}
        self._last_turn: str | None = None
        self._n = 0

    @property
    def native_id(self) -> str | None:
        return self._native_id

    @property
    def state(self) -> AgentState:
        return self._state

    async def _status(self, state: AgentState) -> None:
        self._state = state
        await self.sink.emit(StatusChanged(state=state))

    async def ask(self, req: PermissionRequest) -> PermissionDecision:
        self.permission_requests.append(req)
        decision = await self.permissions(req)
        self.permission_results.append(decision)
        return decision

    async def _run_turn(self, turn_id: str, text: str) -> TurnResult:
        await self.sink.emit(TurnStarted(turn_id=turn_id, input=text))
        await self._status(AgentState.thinking)
        if text == "hang":
            await asyncio.Event().wait()
        n = self._n
        if text in ("subagents", "subhang") or text.startswith("subbash:"):
            await self._status(AgentState.running_tool)
            await self.sink.emit(ToolCall(call_id="call-sa1", tool="Agent", kind=ToolKind.subagent))
            await self.sink.emit(
                SubagentStarted(
                    subagent_id="sa1",
                    parent_call_id="call-sa1",
                    name="explorer",
                    description="Testleri bul",
                    prompt="Testleri bul ve listele",
                )
            )
            await self.sink.emit(SubagentStarted(subagent_id="sa1", model="sub-model"))  # late model (upsert)
            if text == "subhang":
                await asyncio.Event().wait()
        if text.startswith("subbash:"):
            command = text[len("subbash:") :]
            await self.ask(
                PermissionRequest(
                    request_id=f"perm-{n}",
                    tool="Bash",
                    kind=ToolKind.command,
                    summary=f"`{command}` komutunu çalıştırmak istiyor",
                    command=command,
                    subagent_id="sa1",
                )
            )
        if text == "subagents":
            await self.sink.emit(ToolCall(call_id="sa1-bash", tool="Bash", kind=ToolKind.command, subagent_id="sa1"))
            await self.sink.emit(ToolResultEv(call_id="sa1-bash", output="ok", subagent_id="sa1"))
            await self.sink.emit(Message(message_id="sa1-m", text="İki test var", subagent_id="sa1"))
            await self.sink.emit(Usage(input_tokens=120, output_tokens=30, subagent_id="sa1"))
            await self.sink.emit(ToolCall(call_id="call-sa2", tool="Agent", kind=ToolKind.subagent, subagent_id="sa1"))
            await self.sink.emit(
                SubagentStarted(subagent_id="sa2", parent_subagent_id="sa1", parent_call_id="call-sa2", name="worker")
            )
            await self.sink.emit(MessageDelta(message_id="sa2-m", text="lis", subagent_id="sa2"))
            await self.sink.emit(SubagentCompleted(subagent_id="sa2", status="error", result_text="olmadı"))
            await self.sink.emit(
                SubagentCompleted(
                    subagent_id="sa1",
                    status="success",
                    result_text="Bitti: iki test",
                    usage=Usage(input_tokens=150, output_tokens=40, subagent_id="sa1"),
                )
            )
            await self.sink.emit(ToolResultEv(call_id="call-sa1", output="Bitti: iki test"))
        if text.startswith("bash:"):
            command = text[5:]
            await self._status(AgentState.running_tool)
            await self.ask(
                PermissionRequest(
                    request_id=f"perm-{n}",
                    tool="Bash",
                    kind=ToolKind.command,
                    summary=f"{command} çalıştırmak istiyor",
                    command=command,
                )
            )
        elif text.startswith("edit:"):
            path = text[5:]
            await self._status(AgentState.running_tool)
            await self.ask(
                PermissionRequest(
                    request_id=f"perm-{n}",
                    tool="Edit",
                    kind=ToolKind.file_edit,
                    summary=f"{path} dosyasını düzenlemek istiyor",
                    paths=[path],
                    input={"file_path": path, "old_string": "a", "new_string": "b"},
                )
            )
        elif text.startswith("read:"):
            path = text[5:]
            await self.ask(
                PermissionRequest(
                    request_id=f"perm-{n}",
                    tool="Read",
                    kind=ToolKind.file_read,
                    summary=f"{path} okumak istiyor",
                    paths=[path],
                )
            )
        await self._status(AgentState.responding)
        await self.sink.emit(MessageDelta(message_id=f"m{n}", text="Mer"))
        await self.sink.emit(MessageDelta(message_id=f"m{n}", text="haba"))
        await self.sink.emit(Message(message_id=f"m{n}", text="Merhaba"))
        usage = Usage(input_tokens=10, output_tokens=5, duration_ms=100, context_used=1000, context_window=200000)
        await self.sink.emit(usage)
        await self.sink.emit(TurnCompleted(turn_id=turn_id, status="success", result_text="Merhaba", usage=usage))
        await self._status(AgentState.idle)
        return TurnResult(turn_id=turn_id, status="success", text="Merhaba", usage=usage)

    async def send(self, text: str) -> str:
        self._n += 1
        turn_id = f"turn-{self._n}"
        self.sent.append(text)
        self._last_turn = turn_id
        self._tasks[turn_id] = asyncio.create_task(self._run_turn(turn_id, text))
        return turn_id

    async def steer(self, text: str) -> None:
        self.steered.append(text)

    async def interrupt(self) -> None:
        self.interrupts += 1
        for t in self._tasks.values():
            if not t.done():
                t.cancel()
        await self._status(AgentState.idle)

    async def wait_turn(self, turn_id: str | None = None, timeout: float | None = None) -> TurnResult:
        tid = turn_id or self._last_turn
        assert tid is not None
        return await asyncio.wait_for(self._tasks[tid], timeout=timeout or 5)

    async def emit_activity(self) -> None:
        await self.sink.emit(MessageDelta(message_id="activity", text="."))

    async def end(self, reason: str = "completed") -> None:
        """Simulate the CLI process exiting on its own."""
        for t in self._tasks.values():
            if not t.done():
                t.cancel()
        self._state = AgentState.done if reason in ("completed", "closed") else AgentState.error
        if reason == "error":
            await self.sink.emit(AgentErrorEv(message="çöktü"))
        await self.sink.emit(SessionEnded(reason=reason, exit_code=0 if reason == "completed" else 1))  # type: ignore[arg-type]

    async def close(self) -> None:
        self.closed = True
        for t in self._tasks.values():
            if not t.done():
                t.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await t
        self._state = AgentState.done
        await self.sink.emit(SessionEnded(reason="closed", exit_code=0))


class FakeAdapter:
    def __init__(
        self,
        provider: Provider,
        *,
        native_sessions: list[NativeSessionInfo] | None = None,
        history: dict[str, list[AgentEventPayload]] | None = None,
        limits: list[LimitWindow] | None = None,
        fail_start: bool = False,
        fail_discovery: bool = False,
    ) -> None:
        self.provider: Provider = provider
        self.native_sessions = native_sessions or []
        self.history = history or {}
        self.limit_windows = limits or []
        self.fail_start = fail_start
        self.fail_discovery = fail_discovery
        self.specs: list[SessionSpec] = []
        self.handles: list[FakeSessionHandle] = []
        self.transports: list[Transport] = []
        self.tool_hosts: list[ToolHost] = []
        self.discover_calls: list[str | None] = []

    @property
    def last(self) -> FakeSessionHandle:
        return self.handles[-1]

    async def health(self, transport: Transport) -> AdapterHealth:
        return AdapterHealth(
            provider=self.provider,
            installed=True,
            binary=f"/usr/local/bin/{self.provider}",
            version="1.0.0",
            logged_in=True,
            compatible=True,
            tested_range=">=1.0",
        )

    async def start(
        self,
        spec: SessionSpec,
        *,
        transport: Transport,
        sink: AgentEventSink,
        tools: ToolHost,
        permissions: PermissionHandler,
    ) -> FakeSessionHandle:
        if self.fail_start:
            raise RuntimeError("binary missing")
        self.specs.append(spec)
        self.transports.append(transport)
        self.tool_hosts.append(tools)
        native = spec.resume_native_id or f"{self.provider}-native-{len(self.specs)}"
        handle = FakeSessionHandle(
            provider=self.provider, spec=spec, sink=sink, tools=tools, permissions=permissions, native_id=native
        )
        self.handles.append(handle)
        await sink.emit(SessionStarted(native_id=native, model=spec.model or "fake-model", cwd=spec.cwd))
        await sink.emit(StatusChanged(state=AgentState.idle))
        return handle

    async def list_native_sessions(
        self, transport: Transport, *, cwd: str | None = None, limit: int = 200
    ) -> list[NativeSessionInfo]:
        self.discover_calls.append(cwd)
        if self.fail_discovery:
            raise RuntimeError("cannot list sessions")
        return [s for s in self.native_sessions if cwd is None or s.cwd == cwd][:limit]

    async def read_native_history(
        self, transport: Transport, native_id: str, *, cwd: str | None = None
    ) -> list[AgentEventPayload]:
        return list(self.history.get(native_id, []))

    async def read_limits(self, transport: Transport) -> list[LimitWindow]:
        return list(self.limit_windows)


class FakeMemory:
    """MemoryService fake: fixed boundaries and context."""

    def __init__(self, boundaries: Boundaries | None = None, context: str = "") -> None:
        self._boundaries = boundaries or Boundaries()
        self._context = context
        self.context_roles: list[AgentRole] = []

    async def ensure(self, workspace_id: str) -> None:
        return None

    async def context_for_agent(self, workspace_id: str, *, role: AgentRole) -> str:
        self.context_roles.append(role)
        return self._context

    async def list_docs(self, workspace_id: str) -> list[MemoryDoc]:
        return []

    async def read(self, workspace_id: str, path: str) -> MemoryDoc:
        raise NotImplementedError

    async def write(self, workspace_id: str, path: str, content: str, *, message: str, actor: str = "user") -> str:
        raise NotImplementedError

    async def propose(
        self,
        workspace_id: str,
        *,
        path: str,
        new_content: str,
        rationale: str | None = None,
        source_session_id: str | None = None,
    ) -> MemoryProposal:
        raise NotImplementedError

    async def boundaries(self, workspace_id: str) -> Boundaries:
        return self._boundaries

    async def head(self, workspace_id: str) -> str | None:
        return None

    async def restore(self, workspace_id: str, commit: str) -> None:
        return None


class FakeRemote:
    """RemoteService fake returning a given transport and host environment."""

    def __init__(self, transport: Transport, environment: Environment = Environment.test) -> None:
        self._transport = transport
        self._environment = environment
        self.transport_calls: list[str] = []

    async def get_host(self, host_id: str) -> Host:
        return Host(
            id=host_id,
            name="sunucu",
            hostname="example.invalid",
            username="deploy",
            environment=self._environment,
            permission_level=PermissionLevel.read,
            created_at=utcnow(),
        )

    async def transport(self, host_id: str) -> Transport:
        self.transport_calls.append(host_id)
        return self._transport

    async def exec(
        self,
        host_id: str,
        command: str,
        *,
        actor: str,
        workspace_id: str | None = None,
        session_id: str | None = None,
        task_id: str | None = None,
        reason: str | None = None,
        timeout: float = 300,
    ) -> RemoteExecResult:
        raise NotImplementedError

    async def db_query(
        self,
        profile_id: str,
        query: str,
        *,
        actor: str,
        workspace_id: str | None = None,
        session_id: str | None = None,
        task_id: str | None = None,
        reason: str | None = None,
        max_rows: int = 500,
    ) -> DbQueryResult:
        raise NotImplementedError


class EchoTool:
    def __init__(self, name: str, *, mutating: bool = False) -> None:
        self.spec = ToolSpec(name=name, description=f"{name} test tool", mutating=mutating)

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        return ToolResult(content=f"{self.spec.name}:{ctx.session_id}")


def tool(name: str, *, mutating: bool = False) -> StudioTool:
    return EchoTool(name, mutating=mutating)


def native_info(
    provider: Provider, native_id: str, *, cwd: str | None, title: str, updated_at: datetime | None = None
) -> NativeSessionInfo:
    return NativeSessionInfo(
        provider=provider,
        native_id=native_id,
        cwd=cwd,
        title=title,
        model="fake-model",
        message_count=4,
        updated_at=updated_at,
        file_path=f"/tmp/{native_id}.jsonl",
    )


@dataclass
class AgentsEnv:
    ctx: AppContext
    modules: list[Module]
    manager: AgentManagerImpl
    approvals: ApprovalService
    registry: AdapterRegistryImpl
    claude: FakeAdapter
    codex: FakeAdapter
    workspace_id: str
    cwd: Path


async def start_modules(ctx: AppContext, modules: list[Module]) -> None:
    await setup_modules(ctx, modules)
    await ctx.db.create_all()
    for m in modules:
        await m.start(ctx)
