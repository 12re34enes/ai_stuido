"""Typed models for the subset of the ``codex app-server`` v2 protocol we use (Codex CLI 0.160.x).

Hand-written from the schema produced by ``codex app-server generate-json-schema --experimental``;
the pruned schema is committed under ``schema/`` and ``tests/adapters_codex/test_protocol_schema.py``
checks these models against it, so a regenerated schema that drifts fails the suite.

Rules that the drift test enforces:

* ``schema_name`` (and ``schema_variant`` for ``oneOf`` unions discriminated by ``type``) names the
  schema definition the model mirrors. Every declared field (by wire alias) must exist there.
* A field declared *required* here must be required in the schema (we never insist on something
  the server may omit).
* Outgoing models (``OutModel``) must declare every field the schema requires.

Wire format: newline-delimited JSON-RPC 2.0 *without* the ``"jsonrpc"`` member (verified against
0.160.0); notifications may carry an extra top-level ``emittedAtMs``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

CODEX_SCHEMA_VERSION = "0.160.0"
TESTED_RANGE = ">=0.160,<0.170"
TESTED_MIN = (0, 160, 0)
TESTED_MAX_EXCLUSIVE = (0, 170, 0)


class _Wire(BaseModel):
    schema_name: ClassVar[str] = ""
    schema_variant: ClassVar[str | None] = None  # value of the "type" discriminator in a oneOf
    outgoing: ClassVar[bool] = False

    def wire(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, exclude_none=True, mode="json")


class OutModel(_Wire):
    """Client -> server payloads (request params and responses to server requests)."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")
    outgoing: ClassVar[bool] = True


class InModel(_Wire):
    """Server -> client payloads. Lenient: unknown fields are ignored, most fields optional."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


# =========================================================================== client requests


class ClientInfo(OutModel):
    schema_name = "ClientInfo"
    name: str
    title: str | None = None
    version: str


class InitializeCapabilities(OutModel):
    schema_name = "InitializeCapabilities"
    # Dynamic tools (``thread/start.dynamicTools``) and ``item/tool/call`` are experimental API.
    experimental_api: bool = True
    request_attestation: bool = False
    opt_out_notification_methods: list[str] | None = None


class InitializeParams(OutModel):
    schema_name = "InitializeParams"
    client_info: ClientInfo
    capabilities: InitializeCapabilities | None = None


class InitializeResponse(InModel):
    schema_name = "InitializeResponse"
    user_agent: str  # "<client name>/<codex version> (<os>) ..."
    codex_home: str | None = None
    platform_family: str | None = None
    platform_os: str | None = None


class DynamicToolFunctionSpec(OutModel):
    schema_name = "DynamicToolSpec"
    schema_variant = "function"
    type: Literal["function"] = "function"
    name: str
    description: str
    input_schema: dict[str, Any]


SandboxMode = Literal["read-only", "workspace-write", "danger-full-access"]
ApprovalPolicy = Literal["untrusted", "on-request", "never"]


class _ThreadOverrides(OutModel):
    model: str | None = None
    cwd: str | None = None
    approval_policy: ApprovalPolicy | None = None
    approvals_reviewer: Literal["user", "auto_review", "guardian_subagent"] | None = None
    sandbox: SandboxMode | None = None
    config: dict[str, Any] | None = None
    developer_instructions: str | None = None


class ThreadStartParams(_ThreadOverrides):
    schema_name = "ThreadStartParams"
    dynamic_tools: list[DynamicToolFunctionSpec] | None = None


class ThreadResumeParams(_ThreadOverrides):
    schema_name = "ThreadResumeParams"
    thread_id: str
    exclude_turns: bool | None = None


class ThreadForkParams(_ThreadOverrides):
    schema_name = "ThreadForkParams"
    thread_id: str
    exclude_turns: bool | None = None


class TextInput(OutModel):
    schema_name = "UserInput"
    schema_variant = "text"
    type: Literal["text"] = "text"
    text: str
    text_elements: list[Any] = Field(default_factory=list, alias="text_elements")


class TurnStartParams(OutModel):
    schema_name = "TurnStartParams"
    thread_id: str
    input: list[TextInput]
    model: str | None = None
    effort: str | None = None


class TurnSteerParams(OutModel):
    schema_name = "TurnSteerParams"
    thread_id: str
    input: list[TextInput]
    expected_turn_id: str


class TurnInterruptParams(OutModel):
    schema_name = "TurnInterruptParams"
    thread_id: str
    turn_id: str


class ThreadListParams(OutModel):
    schema_name = "ThreadListParams"
    cursor: str | None = None
    limit: int | None = None
    sort_key: Literal["created_at", "updated_at", "recency_at"] | None = None
    sort_direction: Literal["asc", "desc"] | None = None
    source_kinds: list[str] | None = None
    cwd: str | list[str] | None = None


class ThreadReadParams(OutModel):
    schema_name = "ThreadReadParams"
    thread_id: str
    include_turns: bool | None = None


class ThreadTurnsListParams(OutModel):
    schema_name = "ThreadTurnsListParams"
    thread_id: str
    cursor: str | None = None
    limit: int | None = None
    sort_direction: Literal["asc", "desc"] | None = None
    items_view: Literal["notLoaded", "summary", "full"] | None = None


class ThreadSetNameParams(OutModel):
    schema_name = "ThreadSetNameParams"
    thread_id: str
    name: str


class GetAccountParams(OutModel):
    schema_name = "GetAccountParams"
    refresh_token: bool | None = None


class GetAccountRateLimitsParams(OutModel):
    schema_name = "GetAccountRateLimitsParams"
    exclude_reset_credit_details: bool | None = None


# =========================================================================== shared server types


class GitInfo(InModel):
    schema_name = "GitInfo"
    sha: str | None = None
    branch: str | None = None
    origin_url: str | None = None


class TurnError(InModel):
    schema_name = "TurnError"
    message: str
    codex_error_info: Any = None
    additional_details: str | None = None


class Turn(InModel):
    schema_name = "Turn"
    id: str
    items: list[dict[str, Any]] = Field(default_factory=list)
    status: Literal["completed", "interrupted", "failed", "inProgress"] = "inProgress"
    error: TurnError | None = None
    started_at: int | None = None
    completed_at: int | None = None
    duration_ms: int | None = None


class ThreadStatus(InModel):
    """Merged view of the ``ThreadStatus`` union (notLoaded | idle | systemError | active)."""

    schema_name = "ThreadStatus"
    type: str
    active_flags: list[str] = Field(default_factory=list)


class Thread(InModel):
    schema_name = "Thread"
    id: str
    cwd: str
    preview: str = ""
    name: str | None = None
    model: str | None = None
    model_provider: str | None = None
    reasoning_effort: str | None = None
    created_at: int | None = None
    updated_at: int | None = None
    status: ThreadStatus | None = None
    path: str | None = None
    cli_version: str | None = None
    git_info: GitInfo | None = None
    forked_from_id: str | None = None
    source: Any = None
    turns: list[Turn] = Field(default_factory=list)
    # sub-agent threads only (AgentControl spawns)
    parent_thread_id: str | None = None
    agent_nickname: str | None = None
    agent_role: str | None = None


class ThreadStartResponse(InModel):
    schema_name = "ThreadStartResponse"
    thread: Thread
    model: str
    cwd: str
    reasoning_effort: str | None = None
    approval_policy: Any = None
    sandbox: Any = None


class ThreadResumeResponse(ThreadStartResponse):
    schema_name = "ThreadResumeResponse"


class ThreadForkResponse(ThreadStartResponse):
    schema_name = "ThreadForkResponse"


class TurnStartResponse(InModel):
    schema_name = "TurnStartResponse"
    turn: Turn


class TurnSteerResponse(InModel):
    schema_name = "TurnSteerResponse"
    turn_id: str


class ThreadListResponse(InModel):
    schema_name = "ThreadListResponse"
    data: list[Thread]
    next_cursor: str | None = None


class ThreadReadResponse(InModel):
    schema_name = "ThreadReadResponse"
    thread: Thread


class ThreadTurnsListResponse(InModel):
    schema_name = "ThreadTurnsListResponse"
    data: list[Turn]
    next_cursor: str | None = None


class RateLimitWindow(InModel):
    schema_name = "RateLimitWindow"
    used_percent: float
    window_duration_mins: int | None = None
    resets_at: int | None = None  # unix seconds


class RateLimitSnapshot(InModel):
    schema_name = "RateLimitSnapshot"
    limit_id: str | None = None
    limit_name: str | None = None
    primary: RateLimitWindow | None = None
    secondary: RateLimitWindow | None = None
    plan_type: str | None = None
    rate_limit_reached_type: str | None = None


class GetAccountRateLimitsResponse(InModel):
    schema_name = "GetAccountRateLimitsResponse"
    rate_limits: RateLimitSnapshot
    rate_limits_by_limit_id: dict[str, RateLimitSnapshot] | None = None


class Account(InModel):
    """Merged view of the ``Account`` union (apiKey | chatgpt | amazonBedrock)."""

    schema_name = "Account"
    type: str
    email: str | None = None
    plan_type: str | None = None


class GetAccountResponse(InModel):
    schema_name = "GetAccountResponse"
    account: Account | None = None
    requires_openai_auth: bool


# =========================================================================== thread items


class UserMessageItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "userMessage"
    id: str
    content: list[dict[str, Any]]


class AgentMessageItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "agentMessage"
    id: str
    text: str
    phase: str | None = None  # commentary | final_answer | None (unknown)


class ReasoningItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "reasoning"
    id: str
    summary: list[str] = Field(default_factory=list)
    content: list[str] = Field(default_factory=list)


class PlanItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "plan"
    id: str
    text: str


class CommandExecutionItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "commandExecution"
    id: str
    command: str
    cwd: str
    status: str  # inProgress | completed | failed | declined
    command_actions: list[dict[str, Any]]
    aggregated_output: str | None = None
    exit_code: int | None = None
    duration_ms: int | None = None


class FileUpdateChange(InModel):
    schema_name = "FileUpdateChange"
    path: str
    kind: dict[str, Any]  # {"type": "add"|"delete"} | {"type": "update", "move_path": str|None}
    diff: str


class FileChangeItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "fileChange"
    id: str
    changes: list[FileUpdateChange]
    status: str  # inProgress | completed | failed | declined


class McpToolCallItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "mcpToolCall"
    id: str
    server: str
    tool: str
    status: str  # inProgress | completed | failed
    arguments: Any = None
    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    duration_ms: int | None = None


class DynamicToolCallItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "dynamicToolCall"
    id: str
    tool: str
    status: str
    arguments: Any = None
    namespace: str | None = None
    content_items: list[dict[str, Any]] | None = None
    success: bool | None = None
    duration_ms: int | None = None


class WebSearchItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "webSearch"
    id: str
    query: str
    action: dict[str, Any] | None = None


class CollabAgentToolCallItem(InModel):
    """Multi-agent v1 tool call (spawnAgent | sendInput | resumeAgent | wait | closeAgent) in the
    sender's thread; ``agentsStates`` values are ``{status, message}`` (CollabAgentState)."""

    schema_name = "ThreadItem"
    schema_variant = "collabAgentToolCall"
    id: str
    tool: str
    status: str
    prompt: str | None = None
    sender_thread_id: str | None = None
    receiver_thread_ids: list[str] = Field(default_factory=list)
    agents_states: dict[str, Any] = Field(default_factory=dict)
    model: str | None = None
    reasoning_effort: str | None = None


class SubAgentActivityItem(InModel):
    """Multi-agent v2 sub-agent lifecycle marker in the initiating thread."""

    schema_name = "ThreadItem"
    schema_variant = "subAgentActivity"
    id: str
    kind: str  # started | interacted | interrupted | completed
    agent_thread_id: str
    agent_path: str = ""


class ImageViewItem(InModel):
    schema_name = "ThreadItem"
    schema_variant = "imageView"
    id: str
    path: str


ITEM_MODELS: dict[str, type[InModel]] = {
    "userMessage": UserMessageItem,
    "agentMessage": AgentMessageItem,
    "reasoning": ReasoningItem,
    "plan": PlanItem,
    "commandExecution": CommandExecutionItem,
    "fileChange": FileChangeItem,
    "mcpToolCall": McpToolCallItem,
    "dynamicToolCall": DynamicToolCallItem,
    "webSearch": WebSearchItem,
    "collabAgentToolCall": CollabAgentToolCallItem,
    "subAgentActivity": SubAgentActivityItem,
    "imageView": ImageViewItem,
}


# =========================================================================== notifications


class ThreadStartedNotification(InModel):
    schema_name = "ThreadStartedNotification"
    thread: Thread


class ThreadStatusChangedNotification(InModel):
    schema_name = "ThreadStatusChangedNotification"
    thread_id: str
    status: ThreadStatus


class ThreadClosedNotification(InModel):
    schema_name = "ThreadClosedNotification"
    thread_id: str


class TurnStartedNotification(InModel):
    schema_name = "TurnStartedNotification"
    thread_id: str
    turn: Turn


class TurnCompletedNotification(InModel):
    schema_name = "TurnCompletedNotification"
    thread_id: str
    turn: Turn


class ItemStartedNotification(InModel):
    schema_name = "ItemStartedNotification"
    thread_id: str
    turn_id: str
    item: dict[str, Any]


class ItemCompletedNotification(InModel):
    schema_name = "ItemCompletedNotification"
    thread_id: str
    turn_id: str
    item: dict[str, Any]


class _ItemDelta(InModel):
    thread_id: str
    turn_id: str
    item_id: str
    delta: str


class AgentMessageDeltaNotification(_ItemDelta):
    schema_name = "AgentMessageDeltaNotification"


class ReasoningSummaryTextDeltaNotification(_ItemDelta):
    schema_name = "ReasoningSummaryTextDeltaNotification"


class ReasoningTextDeltaNotification(_ItemDelta):
    schema_name = "ReasoningTextDeltaNotification"


class CommandExecutionOutputDeltaNotification(_ItemDelta):
    schema_name = "CommandExecutionOutputDeltaNotification"


class FileChangePatchUpdatedNotification(InModel):
    schema_name = "FileChangePatchUpdatedNotification"
    thread_id: str
    turn_id: str
    item_id: str
    changes: list[FileUpdateChange]


class TokenUsageBreakdown(InModel):
    schema_name = "TokenUsageBreakdown"
    total_tokens: int = 0
    input_tokens: int = 0  # includes cached input tokens
    cached_input_tokens: int = 0
    cache_write_input_tokens: int = 0
    output_tokens: int = 0  # includes reasoning output tokens
    reasoning_output_tokens: int = 0


class ThreadTokenUsage(InModel):
    schema_name = "ThreadTokenUsage"
    total: TokenUsageBreakdown
    last: TokenUsageBreakdown
    model_context_window: int | None = None


class ThreadTokenUsageUpdatedNotification(InModel):
    schema_name = "ThreadTokenUsageUpdatedNotification"
    thread_id: str
    turn_id: str
    token_usage: ThreadTokenUsage


class AccountRateLimitsUpdatedNotification(InModel):
    schema_name = "AccountRateLimitsUpdatedNotification"
    rate_limits: RateLimitSnapshot


class ErrorNotification(InModel):
    schema_name = "ErrorNotification"
    error: TurnError
    will_retry: bool
    thread_id: str
    turn_id: str


class ServerRequestResolvedNotification(InModel):
    schema_name = "ServerRequestResolvedNotification"
    thread_id: str
    request_id: int | str


class WarningNotification(InModel):
    schema_name = "WarningNotification"
    message: str
    thread_id: str | None = None


class ModelReroutedNotification(InModel):
    schema_name = "ModelReroutedNotification"
    thread_id: str
    turn_id: str
    from_model: str
    to_model: str


# =========================================================================== server requests


class CommandExecutionRequestApprovalParams(InModel):
    schema_name = "CommandExecutionRequestApprovalParams"
    thread_id: str
    turn_id: str
    item_id: str
    kind: str = "command"  # command | writeStdin
    approval_id: str | None = None
    reason: str | None = None
    network_approval_context: dict[str, Any] | None = None
    command: str | None = None
    cwd: str | None = None
    command_actions: list[dict[str, Any]] | None = None


class CommandExecutionRequestApprovalResponse(OutModel):
    schema_name = "CommandExecutionRequestApprovalResponse"
    decision: Literal["accept", "acceptForSession", "decline", "cancel"]


class FileChangeRequestApprovalParams(InModel):
    schema_name = "FileChangeRequestApprovalParams"
    thread_id: str
    turn_id: str
    item_id: str
    reason: str | None = None
    grant_root: str | None = None


class FileChangeRequestApprovalResponse(OutModel):
    schema_name = "FileChangeRequestApprovalResponse"
    decision: Literal["accept", "acceptForSession", "decline", "cancel"]


class AdditionalFileSystemPermissions(InModel):
    schema_name = "AdditionalFileSystemPermissions"
    read: list[str] | None = None
    write: list[str] | None = None
    entries: list[dict[str, Any]] | None = None


class RequestPermissionProfile(InModel):
    schema_name = "RequestPermissionProfile"
    network: dict[str, Any] | None = None  # {"enabled": bool | None}
    file_system: AdditionalFileSystemPermissions | None = None


class PermissionsRequestApprovalParams(InModel):
    schema_name = "PermissionsRequestApprovalParams"
    thread_id: str
    turn_id: str
    item_id: str
    cwd: str
    reason: str | None = None
    permissions: RequestPermissionProfile


class GrantedPermissionProfile(OutModel):
    schema_name = "GrantedPermissionProfile"
    network: dict[str, Any] | None = None
    file_system: dict[str, Any] | None = None


class PermissionsRequestApprovalResponse(OutModel):
    schema_name = "PermissionsRequestApprovalResponse"
    permissions: GrantedPermissionProfile
    scope: Literal["turn", "session"] = "turn"


class DynamicToolCallParams(InModel):
    schema_name = "DynamicToolCallParams"
    thread_id: str
    turn_id: str
    call_id: str
    tool: str
    arguments: Any = None
    namespace: str | None = None


class DynamicToolCallOutputText(OutModel):
    schema_name = "DynamicToolCallOutputContentItem"
    schema_variant = "inputText"
    type: Literal["inputText"] = "inputText"
    text: str


class DynamicToolCallResponse(OutModel):
    schema_name = "DynamicToolCallResponse"
    content_items: list[DynamicToolCallOutputText]
    success: bool


class ToolRequestUserInputParams(InModel):
    schema_name = "ToolRequestUserInputParams"
    thread_id: str
    turn_id: str
    item_id: str
    questions: list[dict[str, Any]]


class ToolRequestUserInputResponse(OutModel):
    schema_name = "ToolRequestUserInputResponse"
    answers: dict[str, Any]


class McpServerElicitationRequestResponse(OutModel):
    schema_name = "McpServerElicitationRequestResponse"
    action: Literal["accept", "decline", "cancel"]
    content: Any = None
    meta: Any = Field(default=None, alias="_meta")


class CurrentTimeReadResponse(OutModel):
    schema_name = "CurrentTimeReadResponse"
    current_time_at: int


class ExecCommandApprovalParams(InModel):
    """Legacy (v1) command approval; not expected for v2 turns but answered defensively."""

    schema_name = "ExecCommandApprovalParams"
    conversation_id: str
    call_id: str
    command: list[str]
    cwd: str
    reason: str | None = None


class ApplyPatchApprovalParams(InModel):
    schema_name = "ApplyPatchApprovalParams"
    conversation_id: str
    call_id: str
    file_changes: dict[str, Any]
    reason: str | None = None


class ReviewDecisionResponse(OutModel):
    """Response for the legacy ``execCommandApproval`` / ``applyPatchApproval`` requests."""

    schema_name = "ExecCommandApprovalResponse"
    decision: Any  # "approved" | {"denied": {"rejection": str}} | ...


class ApplyPatchReviewDecisionResponse(ReviewDecisionResponse):
    schema_name = "ApplyPatchApprovalResponse"


# =========================================================================== method tables


@dataclass(frozen=True)
class MethodSpec:
    method: str
    params: type[_Wire] | None
    result: type[_Wire] | None = None


def _table(*specs: MethodSpec) -> dict[str, MethodSpec]:
    return {s.method: s for s in specs}


CLIENT_REQUESTS: dict[str, MethodSpec] = _table(
    MethodSpec("initialize", InitializeParams, InitializeResponse),
    MethodSpec("thread/start", ThreadStartParams, ThreadStartResponse),
    MethodSpec("thread/resume", ThreadResumeParams, ThreadResumeResponse),
    MethodSpec("thread/fork", ThreadForkParams, ThreadForkResponse),
    MethodSpec("thread/list", ThreadListParams, ThreadListResponse),
    MethodSpec("thread/read", ThreadReadParams, ThreadReadResponse),
    MethodSpec("thread/turns/list", ThreadTurnsListParams, ThreadTurnsListResponse),
    MethodSpec("thread/name/set", ThreadSetNameParams),
    MethodSpec("turn/start", TurnStartParams, TurnStartResponse),
    MethodSpec("turn/steer", TurnSteerParams, TurnSteerResponse),
    MethodSpec("turn/interrupt", TurnInterruptParams),
    MethodSpec("account/rateLimits/read", GetAccountRateLimitsParams, GetAccountRateLimitsResponse),
    MethodSpec("account/read", GetAccountParams, GetAccountResponse),
)

CLIENT_NOTIFICATIONS: tuple[str, ...] = ("initialized",)

SERVER_REQUESTS: dict[str, MethodSpec] = _table(
    MethodSpec(
        "item/commandExecution/requestApproval",
        CommandExecutionRequestApprovalParams,
        CommandExecutionRequestApprovalResponse,
    ),
    MethodSpec("item/fileChange/requestApproval", FileChangeRequestApprovalParams, FileChangeRequestApprovalResponse),
    MethodSpec(
        "item/permissions/requestApproval", PermissionsRequestApprovalParams, PermissionsRequestApprovalResponse
    ),
    MethodSpec("item/tool/call", DynamicToolCallParams, DynamicToolCallResponse),
    MethodSpec("item/tool/requestUserInput", ToolRequestUserInputParams, ToolRequestUserInputResponse),
    MethodSpec("mcpServer/elicitation/request", None, McpServerElicitationRequestResponse),
    MethodSpec("currentTime/read", None, CurrentTimeReadResponse),
    MethodSpec("execCommandApproval", ExecCommandApprovalParams, ReviewDecisionResponse),
    MethodSpec("applyPatchApproval", ApplyPatchApprovalParams, ApplyPatchReviewDecisionResponse),
)

SERVER_NOTIFICATIONS: dict[str, MethodSpec] = _table(
    MethodSpec("error", ErrorNotification),
    MethodSpec("thread/started", ThreadStartedNotification),
    MethodSpec("thread/status/changed", ThreadStatusChangedNotification),
    MethodSpec("thread/closed", ThreadClosedNotification),
    MethodSpec("thread/tokenUsage/updated", ThreadTokenUsageUpdatedNotification),
    MethodSpec("turn/started", TurnStartedNotification),
    MethodSpec("turn/completed", TurnCompletedNotification),
    MethodSpec("item/started", ItemStartedNotification),
    MethodSpec("item/completed", ItemCompletedNotification),
    MethodSpec("item/agentMessage/delta", AgentMessageDeltaNotification),
    MethodSpec("item/reasoning/summaryTextDelta", ReasoningSummaryTextDeltaNotification),
    MethodSpec("item/reasoning/textDelta", ReasoningTextDeltaNotification),
    MethodSpec("item/commandExecution/outputDelta", CommandExecutionOutputDeltaNotification),
    MethodSpec("item/fileChange/patchUpdated", FileChangePatchUpdatedNotification),
    MethodSpec("serverRequest/resolved", ServerRequestResolvedNotification),
    MethodSpec("account/rateLimits/updated", AccountRateLimitsUpdatedNotification),
    MethodSpec("model/rerouted", ModelReroutedNotification),
    MethodSpec("warning", WarningNotification),
)

# Notifications we receive but deliberately ignore (logged at debug level).
IGNORED_NOTIFICATIONS: frozenset[str] = frozenset(
    {
        "remoteControl/status/changed",
        "thread/goal/cleared",
        "thread/goal/updated",
        "thread/name/updated",
        "thread/settings/updated",
        "turn/diff/updated",
        "turn/plan/updated",
        "item/plan/delta",
        "item/reasoning/summaryPartAdded",
        "item/mcpToolCall/progress",
        "item/commandExecution/terminalInteraction",
        "thread/compacted",
        "mcpServer/startupStatus/updated",
        "configWarning",
        "deprecationNotice",
        "skills/changed",
        "hook/started",
        "hook/completed",
    }
)

# Union definitions in the schema that list every method per direction.
UNION_FOR_TABLE: dict[str, str] = {
    "client_requests": "ClientRequest",
    "client_notifications": "ClientNotification",
    "server_requests": "ServerRequest",
    "server_notifications": "ServerNotification",
}
