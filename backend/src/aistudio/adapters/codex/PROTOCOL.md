# Codex app-server protocol notes (Codex CLI 0.160.x)

What `CodexAdapter` relies on. Facts are taken from the schema
(`codex app-server generate-json-schema --experimental`, pruned copy in
`schema/codex_app_server_protocol.subset.json`) and from runs of the real 0.160.0 binary
without login (recordings in `fixtures/codex/recorded/`). Items marked **(assumed)** could not be
observed without a logged-in account and are covered by `scripts/verify/codex/verify_codex.py`.

## Transport and framing

- `codex app-server` speaks newline-delimited JSON-RPC 2.0 over stdio, **without** the
  `"jsonrpc"` member. Request ids are ints or strings. Notifications may carry an extra
  top-level `emittedAtMs`.
- stderr is tracing logs (ANSI colored). The transport must drain it continuously.
- Lines can be large (aggregated command output, thread objects), so the transport's line limit
  must be generous (we use 16 MiB in tests).
- Closing stdin makes the server exit with code 0: that is our graceful shutdown. If it does not
  exit within 5 s we terminate, then kill.
- Errors use code `-32600` for almost everything (unknown method, bad thread id, no auth).

## Lifecycle

1. Spawn `codex app-server` (one process per AI Studio session, see below).
2. `initialize {clientInfo, capabilities: {experimentalApi: true}}` returns
   `{userAgent: "<client>/<codex version> (...)", codexHome, platformFamily, platformOs}`.
   We read the CLI version from `userAgent`.
3. Notification `initialized`.
4. `thread/start` | `thread/resume` | `thread/fork` returns `{thread, model, cwd, sandbox, ...}`.
   `thread/started` follows (start/fork). `thread/resume` is preceded by `thread/status/changed`.
5. `turn/start {threadId, input: [{type: "text", text, text_elements: []}]}` returns
   `{turn: {id, status: "inProgress"}}` immediately. Then: `thread/status/changed` (active),
   `turn/started`, `item/started` / `item/completed` (the user message first), deltas, server
   requests, `thread/tokenUsage/updated`, `account/rateLimits/updated`, and finally
   `thread/status/changed` (idle) + `turn/completed {turn: {status, error, durationMs}}`.
   Turn statuses: `completed`, `interrupted`, `failed` (`inProgress` while running).
6. `turn/steer {threadId, expectedTurnId, input}` returns `{turnId}`. When no turn is active:
   error `no active turn to steer`.
7. `turn/interrupt {threadId, turnId}` returns `{}` and the turn completes as `interrupted`.
   Wrong id while a turn runs: error `expected active turn id X but found Y`. **For a turn that has
   already finished the server sends no response at all**, so we race the request against the
   turn's completion and time out.

## Methods we call

| Method | Params we send | Notes |
|---|---|---|
| `initialize` | `clientInfo`, `capabilities.experimentalApi=true` | dynamic tools are experimental API |
| `thread/start` | `cwd, model, sandbox, approvalPolicy, approvalsReviewer, config, developerInstructions, dynamicTools` | |
| `thread/resume` | `threadId, excludeTurns: true` + same overrides (no `dynamicTools`) | unknown id: `no rollout found for thread id ...` |
| `thread/fork` | `threadId, excludeTurns: true` + overrides | new id, `forkedFromId` set |
| `thread/name/set` | `threadId, name` | when `spec.title` is set on new/forked threads |
| `turn/start`, `turn/steer`, `turn/interrupt` | see above | |
| `thread/list` | `cwd, limit, cursor, sortKey: updated_at, sourceKinds: [cli, vscode, exec, appServer]` | default sourceKinds are interactive only; threads with no turn yet are not listed |
| `thread/read` | `threadId, includeTurns: false` | `includeTurns: true` is deprecated (emits `deprecationNotice`) |
| `thread/turns/list` | `threadId, itemsView: full, sortDirection: asc, limit, cursor` | paginated via `nextCursor` |
| `account/rateLimits/read` | `excludeResetCreditDetails: true` | no quota; error without login |
| `account/read` | `{}` | works without login (`account: null`) |

## Session settings (Boundaries mapping)

- `sandbox`: `read_only` → `read-only`, `workspace_write` → `workspace-write`,
  `full` → `danger-full-access`. Advisors are always `read-only`.
- Network and extra writable dirs (workspace-write only) go through `config`
  (same keys as `config.toml`): `sandbox_workspace_write = {network_access, writable_roots}`.
  Verified: the response's `sandbox` policy reflects `networkAccess`. Without network we also set
  `web_search = "disabled"`.
- `approvalPolicy: "untrusted"` + `approvalsReviewer: "user"`: Codex runs only its built-in
  known-safe read-only commands by itself and asks for every other command and every patch, so
  they all reach our `PermissionHandler` (AI Studio's policy engine auto-allows
  `allowed_commands`). **(assumed)** that patches always ask under `untrusted` (Codex source
  behaviour); the verify script checks it.
- `config.model_reasoning_effort` ← `spec.effort` (verified reflected as `reasoningEffort`);
  `model` ← `spec.model`; `config.mcp_servers` ← `spec.mcp_servers`.
- `developerInstructions` ← `spec.system_append` + a short "AI Studio boundaries" section
  (forbidden/readonly paths, denied commands, network, remote access, advisor rules).
- `dynamicTools` ← the bound `ToolHost.specs()` as `{type: "function", name, description,
  inputSchema}` (advisors: non-mutating only). Verified: they are persisted in the rollout's
  `session_meta.dynamic_tools` and therefore restored on resume; `thread/resume` cannot change
  them, and threads created outside AI Studio have none.

## Server -> client requests

| Method | We answer |
|---|---|
| `item/commandExecution/requestApproval` | `{decision: "accept" \| "decline"}` from the `PermissionHandler` (params carry `command`, `cwd`, `commandActions`, `reason`, `networkApprovalContext`, `kind: command \| writeStdin`) |
| `item/fileChange/requestApproval` | `{decision}`; params only carry `itemId` (+ `reason`, `grantRoot`), the paths and diffs come from the preceding `item/started` fileChange item, which we cache. Advisors: always `decline` |
| `item/permissions/requestApproval` | allow: grant what was requested (`{permissions, scope: "turn"}`); deny: `{permissions: {}}` |
| `item/tool/call` (dynamic tool) | `ToolHost.call(tool, arguments)` → `{contentItems: [{type: "inputText", text}], success}`; namespaced or unknown tools fail |
| `item/tool/requestUserInput` | `{answers: {}}` (questions go through the `ask_user` Studio tool) |
| `mcpServer/elicitation/request` | `{action: "decline"}` |
| `currentTime/read` | `{currentTimeAt: <unix seconds>}` |
| `execCommandApproval`, `applyPatchApproval` (legacy v1) | mapped to the handler, `approved` / `{denied: {rejection}}` |
| anything else (`account/chatgptAuthTokens/refresh`, `attestation/generate`, ...) | JSON-RPC error `-32601` |

`serverRequest/resolved {requestId}` means the server no longer waits (e.g. the turn ended): we
cancel the pending handler and send nothing.

## Notifications -> normalized events

| Codex | AI Studio |
|---|---|
| `turn/started` / `turn/completed` | `TurnStarted` / `TurnCompleted` (+ `StatusChanged` thinking → idle / interrupted / error) |
| `item/started` agentMessage, `item/agentMessage/delta`, `item/completed` agentMessage | `StatusChanged(responding)`, `MessageDelta`, `Message` (`phase: final_answer` preferred as the turn result) |
| reasoning `item/reasoning/summaryTextDelta` / `textDelta`, completed reasoning | `ThinkingDelta`, `Thinking` |
| commandExecution started / completed (+ `outputDelta` as fallback output) | `ToolCall(kind=command \| file_read \| search, tool="shell")`, `ToolResultEv(exit_code)` |
| fileChange started / completed (`changes: [{path, kind, diff}]`) | `ToolCall(kind=file_edit, tool="apply_patch")`, `ToolResultEv`, `FileChanged` per change when `completed` |
| mcpToolCall | `ToolCall(kind=mcp, tool="mcp__<server>__<tool>")`, `ToolResultEv` |
| dynamic tool (`item/tool/call` request) | `ToolCall(kind=studio)`, `ToolResultEv` (the dynamicToolCall item is not re-reported) |
| webSearch / collabAgentToolCall / imageView | `ToolCall(kind=web / subagent / file_read)` (collab: Turkish summary per tool, output = per-agent status + final message) |
| `thread/tokenUsage/updated {total, last, modelContextWindow}` | `Usage` per turn: `total - (total - last at the turn's first update)`; `input_tokens` excludes cached input (`cache_read_tokens`); `context_used = last.totalTokens` |
| `account/rateLimits/updated {rateLimits}` | `sink.limits(...)` |
| `error {error, willRetry}` | `AgentErrorEv(retryable=willRetry, code=codexErrorInfo)` |
| `thread/status/changed` systemError | `StatusChanged(error)` |

Notifications for other thread ids are sub-agent threads (next section). Unknown notifications
are logged at debug level; malformed lines are skipped.

## Sub-agents → `agent.subagent.*`

Facts from the 0.160.0 **source** (`codex-rs` at tag `rust-v0.160.0`: `app-server/src/lib.rs`,
`request_processors/thread_processor.rs`, `bespoke_event_handling.rs`,
`app-server-protocol/src/protocol/v2/item.rs`, `core/src/tools/handlers/multi_agents*`):

* The app-server attaches a conversation listener to **every thread its ThreadManager creates**
  (`thread_created` broadcast → `try_attach_thread_listener` for all initialized connections), so
  a spawned sub-agent's `turn/*`, `item/*`, deltas, `thread/tokenUsage/updated`,
  `thread/status/changed` and approval requests reach us with the sub-agent's `threadId`.
  **No `thread/started` is sent for collab spawns** (only for start/fork/detached review). With
  one app-server process per AI Studio session, every foreign `threadId` is a descendant of our
  thread. Implemented in `subagents.py` (`CodexSubagents`); `subagent_id` = sub-agent thread id.
* **Multi-agent v1** (`spawn_agent`, `send_input`, `wait`, `close_agent`, `resume_agent`): items
  `collabAgentToolCall {id, tool: spawnAgent|sendInput|resumeAgent|wait|closeAgent, status,
  senderThreadId, receiverThreadIds, prompt, model, reasoningEffort, agentsStates: {threadId:
  {status: pendingInit|running|interrupted|completed|errored|shutdown|notFound, message}}}` in the
  sender's thread. `spawnAgent` starts with `receiverThreadIds: []` and completes with the new id
  (`agentsStates` = its initial status). `wait`/`closeAgent` carry final statuses; `message` is the
  final answer (`completed`) or the error (`errored`). The default multi-agent mode is
  `explicitRequestOnly` (the model spawns only when asked).
* **Multi-agent v2** (`spawn` with `task_name`, `send_message`, `followup_task`, …): no collab
  item for the spawn; `subAgentActivity {id, kind: started|interacted|interrupted|completed,
  agentThreadId, agentPath ("/root/<task>")}` in the initiating thread (`started` uses the spawn
  call id).
* **Mapping**: a foreign thread is adopted as a sub-agent when it first shows up — matched to the
  oldest unclaimed in-progress `spawnAgent` (parent = its sender, `parent_call_id` = item id,
  prompt/model from the item); without a pending spawn only on real activity (turn/item events),
  not on a bare status change. The spawn's `item/completed` is authoritative and fixes an
  out-of-order guess. `SubagentStarted` is then enriched (upsert) from a background `thread/read`
  (`agentRole` unless `default`, else `agentNickname`; `model`; `parentThreadId` /
  `source.subAgent.thread_spawn.parent_thread_id`). v2 names come from the agent path. Sub-agent
  `turn/completed` → `SubagentCompleted` (`completed`→success, `failed`→error,
  `interrupted`→interrupted, result = final/last agent message or the turn error); terminal
  `agentsStates`, `subAgentActivity completed|interrupted` and `thread/closed` end it too (once).
  A new turn on a finished sub-agent (sendInput) re-announces it. Payloads from sub-agent threads
  are tagged and never touch the main turn/state; a sub-agent's `thread/tokenUsage/updated`
  (cumulative per thread) is kept for `SubagentCompleted.usage` and not emitted as `agent.usage`
  (the limits module sums those per task). Approvals and dynamic tool calls from
  a sub-agent thread carry `subagent_id`. On process exit open sub-agents are ended
  (`interrupted`, or `error` on a crash).
* **History**: `thread/list` with our `sourceKinds` excludes sub-agent threads. Import reads the
  sub-agent threads named by spawn items / activity markers (`thread/read` + `thread/turns/list`,
  recursively, ≤64) and replays them where they were spawned, tagged; unreadable ones still appear
  from the parent's collab items, and ones never seen ending are `interrupted`.
* **(assumed)**, checked by `verify_codex.py --subagents`: that the multi-agent tools are on for
  app-server threads of a ChatGPT login in 0.160.x (feature gating), the exact interleaving of a
  sub-agent's first events and the spawn's `item/completed`, and that `thread/read` answers for a
  loaded sub-agent thread.

## Rate limits

`RateLimitSnapshot {limitId, limitName, primary, secondary, rateLimitReachedType}` with windows
`{usedPercent, windowDurationMins, resetsAt (unix s)}`. 300 min → `five_hour` ("5 saat"),
10080 min → `seven_day` ("Haftalık"), otherwise `primary` / `secondary` ("Birincil" / "İkincil").
Status: ≥ 80 warning, ≥ 100 exhausted; `rateLimitReachedType` marks the fullest window
exhausted. `rateLimitsByLimitId` buckets other than `codex` get a `_<limitId>` suffix
**(assumed: `codex` is the default bucket id)**. Notifications are sparse updates.

## Process model

One app-server process per session (thread). One process could host several threads, but
per-session processes keep cwd / env / sandbox settings isolated, confine a crash to one agent,
and behave the same over SSH. Discovery, history and limit reads use short-lived processes.

Environment: the full `os.environ` (or the remote `env`, or an injected base env) minus
`OPENAI_API_KEY`, `CODEX_API_KEY`, `AZURE_OPENAI_API_KEY`, `CODEX_ACCESS_TOKEN`, `SSH_AUTH_SOCK`,
`SSH_AGENT_PID`, plus `spec.env`; the CLI's directory is prepended to `PATH` (npm installs need
`node` next to it).

## Health

`codex --version` (`codex-cli X.Y.Z`), `codex login status` (exit 0 = logged in; prints
`Not logged in` with exit 1), tested range `>=0.160,<0.170`.

## Existing sessions

`thread/list` on a short-lived app-server (works locally and over SSH through the Transport).
If that fails we scan `~/.codex/sessions/**/rollout-*.jsonl`: the first line is `session_meta`
(`id`, `cwd`, `timestamp`, `cli_version`, `source`, optional `git`), `turn_context` lines carry
the model, `response_item` messages are the conversation (injected context starts with `<`).
History = `thread/read` + paginated `thread/turns/list` converted to normalized payloads.

## Regenerating the schema

```
cd backend
uv run python ../scripts/verify/codex/update_schema.py --codex "$(which codex)"
uv run pytest tests/adapters_codex   # the drift test names models that no longer match
```
