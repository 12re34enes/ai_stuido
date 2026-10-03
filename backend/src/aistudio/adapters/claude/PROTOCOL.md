# Claude Code headless protocol (CLI 2.1.288)

How `ClaudeAdapter` talks to `claude`. Sources, in order of trust:

1. **SDK source**: `npm pack @anthropic-ai/claude-agent-sdk@0.3.288` (same release train as CLI
   2.1.288): `sdk.d.ts` (wire types) and `sdk.mjs` (`ProcessTransport` argv, `Query` control loop).
2. **CLI source**: `strings /opt/claude-code/bin/claude` (the bundled JS: zod schemas of every
   control request/response, the print-mode handlers, transcript writers).
3. **A real transcript** in `~/.claude/projects/` (record shapes only) and the real output of
   `claude --version` / `claude auth status --json` (both cost no quota).

No model prompt was run while writing this. Items marked *(verify)* are checked on the Mac by
`scripts/verify/claude/verify_claude.py`.

## Process

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
       --permission-prompt-tool stdio --permission-mode default
       (--session-id <uuid> | --resume <id> [--fork-session --session-id <new uuid>])
       [--model m] [--effort low|medium|high|xhigh|max] [--append-system-prompt <memory>]
       [--add-dir d]... --mcp-config '{"mcpServers":{"studio":{"type":"sdk","name":"studio","alwaysLoad":true},...}}'
       --strict-mcp-config --settings '<json>' --disallowedTools 'r1,r2'  [--tools Read,Grep,Glob]
```

* `--permission-prompt-tool stdio` (hidden flag) is what the official SDK passes when a host has a
  `canUseTool` callback: every *ask* decision becomes a `can_use_tool` control request. Allow/deny
  rules and the permission mode still decide everything else (reads in cwd are auto-allowed).
* `--session-id` together with `--resume` is only legal with `--fork-session` (CLI validation
  message), so forks get a pre-assigned id and the native id is always known before start.
* `--disallowedTools` / `--allowedTools` split on commas and spaces *outside* parentheses, so
  `Bash(rm -rf *)` survives as one rule. We pass one comma-joined argument.
* In `-p` mode "settings files that fail validation are silently ignored" (help text) — hence every
  deny rule is also passed via `--disallowedTools`.
* `--system-prompt-snapshot` defaults to `on`: the first request's system prompt (including
  `--append-system-prompt`) is recorded and reused on resume, so refreshed memory text only applies
  to new sessions (or after compaction). Not overridden.
* Env: the SDK sets `CLAUDE_CODE_ENTRYPOINT` (`sdk-ts`; Python SDK `sdk-py`) and drops
  `NODE_OPTIONS`/`DEBUG`. We also drop `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (subscription
  login must be used) and outer-session markers (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`). On SSH the
  same is done with an `env -u NAME ... K=V claude ...` prefix.
* The CLI exits when stdin closes and no turn is running. Stdout lines can be megabytes long
  (tool results) — transports must not use the 64 KiB asyncio default line limit.

## Framing

NDJSON in both directions, one JSON object per line.

### Host → CLI

```json
{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null,
 "session_id":"<id>","uuid":"<uuid4>","priority":"next"}
{"type":"control_request","request_id":"req_1_ab12","request":{"subtype":"initialize","sdkMcpServers":["studio"]}}
{"type":"control_request","request_id":"req_2_cd34","request":{"subtype":"interrupt"}}
{"type":"control_response","response":{"subtype":"success","request_id":"<cli id>","response":{...}}}
{"type":"control_response","response":{"subtype":"error","request_id":"<cli id>","error":"..."}}
```

* `uuid` on a user message is echoed back as `user_message_uuid(s)` on the turn's first reply
  frames and on its `result` — our join key between results and turns.
* `initialize` (first request, no hooks): `sdkMcpServers` names in-process servers; the response
  carries `commands`, `models`, `account`, … . Optional fields we do not use: `hooks`,
  `sdkMcpServerConfigs` (per-server timeout), `sdkMcpServerManifests`, `appendSystemPrompt`,
  `supportedDialogKinds`, `agents`, `title`.
* Other host requests used: `get_usage` (limits, below), `list_permission_rules` (verification).
  `interrupt` answers `{"still_queued":[uuid...]}`; `cancel_queued:true` would also drop them.

### CLI → host control requests

| subtype | payload | our answer |
|---|---|---|
| `can_use_tool` | `tool_name`, `input`, `tool_use_id`, optional `decision_reason` (may contain ANSI), `decision_reason_type`, `blocked_path`, `permission_suggestions`, `title`, `display_name`, `description`, `agent_id`, `requires_user_interaction` | allow: `{"behavior":"allow","updatedInput":{...},"toolUseID":id}` (we always send `updatedInput`, the original input when unchanged, like the Python SDK); deny: `{"behavior":"deny","message":"...","toolUseID":id}` (`interrupt` optional) |
| `mcp_message` | `server_name`, `message` (JSON-RPC request/notification) | `{"mcp_response": <JSON-RPC response>}`; notifications are acked with `{"mcp_response":{"jsonrpc":"2.0","result":{},"id":0}}` |
| `elicitation` | MCP elicitation | `{"action":"decline"}` |
| `request_user_dialog` | only for kinds declared in `supportedDialogKinds` (we declare none) | never answered (protocol rule) |
| `hook_callback` | only for hooks registered in `initialize` | n/a (error response) |

`{"type":"control_cancel_request","request_id":...}` withdraws an in-flight request (e.g. a
pending `can_use_tool` after an interrupt). No reply; we cancel the permission handler task.

### In-process MCP server (`studio`)

The CLI is the MCP client: `initialize` (we echo its `protocolVersion` if known: 2025-11-25,
2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07), `notifications/initialized`, `tools/list`,
`tools/call` → `{"content":[{"type":"text","text":...}],"isError":bool}`. Tools are named
`mcp__studio__<tool>` to the model. The CLI accepts the server both via `--mcp-config`
(`{"type":"sdk","name":..., "timeout"?, "alwaysLoad"?}`) and `initialize.sdkMcpServers`; a name
already registered is skipped ("already registered"), so we send both. `alwaysLoad: true` keeps the
tools out of tool-search deferral. Default MCP tool-call timeout is very long (~1e8 ms); sdk
servers have no idle timeout. `mcp__studio` is auto-allowed in `--settings` (the ToolHost is
already bound per role and enforces its own approvals).

## Messages (CLI → host)

* `system/init` — `session_id`, `model`, `cwd`, `tools`, `mcp_servers`, `permissionMode`,
  `claude_code_version`, `apiKeySource`, `capabilities`… **emitted at the start of every turn**,
  not once per process.
* `stream_event` — one Anthropic streaming event in `event` (`message_start`,
  `content_block_start` {`text`|`thinking`|`tool_use`}, `content_block_delta`
  {`text_delta`|`thinking_delta`|`input_json_delta`|`signature_delta`}, `content_block_stop`,
  `message_delta` {final `usage.output_tokens`}, `message_stop`). `parent_tool_use_id` set =
  subagent.
* `assistant` — **one frame per completed content block**; consecutive frames share
  `message.id`; `stop_reason` is null until the result. Optional `error`
  (`authentication_failed`, `rate_limit`, `overloaded`, …) marks a synthetic API-error message.
* `user` — `tool_result` blocks (`content` string or block list, `is_error`) plus
  `tool_use_result`, the tool's structured output: Edit/MultiEdit `{filePath, oldString,
  newString, originalFile, structuredPatch:[{oldStart,oldLines,newStart,newLines,lines}],
  userModified}`; Write `{type:"create"|"update", filePath, content, structuredPatch, originalFile}`;
  Bash `{stdout, stderr, interrupted, isImage, ...}` — no exit code field, failing commands get
  `Exit code N` appended to the text and `is_error: true`.
* `result` — exactly one per turn: `subtype` `success` (with `is_error` true on API errors) |
  `error_during_execution` | `error_max_turns` | `error_max_budget_usd` | …, `result` text,
  `errors[]`, `duration_ms`, `num_turns`, `terminal_reason` (`completed`, `aborted_streaming`,
  `aborted_tools`, `max_turns`, …), `user_message_uuids`, `usage` (main loop, **per turn**),
  `modelUsage` (per model incl. `contextWindow`, **cumulative**), `total_cost_usd`
  (**cumulative** API-equivalent estimate). We report the per-turn cost delta.
* `rate_limit_event` — `rate_limit_info`: `status` allowed|allowed_warning|rejected,
  `rateLimitType` five_hour|seven_day|seven_day_opus|seven_day_sonnet|seven_day_overage_included|
  overage, `utilization`, `resetsAt`, `unifiedWindows.{five_hour,seven_day,
  seven_day_overage_included}.{utilization,resetsAt}`, overage fields. **`utilization` is a
  fraction** (usually 0..1, can exceed 1) and **`resetsAt` is epoch seconds** (CLI schema
  description). Emitted when a window's rounded percent or reset moves.
* `system/status` (`compacting`), `system/api_retry` (`attempt`, `max_retries`, `error`),
  `system/permission_denied` (auto-denials), `system/session_state_changed` (only with
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`), `keep_alive`, task/hook notifications — informational.

## Turns, steering, interrupt

* A user message written while a turn runs is queued by the CLI and **folded into the running
  turn between tool rounds** (priority `next`), showing up in that turn's
  `result.user_message_uuids`. If the turn ends before a fold point, the queued message runs as
  the next turn on its own (we then report a CLI-started turn). `steer()` writes immediately with
  `priority:"next"`; `send()` while busy queues locally and writes after the current `result`, so
  a new message is never folded by accident. *(verify: `--extended`)*
* `interrupt` aborts the running turn; the CLI answers the control request, withdraws pending
  `can_use_tool` requests with `control_cancel_request` and ends the turn with a `result`
  (`terminal_reason` `aborted_streaming`/`aborted_tools`). Queued messages survive (they are
  listed in `still_queued`).
* Frames that arrive with no turn running (e.g. work resumed after a background task) are reported
  as a turn with empty input.

## Limits without spending quota

The `get_usage` control request (SDK: `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`)
returns `{session, subscription_type, rate_limits_available, rate_limits:{five_hour, seven_day,
seven_day_opus, seven_day_sonnet, model_scoped[], extra_usage}, behaviors}` with **utilization in
percent (0..100)** and ISO `resets_at`. It reads the claude.ai usage endpoint; no model turn.
`skip_behaviors:true` skips the local transcript scan. `read_limits()` spawns a throwaway
`claude -p ... --no-session-persistence` process, sends `initialize` + `get_usage`, closes it.
Returns `[]` on any failure (API-key logins have no plan limits). *(verify)*

## Health

* `claude --version` → `2.1.288 (Claude Code)`.
* `claude auth status --json` (no network call to the model) →
  `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty",...}`; non-zero exit
  when logged out. Tested range `>=2.1.200,<2.2`.

## Transcripts (existing sessions)

* `~/.claude/projects/<cwd with [^a-zA-Z0-9] → "-">/<session id>.jsonl` (names over 200 chars
  are cut and get a hash suffix; `CLAUDE_CONFIG_DIR` moves the root). Subagent transcripts live
  in `<session id>/subagents/` and the first record of a sidechain file has `"isSidechain":true`.
* Compact JSON, append-only. Records: `user` / `assistant` (with `uuid`, `parentUuid`,
  `sessionId`, `cwd`, `gitBranch`, `version`, `timestamp`, `message`; assistant records are one
  content block each, sharing `message.id`; tool-result user records carry `toolUseResult`),
  `attachment`, `system` (e.g. `stop_hook_summary`, `compact_boundary`), `summary`
  (`summary`), `custom-title` (`customTitle`), `ai-title` (`aiTitle`), `last-prompt`
  (`lastPrompt`), `queue-operation`, `tag`, … Human prompts are `user` records without
  `tool_result`, not `isMeta`/`isCompactSummary`, and not `<command-name>`/`<local-command-…>`
  tags or `[Request interrupted by user…]` markers (same rules as the SDK's `listSessions`).
* Title precedence (SDK): custom title → AI title → summary → first prompt → last prompt.
* Listing reads only head/tail (64 KiB each) and counts messages with one `sh`/`awk` call per
  batch, plus one `stat` call (GNU `-c` or BSD `-f`) for mtimes; falls back to reading files.

## Verified here vs. assumed

| Fact | Status |
|---|---|
| Flags exist (`--permission-prompt-tool` hidden, `--fork-session`, `--session-id`, `--effort` levels, `--include-partial-messages`, `--tools`, `--disallowedTools` splitting) | verified (help + CLI source) |
| Control request/response envelopes, `initialize`/`interrupt`/`can_use_tool`/`mcp_message`/`get_usage` shapes, permission result schema | verified (SDK types + CLI zod schemas) |
| `--mcp-config` sdk entry schema, duplicate registration skipped | verified (CLI source) |
| `rate_limit_event` utilization = fraction, resetsAt = epoch s; `get_usage` = percent, ISO | verified (CLI schema descriptions) |
| Transcript location/format, structured tool results | verified (CLI source + a real transcript) |
| `auth status --json` output, `--version` output | verified (ran locally) |
| `get_usage` succeeds for a subscription login and costs nothing | assumed — *(verify)* |
| Steering folds into the running turn from stdin in `-p` mode | assumed from result docs — *(verify `--extended`)* |
| Exact `result` subtype after interrupt | assumed; we key on `terminal_reason` and our own flag — *(verify)* |
| Permission rule path semantics (`Read(x)`, `Edit(x)`, `Write(x)`, `./x`) as generated | assumed from docs — *(verify: `list_permission_rules`)* |
