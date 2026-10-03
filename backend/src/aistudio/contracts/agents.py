"""Agent adapters, sessions and the normalized agent event stream.

Layering:
    AgentManager (aistudio.agents)  - owns sessions, persistence, permission policy, limits
      -> AgentAdapter (aistudio.adapters.claude / .codex) - speaks one CLI's protocol
        -> Transport (local process or SSH channel)

Adapters translate their CLI's native stream into the normalized ``AgentEvent`` payloads
below and hand them to an ``AgentEventSink``. The manager writes them to the event log
under the ``agent.*`` types listed in ``core/events.py::ET`` (``*.delta`` are ephemeral).
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from aistudio.contracts.common import Location, Provider
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolHost
from aistudio.contracts.transport import Transport

# --------------------------------------------------------------------------- configuration


class SandboxLevel(StrEnum):
    read_only = "read_only"
    workspace_write = "workspace_write"
    full = "full"


class Boundaries(BaseModel):
    """First-class agent limits. Enforced in four layers (spec §8): CLI-native settings,
    permission interception (policy), the post-hoc boundary gate, and remote access only via
    Studio tools. Globs are gitignore-style, relative to the repo root."""

    forbidden_paths: list[str] = Field(default_factory=list)  # never read or write
    readonly_paths: list[str] = Field(default_factory=list)  # read, never write
    allowed_commands: list[str] = Field(default_factory=list)  # auto-allowed shell patterns
    denied_commands: list[str] = Field(default_factory=list)  # always denied shell patterns
    network: bool = True
    sandbox: SandboxLevel = SandboxLevel.workspace_write
    remote_access: Literal["none", "read", "limited", "full"] = "none"

    def merged(self, other: Boundaries) -> Boundaries:
        """Most restrictive combination (used to merge workspace + profile boundaries)."""
        order = ["none", "read", "limited", "full"]
        sandbox_order = [SandboxLevel.read_only, SandboxLevel.workspace_write, SandboxLevel.full]
        return Boundaries(
            forbidden_paths=sorted({*self.forbidden_paths, *other.forbidden_paths}),
            readonly_paths=sorted({*self.readonly_paths, *other.readonly_paths}),
            allowed_commands=[c for c in self.allowed_commands if c in other.allowed_commands]
            if self.allowed_commands and other.allowed_commands
            else (self.allowed_commands or other.allowed_commands),
            denied_commands=sorted({*self.denied_commands, *other.denied_commands}),
            network=self.network and other.network,
            sandbox=min(self.sandbox, other.sandbox, key=sandbox_order.index),
            remote_access=min(self.remote_access, other.remote_access, key=order.index),  # type: ignore[arg-type]
        )


AgentRole = Literal["writer", "advisor", "reviewer", "planner", "tester", "judge", "synthesizer"]


class AgentProfile(BaseModel):
    id: str
    workspace_id: str | None = None  # None = global profile
    name: str
    provider: Provider
    model: str | None = None  # None = CLI default
    effort: str | None = None  # claude: low|medium|high|xhigh|max ; codex: reasoning effort
    role: AgentRole = "writer"
    instructions: str = ""  # appended to the system prompt
    boundaries: Boundaries = Field(default_factory=Boundaries)
    color: str | None = None


class SessionSpec(BaseModel):
    """Everything an adapter needs to start or resume a CLI session."""

    provider: Provider
    cwd: str
    location: Location = Field(default_factory=Location)
    model: str | None = None
    effort: str | None = None
    role: AgentRole = "writer"
    system_append: str = ""  # memory context + role instructions (spec §10)
    boundaries: Boundaries = Field(default_factory=Boundaries)
    extra_dirs: list[str] = Field(default_factory=list)
    mcp_servers: dict[str, Any] = Field(default_factory=dict)  # user-configured external MCP servers
    resume_native_id: str | None = None
    fork: bool = False  # with resume_native_id: branch a new native session from it
    env: dict[str, str] = Field(default_factory=dict)  # extra env on top of the scrubbed base
    title: str | None = None


# --------------------------------------------------------------------------- normalized events


class AgentState(StrEnum):
    starting = "starting"
    idle = "idle"  # waiting for input
    thinking = "thinking"
    responding = "responding"
    running_tool = "running_tool"
    waiting_permission = "waiting_permission"
    waiting_user = "waiting_user"
    interrupted = "interrupted"
    done = "done"
    error = "error"


class ToolKind(StrEnum):
    command = "command"
    file_read = "file_read"
    file_edit = "file_edit"
    search = "search"
    web = "web"
    mcp = "mcp"
    studio = "studio"  # one of our Studio tools
    subagent = "subagent"
    other = "other"


class SessionStarted(BaseModel):
    native_id: str
    model: str | None = None
    cwd: str
    cli_version: str | None = None


class StatusChanged(BaseModel):
    state: AgentState
    detail: str | None = None


class TurnStarted(BaseModel):
    turn_id: str
    input: str


class MessageDelta(BaseModel):
    message_id: str
    text: str
    subagent_id: str | None = None  # set when produced inside a CLI-native subagent


class Message(BaseModel):
    message_id: str
    role: Literal["assistant", "user"] = "assistant"
    text: str
    subagent_id: str | None = None  # set when produced inside a CLI-native subagent


class ThinkingDelta(BaseModel):
    message_id: str
    text: str
    subagent_id: str | None = None  # set when produced inside a CLI-native subagent


class Thinking(BaseModel):
    message_id: str
    text: str
    subagent_id: str | None = None  # set when produced inside a CLI-native subagent


class ToolCall(BaseModel):
    call_id: str
    tool: str  # native tool name (Bash, Edit, shell, apply_patch, mcp__x__y, ...)
    kind: ToolKind
    input: dict[str, Any] = Field(default_factory=dict)
    summary: str | None = None  # one-line human description ("npm test", "src/app.ts düzenlendi")
    subagent_id: str | None = None  # set when produced inside a CLI-native subagent


class ToolResultEv(BaseModel):
    call_id: str
    output: str = ""  # truncated to ~64 KiB; full output may be stored as a blob
    is_error: bool = False
    exit_code: int | None = None
    blob_ref: str | None = None
    subagent_id: str | None = None  # set when produced inside a CLI-native subagent


class FileChanged(BaseModel):
    path: str  # relative to cwd when possible
    change: Literal["add", "modify", "delete", "rename"]
    diff: str | None = None
    old_path: str | None = None
    subagent_id: str | None = None  # set when produced inside a CLI-native subagent


class Usage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    context_used: int | None = None  # tokens currently in context
    context_window: int | None = None
    duration_ms: int | None = None
    api_equivalent_usd: float | None = None  # informational only (subscriptions)
    turns: int | None = None
    subagent_id: str | None = None  # set when produced inside a CLI-native subagent
    # A live running total inside a turn (Codex reports one per model call). The turn's final
    # usage follows as a non-partial event; per-task totals count only non-partial ones.
    partial: bool = False


class SubagentStarted(BaseModel):
    """A CLI-native subagent was spawned inside this session (Claude Task/Agent tool, Codex
    sub-agent thread). Payloads produced inside it carry ``subagent_id``."""

    subagent_id: str  # Claude: the spawning tool_use id; Codex: the sub-agent thread id
    parent_call_id: str | None = None  # ToolCall.call_id that spawned it, when known
    parent_subagent_id: str | None = None  # nested subagents
    name: str | None = None  # agent type / role ("general-purpose", "explorer", "reviewer")
    description: str | None = None  # short task description
    prompt: str | None = None  # truncated
    model: str | None = None


class SubagentCompleted(BaseModel):
    subagent_id: str
    status: Literal["success", "error", "interrupted"] = "success"
    result_text: str | None = None  # truncated
    usage: Usage | None = None


class TurnCompleted(BaseModel):
    turn_id: str
    status: Literal["success", "error", "interrupted", "max_turns"]
    result_text: str | None = None
    usage: Usage | None = None
    error: str | None = None


class SessionEnded(BaseModel):
    reason: Literal["completed", "closed", "error", "killed"]
    exit_code: int | None = None
    error: str | None = None


class AgentErrorEv(BaseModel):
    message: str
    retryable: bool = False
    code: str | None = None


AgentEventPayload = (
    SessionStarted
    | StatusChanged
    | TurnStarted
    | MessageDelta
    | Message
    | ThinkingDelta
    | Thinking
    | ToolCall
    | ToolResultEv
    | FileChanged
    | Usage
    | TurnCompleted
    | SessionEnded
    | AgentErrorEv
    | SubagentStarted
    | SubagentCompleted
)

# event type for each payload class (manager uses this when writing to the event log)
PAYLOAD_EVENT_TYPE: dict[type[BaseModel], str] = {
    SessionStarted: "agent.session.started",
    StatusChanged: "agent.status",
    TurnStarted: "agent.turn.started",
    MessageDelta: "agent.message.delta",
    Message: "agent.message",
    ThinkingDelta: "agent.thinking.delta",
    Thinking: "agent.thinking",
    ToolCall: "agent.tool.call",
    ToolResultEv: "agent.tool.result",
    FileChanged: "agent.file.changed",
    Usage: "agent.usage",
    TurnCompleted: "agent.turn.completed",
    SessionEnded: "agent.session.ended",
    AgentErrorEv: "agent.error",
    SubagentStarted: "agent.subagent.started",
    SubagentCompleted: "agent.subagent.completed",
}
EPHEMERAL_PAYLOADS: tuple[type[BaseModel], ...] = (MessageDelta, ThinkingDelta)


class AgentEventSink(Protocol):
    """Adapters push normalized payloads and limit observations here."""

    async def emit(self, payload: AgentEventPayload) -> None: ...
    async def limits(self, windows: list[LimitWindow]) -> None: ...


# --------------------------------------------------------------------------- permissions


class PermissionRequest(BaseModel):
    request_id: str
    tool: str
    kind: ToolKind
    input: dict[str, Any] = Field(default_factory=dict)
    summary: str  # "npm install çalıştırmak istiyor", "src/x.ts dosyasını düzenlemek istiyor"
    paths: list[str] = Field(default_factory=list)  # files the action touches, if known
    command: str | None = None  # shell command, if any
    reason: str | None = None  # CLI-provided explanation
    subagent_id: str | None = None  # raised inside a CLI-native subagent (SubagentStarted.subagent_id)


class PermissionDecision(BaseModel):
    allow: bool
    reason: str | None = None
    decided_by: str = "policy"  # policy | user | channel:<kind>
    updated_input: dict[str, Any] | None = None  # user-edited input (Claude supports this)


PermissionHandler = Callable[[PermissionRequest], Awaitable[PermissionDecision]]


# --------------------------------------------------------------------------- adapters


class AdapterHealth(BaseModel):
    provider: Provider
    installed: bool
    binary: str | None = None
    version: str | None = None
    logged_in: bool | None = None
    compatible: bool | None = None  # within tested version range
    tested_range: str | None = None
    message: str | None = None  # Turkish, user-facing explanation when something is wrong


class NativeSessionInfo(BaseModel):
    """A CLI session found on disk (local or remote), for 'add existing session'."""

    provider: Provider
    native_id: str
    location: Location = Field(default_factory=Location)
    cwd: str | None = None
    title: str | None = None
    model: str | None = None
    branch: str | None = None
    message_count: int | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    file_path: str | None = None
    running: bool = False


class TurnResult(BaseModel):
    turn_id: str
    status: Literal["success", "error", "interrupted", "max_turns"]
    text: str | None = None
    usage: Usage | None = None
    error: str | None = None


class AgentSessionHandle(Protocol):
    """A live session. Methods are safe to call from any task."""

    @property
    def native_id(self) -> str | None: ...

    @property
    def state(self) -> AgentState: ...

    async def send(self, text: str) -> str:
        """Start a new turn with a user message; returns turn_id. If a turn is running the
        message is queued for the next turn."""
        ...

    async def steer(self, text: str) -> None:
        """Inject guidance into the RUNNING turn (Codex turn/steer; Claude: queued user message)."""
        ...

    async def interrupt(self) -> None: ...
    async def wait_turn(self, turn_id: str | None = None, timeout: float | None = None) -> TurnResult:
        """Wait for the given (default: current/last) turn to finish."""
        ...

    async def close(self) -> None:
        """Gracefully end the CLI process (session stays resumable on disk)."""
        ...


class AgentAdapter(Protocol):
    provider: Provider

    async def health(self, transport: Transport) -> AdapterHealth: ...

    async def start(
        self,
        spec: SessionSpec,
        *,
        transport: Transport,
        sink: AgentEventSink,
        tools: ToolHost,
        permissions: PermissionHandler,
    ) -> AgentSessionHandle: ...

    async def list_native_sessions(
        self, transport: Transport, *, cwd: str | None = None, limit: int = 200
    ) -> list[NativeSessionInfo]: ...

    async def read_native_history(
        self, transport: Transport, native_id: str, *, cwd: str | None = None
    ) -> list[AgentEventPayload]:
        """Convert an existing session's history into normalized payloads (for import/replay)."""
        ...

    async def read_limits(self, transport: Transport) -> list[LimitWindow]:
        """Current limits if obtainable without spending quota; [] otherwise."""
        ...


class AdapterRegistry(Protocol):
    def register(self, adapter: AgentAdapter) -> None: ...
    def get(self, provider: Provider) -> AgentAdapter: ...
    def all(self) -> list[AgentAdapter]: ...


# --------------------------------------------------------------------------- manager


class SessionRecord(BaseModel):
    id: str
    workspace_id: str
    provider: Provider
    profile_id: str | None = None
    native_id: str | None = None
    location: Location = Field(default_factory=Location)
    cwd: str
    worktree_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    node_id: str | None = None
    label: str | None = None
    role: AgentRole = "writer"
    model: str | None = None
    effort: str | None = None  # reasoning effort the session was started with (from its spec)
    state: AgentState = AgentState.starting
    origin: Literal["created", "imported", "external"] = "created"
    title: str | None = None
    created_at: datetime
    updated_at: datetime
    last_usage: Usage | None = None


class StartSessionRequest(BaseModel):
    workspace_id: str
    spec: SessionSpec
    profile_id: str | None = None
    worktree_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    node_id: str | None = None
    label: str | None = None
    tool_names: list[str] | None = None  # None = all tools allowed for the role
    initial_prompt: str | None = None


class AgentManager(Protocol):
    async def start_session(self, req: StartSessionRequest) -> SessionRecord: ...
    async def handle(self, session_id: str) -> AgentSessionHandle:
        """Live handle; resumes the native session if the process is not running."""
        ...

    async def get(self, session_id: str) -> SessionRecord: ...
    async def list(
        self, *, workspace_id: str | None = None, run_id: str | None = None, active_only: bool = False
    ) -> list[SessionRecord]: ...
    async def health(self) -> list[AdapterHealth]: ...
    async def discover(self, location: Location, *, cwd: str | None = None) -> list[NativeSessionInfo]: ...
    async def import_native(self, workspace_id: str, info: NativeSessionInfo) -> SessionRecord: ...
    async def resolve_profile(self, profile_id: str) -> AgentProfile: ...
