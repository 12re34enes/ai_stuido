"""A live Codex thread driven over one ``codex app-server`` process (AgentSessionHandle).

Sub-agents: every other thread on this process is a sub-agent spawned below our thread (see
``subagents.py``). Their notifications are routed to the ``_s_*`` handlers: payloads are tagged
with ``subagent_id`` (= the sub-agent thread id) and never change the main thread's state or
turn bookkeeping; approval requests from them carry ``PermissionRequest.subagent_id``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Coroutine, Sequence
from typing import Any

from pydantic import ValidationError

from aistudio.adapters.codex import mapping as m
from aistudio.adapters.codex import protocol as p
from aistudio.adapters.codex.rpc import CloseInfo, RpcClosed, RpcConnection, RpcError
from aistudio.adapters.codex.subagents import CodexSubagents
from aistudio.contracts.agents import (
    AgentErrorEv,
    AgentEventPayload,
    AgentEventSink,
    AgentState,
    Message,
    MessageDelta,
    PermissionDecision,
    PermissionHandler,
    PermissionRequest,
    SessionEnded,
    SessionSpec,
    StatusChanged,
    SubagentStarted,
    Thinking,
    ThinkingDelta,
    ToolCall,
    ToolKind,
    ToolResultEv,
    TurnCompleted,
    TurnResult,
    TurnStarted,
    Usage,
)
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolHost, ToolResult
from aistudio.core.errors import Conflict, NotFound, Unavailable
from aistudio.core.ids import new_id
from aistudio.core.text import truncate

log = logging.getLogger(__name__)

CMD_OUTPUT_CAP = 256 * 1024
MAX_TRACKED_TURNS = 200
# Sub-agent notifications that do not prove the thread is working (no adoption without a spawn).
_SUB_PASSIVE = frozenset({"thread/status/changed", "thread/closed", "error", "warning", "model/rerouted"})


class CodexSession:
    """One thread on one app-server process. All public methods are safe from any task."""

    def __init__(
        self,
        *,
        spec: SessionSpec,
        sink: AgentEventSink,
        tools: ToolHost,
        permissions: PermissionHandler,
        tool_names: set[str],
    ) -> None:
        self._spec = spec
        self._sink = sink
        self._tools = tools
        self._permissions = permissions
        self._tool_names = tool_names
        self._advisor = m.is_advisor(spec)
        self._cwd = spec.cwd
        self._conn: RpcConnection | None = None
        self._native_id: str | None = None
        self.model: str | None = None
        self.cli_version: str | None = None
        self._state = AgentState.starting
        self._started = False
        self._closed = False
        self._closing = False
        self._lock = asyncio.Lock()
        # turns
        self._futs: dict[str, asyncio.Future[TurnResult]] = {}
        self._active_turn: str | None = None
        self._starting_turn = False
        self._pending_input = ""
        self._interrupt_pending = False
        self._queue: deque[tuple[str, str]] = deque()
        self._last_ticket: str | None = None
        self._started_turns: set[str] = set()
        self._completed_turns: set[str] = set()
        self._turn_inputs: dict[str, str] = {}
        self._turn_text: dict[str, str] = {}
        self._turn_final: dict[str, str] = {}
        self._turn_usage: dict[str, Usage] = {}
        self._turn_base: dict[str, p.TokenUsageBreakdown] = {}
        # items
        self._items: dict[str, dict[str, Any]] = {}
        self._emitted_calls: set[str] = set()
        self._cmd_output: dict[str, list[str]] = {}
        self._cmd_output_size: dict[str, int] = {}
        self._approvals_waiting = 0
        self._bg: set[asyncio.Task[Any]] = set()
        self._subs = CodexSubagents()

    # ================================================================== AgentSessionHandle

    @property
    def native_id(self) -> str | None:
        return self._native_id

    @property
    def state(self) -> AgentState:
        return self._state

    async def send(self, text: str) -> str:
        self._ensure_open()
        async with self._lock:
            if self._active_turn is not None or self._starting_turn or self._queue:
                ticket = f"queued_{new_id('t')}"
                self._futs[ticket] = asyncio.get_running_loop().create_future()
                self._queue.append((ticket, text))
                self._last_ticket = ticket
                return ticket
            self._starting_turn = True
        try:
            turn_id = await self._start_turn(text, ticket=None)
        finally:
            self._starting_turn = False
            if self._active_turn is None:  # failed, or finished before we got here: run queued messages
                self._schedule_drain()
        self._last_ticket = turn_id
        return turn_id

    async def steer(self, text: str) -> None:
        self._ensure_open()
        turn_id = self._active_turn
        if turn_id is None or self._native_id is None:
            await self.send(text)  # nothing to steer: becomes the next turn
            return
        params = p.TurnSteerParams(thread_id=self._native_id, input=[p.TextInput(text=text)], expected_turn_id=turn_id)
        try:
            await self._rpc().request("turn/steer", params.wire(), timeout=30.0)
        except RpcError as e:  # e.g. "no active turn to steer" when the turn just ended
            log.info("codex: steer rejected (%s); queueing as a new turn", e.message)
            await self.send(text)
            return
        except (RpcClosed, TimeoutError) as e:
            raise Unavailable(f"Codex yönlendirmesi gönderilemedi: {e}") from e
        await self._emit(Message(message_id=new_id("steer"), role="user", text=text))

    async def interrupt(self) -> None:
        if self._closed:
            return
        async with self._lock:
            dropped = list(self._queue)
            self._queue.clear()
        for ticket, _text in dropped:
            self._resolve(
                ticket, TurnResult(turn_id=ticket, status="interrupted", error="Tur başlamadan iptal edildi.")
            )
        turn_id = self._active_turn
        if turn_id is None:
            if self._starting_turn:
                self._interrupt_pending = True
            return
        await self._send_interrupt(turn_id)

    async def wait_turn(self, turn_id: str | None = None, timeout: float | None = None) -> TurnResult:
        key = turn_id or self._active_turn or self._last_ticket
        if key is None:
            raise Conflict("Beklenecek bir tur yok.")
        fut = self._futs.get(key)
        if fut is None:
            raise NotFound(f"Tur bulunamadı: {key}")
        return await asyncio.wait_for(asyncio.shield(fut), timeout)

    async def close(self) -> None:
        if self._closed or self._conn is None:
            self._closed = True
            return
        self._closing = True
        if self._active_turn is not None:
            await self._send_interrupt(self._active_turn, timeout=3.0)
        await self._conn.close(grace=5.0)

    # ================================================================== setup (used by the adapter)

    def attach(self, conn: RpcConnection) -> None:
        self._conn = conn

    def mark_started(self, native_id: str, *, model: str | None, cli_version: str | None) -> None:
        self._native_id = native_id
        self._subs.main_thread_id = native_id
        self.model = model
        self.cli_version = cli_version
        self._started = True

    async def set_state(self, state: AgentState, detail: str | None = None) -> None:
        if state == self._state and detail is None:
            return
        self._state = state
        await self._emit(StatusChanged(state=state, detail=detail))

    async def emit(self, payload: AgentEventPayload) -> None:
        await self._emit(payload)

    # ================================================================== turns

    def _rpc(self) -> RpcConnection:
        if self._conn is None:
            raise Unavailable("Codex oturumu bağlı değil.")
        return self._conn

    def _ensure_open(self) -> None:
        if self._closed or self._closing or self._conn is None or self._conn.closed:
            raise Unavailable("Codex oturumu kapalı.")

    def _fut(self, key: str) -> asyncio.Future[TurnResult]:
        fut = self._futs.get(key)
        if fut is None:
            fut = asyncio.get_running_loop().create_future()
            self._futs[key] = fut
            self._prune_futs()
        return fut

    def _prune_futs(self) -> None:
        if len(self._futs) <= MAX_TRACKED_TURNS:
            return
        for key in [k for k, f in self._futs.items() if f.done()][: len(self._futs) - MAX_TRACKED_TURNS]:
            self._futs.pop(key, None)

    def _resolve(self, key: str, result: TurnResult) -> None:
        fut = self._fut(key)
        if not fut.done():
            fut.set_result(result)

    async def _start_turn(self, text: str, *, ticket: str | None) -> str:
        assert self._native_id is not None
        self._pending_input = text
        params = p.TurnStartParams(thread_id=self._native_id, input=[p.TextInput(text=text)])
        try:
            raw = await self._rpc().request("turn/start", params.wire())
            turn = p.TurnStartResponse.model_validate(raw).turn
        except (RpcError, RpcClosed, ValidationError, TimeoutError) as e:
            msg = f"Codex turu başlatılamadı: {getattr(e, 'message', None) or e}"
            if ticket is None:
                raise Unavailable(msg) from e
            await self._emit(AgentErrorEv(message=msg, code="turn_start_failed"))
            self._resolve(ticket, TurnResult(turn_id=ticket, status="error", error=msg))
            return ticket
        tid = turn.id
        self._turn_inputs[tid] = text
        if ticket is not None:
            ticket_fut = self._fut(ticket)
            existing = self._futs.get(tid)
            if existing is None:
                self._futs[tid] = ticket_fut
            elif existing is not ticket_fut:
                existing.add_done_callback(
                    lambda f, tf=ticket_fut: None if tf.done() or f.cancelled() else tf.set_result(f.result())
                )
        else:
            self._fut(tid)
        await self._on_turn_started(tid)
        return tid

    async def _on_turn_started(self, tid: str) -> None:
        if tid in self._started_turns:
            return
        self._started_turns.add(tid)
        await self._emit(TurnStarted(turn_id=tid, input=self._turn_inputs.get(tid, self._pending_input)))
        self._pending_input = ""
        if tid in self._completed_turns:
            return
        self._active_turn = tid
        await self.set_state(AgentState.thinking)
        if self._interrupt_pending:
            self._interrupt_pending = False
            self._spawn(self._send_interrupt(tid), "codex-deferred-interrupt")

    async def _send_interrupt(self, turn_id: str, *, timeout: float = 15.0) -> None:
        """turn/interrupt, raced against the turn's completion: app-server 0.160.0 never answers an
        interrupt for a turn that has already finished, so we stop waiting once it completes."""
        if self._native_id is None or turn_id in self._completed_turns:
            return
        params = p.TurnInterruptParams(thread_id=self._native_id, turn_id=turn_id).wire()
        request = asyncio.ensure_future(self._rpc().request("turn/interrupt", params, timeout=timeout))
        done = self._fut(turn_id)
        try:
            await asyncio.wait({request, done}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        finally:
            if not request.done():
                request.cancel()
            with contextlib.suppress(asyncio.CancelledError, RpcError, RpcClosed, TimeoutError):
                await request

    async def _on_turn_completed(self, turn: p.Turn) -> None:
        tid = turn.id
        if tid in self._completed_turns:
            return
        if tid not in self._started_turns:
            await self._on_turn_started(tid)
        self._completed_turns.add(tid)
        if self._active_turn == tid:
            self._active_turn = None
        status = m.turn_status(turn)
        error = turn.error.message if turn.error else None
        if status == "error" and not error:
            error = "Codex turu başarısız oldu."
        usage = self._turn_usage.pop(tid, None)
        if turn.duration_ms is not None:
            usage = (usage or Usage()).model_copy(update={"duration_ms": turn.duration_ms})
        text = self._turn_final.pop(tid, None) or self._turn_text.pop(tid, None)
        self._turn_text.pop(tid, None)
        self._turn_base.pop(tid, None)
        self._turn_inputs.pop(tid, None)
        await self._emit(
            TurnCompleted(turn_id=tid, status=status, result_text=text, usage=usage, error=error)  # type: ignore[arg-type]
        )
        if status == "success":
            await self.set_state(AgentState.idle)
        elif status == "interrupted":
            await self.set_state(AgentState.interrupted)
        else:
            await self.set_state(AgentState.error, error)
        self._resolve(tid, TurnResult(turn_id=tid, status=status, text=text, usage=usage, error=error))  # type: ignore[arg-type]
        self._schedule_drain()

    def _schedule_drain(self) -> None:
        if self._queue and not self._closed and not self._closing:
            self._spawn(self._drain_queue(), "codex-drain-queue")

    async def _drain_queue(self) -> None:
        while True:
            async with self._lock:
                if self._active_turn or self._starting_turn or not self._queue or self._closed or self._closing:
                    return
                ticket, text = self._queue.popleft()
                self._starting_turn = True
            try:
                started = await self._start_turn(text, ticket=ticket)
            except Exception:
                log.exception("codex: queued turn failed to start")
                started = ticket
            finally:
                self._starting_turn = False
            if started != ticket and self._active_turn is not None:
                return  # running; the next drain happens on its completion

    # ================================================================== notifications

    async def on_notification(self, method: str, params: Any) -> None:
        spec = p.SERVER_NOTIFICATIONS.get(method)
        if spec is None or spec.params is None:
            if method not in p.IGNORED_NOTIFICATIONS:
                log.debug("codex: unhandled notification %s", method)
            return
        try:
            n = spec.params.model_validate(params or {})
        except ValidationError as e:
            log.warning("codex: invalid %s notification: %s", method, e.errors()[:3])
            return
        thread_id = getattr(n, "thread_id", None)
        if thread_id and self._native_id and thread_id != self._native_id:
            await self._on_subagent_notification(method, n, thread_id)
            return
        handler = getattr(self, "_n_" + method.replace("/", "_"), None)
        if handler is not None:
            await handler(n)

    async def _n_turn_started(self, n: p.TurnStartedNotification) -> None:
        await self._on_turn_started(n.turn.id)

    async def _n_turn_completed(self, n: p.TurnCompletedNotification) -> None:
        await self._on_turn_completed(n.turn)

    async def _n_thread_started(self, n: p.ThreadStartedNotification) -> None:
        if n.thread.id != self._native_id:
            await self._announce(self._subs.thread_started(n.thread))

    async def _n_item_started(self, n: p.ItemStartedNotification) -> None:
        await self._item_started(n, None)

    async def _n_item_completed(self, n: p.ItemCompletedNotification) -> None:
        await self._item_completed(n, None)

    async def _item_started(self, n: p.ItemStartedNotification, sid: str | None) -> None:
        raw = n.item
        item_id = str(raw.get("id", ""))
        self._items[item_id] = raw
        item = m.parse_item(raw)
        if item is None or isinstance(item, p.UserMessageItem):
            return
        main = sid is None
        if isinstance(item, p.AgentMessageItem):
            if main:
                await self.set_state(AgentState.responding)
            return
        if isinstance(item, p.ReasoningItem | p.PlanItem):
            if main:
                await self.set_state(AgentState.thinking)
            return
        if isinstance(item, p.DynamicToolCallItem):
            return  # reported from the item/tool/call request, where we know args and result
        if isinstance(item, p.SubAgentActivityItem):
            await self._announce(self._subs.activity(item, n.thread_id))
            return
        if isinstance(item, p.CollabAgentToolCallItem):
            self._subs.collab_started(item, n.thread_id)
        call = m.tool_call_for(item, self._cwd)
        if call is not None and call.call_id not in self._emitted_calls:
            self._emitted_calls.add(call.call_id)
            await self._emit(m.tag(call, sid))
            if main:
                await self.set_state(AgentState.running_tool, call.summary)

    async def _item_completed(self, n: p.ItemCompletedNotification, sid: str | None) -> None:
        raw = n.item
        item_id = str(raw.get("id", ""))
        self._items.pop(item_id, None)
        item = m.parse_item(raw)
        if item is None or isinstance(item, p.UserMessageItem):
            return
        if isinstance(item, p.AgentMessageItem):
            await self._emit(Message(message_id=item.id, text=item.text, subagent_id=sid))
            self._turn_text[n.turn_id] = item.text
            if item.phase == "final_answer":
                self._turn_final[n.turn_id] = item.text
            if sid is not None:
                self._subs.note_text(sid, item.text)
            return
        if isinstance(item, p.ReasoningItem):
            text = m.reasoning_text(item)
            if text:
                await self._emit(Thinking(message_id=item.id, text=text, subagent_id=sid))
            return
        if isinstance(item, p.PlanItem):
            if item.text:
                await self._emit(Thinking(message_id=item.id, text=item.text, subagent_id=sid))
            return
        if isinstance(item, p.DynamicToolCallItem):
            return
        if isinstance(item, p.SubAgentActivityItem):
            await self._announce(self._subs.activity(item, n.thread_id))
            return
        call = m.tool_call_for(item, self._cwd)
        if call is None:
            return
        if call.call_id not in self._emitted_calls:
            await self._emit(m.tag(call, sid))
        self._emitted_calls.discard(call.call_id)
        streamed = "".join(self._cmd_output.pop(item_id, []))
        self._cmd_output_size.pop(item_id, None)
        for payload in m.tool_result_for(item, self._cwd, streamed_output=streamed):
            await self._emit(m.tag(payload, sid))
        if isinstance(item, p.CollabAgentToolCallItem):
            await self._announce(self._subs.collab_completed(item, n.thread_id))
        if sid is None and self._active_turn is not None and self._approvals_waiting == 0:
            await self.set_state(AgentState.thinking)

    # ------------------------------------------------------------------ sub-agent threads

    async def _on_subagent_notification(self, method: str, n: Any, thread_id: str) -> None:
        if method == "serverRequest/resolved":
            await self._n_serverRequest_resolved(n)
            return
        sid = await self._subagent(thread_id, activity=method not in _SUB_PASSIVE)
        if sid is None:
            log.debug("codex: ignoring %s for unknown thread %s", method, thread_id)
            return
        handler = getattr(self, "_s_" + method.replace("/", "_"), None)
        if handler is not None:
            await handler(n, sid)

    async def _subagent(self, thread_id: str, *, activity: bool) -> str | None:
        """Sub-agent id for a thread, adopting a freshly spawned one."""
        sub, started = self._subs.adopt(thread_id, activity=activity)
        if sub is None:
            return None
        await self._announce(started)
        return sub.id

    async def _announce(self, payloads: Sequence[AgentEventPayload]) -> None:
        """Emit, and look up name/model of newly seen sub-agents in the background."""
        for payload in payloads:
            await self._emit(payload)
            if isinstance(payload, SubagentStarted):
                sub = self._subs.get(payload.subagent_id)
                if sub is not None and not sub.enriched:
                    sub.enriched = True
                    self._spawn(self._enrich(payload.subagent_id), "codex-subagent-enrich")

    async def _enrich(self, thread_id: str) -> None:
        try:
            raw = await self._rpc().request(
                "thread/read", p.ThreadReadParams(thread_id=thread_id, include_turns=False).wire(), timeout=30.0
            )
            thread = p.ThreadReadResponse.model_validate(raw).thread
        except (RpcError, RpcClosed, ValidationError, TimeoutError, Unavailable) as e:
            log.info("codex: could not read sub-agent thread %s: %s", thread_id, e)
            return
        for payload in self._subs.enrich(thread_id, thread):
            await self._emit(payload)

    async def _s_turn_started(self, n: p.TurnStartedNotification, sid: str) -> None:
        await self._announce(self._subs.turn_started(sid))

    async def _s_turn_completed(self, n: p.TurnCompletedNotification, sid: str) -> None:
        tid = n.turn.id
        text = self._turn_final.pop(tid, None) or self._turn_text.get(tid)
        self._turn_text.pop(tid, None)
        if not text and n.turn.error is not None:
            text = n.turn.error.message
        await self._announce(self._subs.turn_completed(sid, n.turn.status, text))

    async def _s_item_started(self, n: p.ItemStartedNotification, sid: str) -> None:
        await self._item_started(n, sid)

    async def _s_item_completed(self, n: p.ItemCompletedNotification, sid: str) -> None:
        await self._item_completed(n, sid)

    async def _s_item_agentMessage_delta(self, n: p.AgentMessageDeltaNotification, sid: str) -> None:
        await self._emit(MessageDelta(message_id=n.item_id, text=n.delta, subagent_id=sid))

    async def _s_item_reasoning_summaryTextDelta(self, n: p.ReasoningSummaryTextDeltaNotification, sid: str) -> None:
        await self._emit(ThinkingDelta(message_id=n.item_id, text=n.delta, subagent_id=sid))

    async def _s_item_reasoning_textDelta(self, n: p.ReasoningTextDeltaNotification, sid: str) -> None:
        await self._emit(ThinkingDelta(message_id=n.item_id, text=n.delta, subagent_id=sid))

    async def _s_item_commandExecution_outputDelta(
        self, n: p.CommandExecutionOutputDeltaNotification, sid: str
    ) -> None:
        await self._n_item_commandExecution_outputDelta(n)

    async def _s_item_fileChange_patchUpdated(self, n: p.FileChangePatchUpdatedNotification, sid: str) -> None:
        await self._n_item_fileChange_patchUpdated(n)

    async def _s_thread_tokenUsage_updated(self, n: p.ThreadTokenUsageUpdatedNotification, sid: str) -> None:
        # kept for SubagentCompleted.usage; not emitted as agent.usage (other modules sum those
        # per task and count each as a turn)
        self._subs.token_usage(sid, n.token_usage)

    async def _s_thread_closed(self, n: p.ThreadClosedNotification, sid: str) -> None:
        await self._announce(self._subs.closed(sid))

    async def _s_error(self, n: p.ErrorNotification, sid: str) -> None:
        log.info("codex: sub-agent %s error (retry=%s): %s", sid, n.will_retry, n.error.message)

    async def _for_thread(self, req: PermissionRequest, thread_id: str | None) -> PermissionRequest:
        """Attach the sub-agent a server request comes from."""
        if not thread_id or thread_id == self._native_id or self._native_id is None:
            return req
        sid = await self._subagent(thread_id, activity=True)
        return req.model_copy(update={"subagent_id": sid}) if sid else req

    async def _n_item_agentMessage_delta(self, n: p.AgentMessageDeltaNotification) -> None:
        if self._state != AgentState.responding:
            await self.set_state(AgentState.responding)
        await self._emit(MessageDelta(message_id=n.item_id, text=n.delta))

    async def _n_item_reasoning_summaryTextDelta(self, n: p.ReasoningSummaryTextDeltaNotification) -> None:
        await self._emit(ThinkingDelta(message_id=n.item_id, text=n.delta))

    async def _n_item_reasoning_textDelta(self, n: p.ReasoningTextDeltaNotification) -> None:
        await self._emit(ThinkingDelta(message_id=n.item_id, text=n.delta))

    async def _n_item_commandExecution_outputDelta(self, n: p.CommandExecutionOutputDeltaNotification) -> None:
        size = self._cmd_output_size.get(n.item_id, 0)
        if size >= CMD_OUTPUT_CAP:
            return
        self._cmd_output.setdefault(n.item_id, []).append(n.delta)
        self._cmd_output_size[n.item_id] = size + len(n.delta)

    async def _n_item_fileChange_patchUpdated(self, n: p.FileChangePatchUpdatedNotification) -> None:
        raw = self._items.get(n.item_id)
        if raw is not None:
            raw["changes"] = [c.model_dump(by_alias=True) for c in n.changes]

    async def _n_thread_tokenUsage_updated(self, n: p.ThreadTokenUsageUpdatedNotification) -> None:
        base = self._turn_base.get(n.turn_id)
        if base is None:
            base = m.turn_base(n.token_usage)
            self._turn_base[n.turn_id] = base
        usage = m.usage_since(n.token_usage, base)
        self._turn_usage[n.turn_id] = usage
        await self._emit(usage)

    async def _n_account_rateLimits_updated(self, n: p.AccountRateLimitsUpdatedNotification) -> None:
        windows = m.limit_windows(n.rate_limits, source="event")
        if windows:
            await self._limits(windows)

    async def _n_error(self, n: p.ErrorNotification) -> None:
        code = n.error.codex_error_info
        code_str = code if isinstance(code, str) else next(iter(code), None) if isinstance(code, dict) else None
        detail = f" ({m.one_line(n.error.additional_details, 300)})" if n.error.additional_details else ""
        prefix = "Codex yeniden deniyor" if n.will_retry else "Codex hatası"
        await self._emit(
            AgentErrorEv(message=f"{prefix}: {n.error.message}{detail}", retryable=n.will_retry, code=code_str)
        )

    async def _n_thread_status_changed(self, n: p.ThreadStatusChangedNotification) -> None:
        if n.status.type == "systemError":
            await self.set_state(AgentState.error, "Codex sistem hatası bildirdi.")
        elif (
            n.status.type == "idle"
            and self._active_turn is None
            and self._state
            in (
                AgentState.thinking,
                AgentState.responding,
                AgentState.running_tool,
            )
        ):
            await self.set_state(AgentState.idle)

    async def _n_serverRequest_resolved(self, n: p.ServerRequestResolvedNotification) -> None:
        if self._conn is not None and self._conn.cancel_server_request(n.request_id):
            log.info("codex: server request %s resolved by the server; dropping it", n.request_id)

    async def _n_thread_closed(self, n: p.ThreadClosedNotification) -> None:
        log.info("codex: thread %s closed by the server", n.thread_id)

    async def _n_model_rerouted(self, n: p.ModelReroutedNotification) -> None:
        self.model = n.to_model
        await self.set_state(self._state, f"Model değişti: {n.from_model} → {n.to_model}")

    async def _n_warning(self, n: p.WarningNotification) -> None:
        log.info("codex warning: %s", n.message)

    # ================================================================== server requests

    async def on_request(self, method: str, params: Any, request_id: int | str) -> Any:
        spec = p.SERVER_REQUESTS.get(method)
        if spec is None:
            raise RpcError(-32601, f"AI Studio does not handle {method}")
        parsed: Any = None
        if spec.params is not None:
            try:
                parsed = spec.params.model_validate(params or {})
            except ValidationError as e:
                raise RpcError(-32602, f"invalid params for {method}: {e.errors()[:2]}") from e
        handler = getattr(self, "_r_" + method.replace("/", "_"))
        return await handler(parsed, request_id)

    async def _r_item_commandExecution_requestApproval(
        self, params: p.CommandExecutionRequestApprovalParams, request_id: int | str
    ) -> dict[str, Any]:
        req = m.command_permission(params, self._request_id(params.item_id, request_id))
        req = await self._for_thread(req, params.thread_id)
        decision = await self._decide(req)
        return p.CommandExecutionRequestApprovalResponse(decision="accept" if decision.allow else "decline").wire()

    async def _r_item_fileChange_requestApproval(
        self, params: p.FileChangeRequestApprovalParams, request_id: int | str
    ) -> dict[str, Any]:
        raw = self._items.get(params.item_id) or {}
        changes = [p.FileUpdateChange.model_validate(c) for c in raw.get("changes") or [] if isinstance(c, dict)]
        req = m.file_change_permission(params, changes, self._cwd, self._request_id(params.item_id, request_id))
        req = await self._for_thread(req, params.thread_id)
        if self._advisor:
            log.info("codex: advisor session; declining file change %s", req.paths)
            return p.FileChangeRequestApprovalResponse(decision="decline").wire()
        decision = await self._decide(req)
        return p.FileChangeRequestApprovalResponse(decision="accept" if decision.allow else "decline").wire()

    async def _r_item_permissions_requestApproval(
        self, params: p.PermissionsRequestApprovalParams, request_id: int | str
    ) -> dict[str, Any]:
        req = m.permissions_permission(params, self._request_id(params.item_id, request_id))
        req = await self._for_thread(req, params.thread_id)
        if self._advisor and m.wants_write(params):
            return p.PermissionsRequestApprovalResponse(permissions=p.GrantedPermissionProfile()).wire()
        decision = await self._decide(req)
        granted = m.granted_permissions(params) if decision.allow else p.GrantedPermissionProfile()
        return p.PermissionsRequestApprovalResponse(permissions=granted, scope="turn").wire()

    async def _r_item_tool_call(self, params: p.DynamicToolCallParams, request_id: int | str) -> dict[str, Any]:
        name = f"{params.namespace}.{params.tool}" if params.namespace else params.tool
        args = m.as_args(params.arguments)
        sid = None
        if params.thread_id and params.thread_id != self._native_id and self._native_id is not None:
            sid = await self._subagent(params.thread_id, activity=True)
        await self._emit(
            ToolCall(
                call_id=params.call_id,
                tool=name,
                kind=ToolKind.studio,
                input=args,
                summary=m.one_line(f"Studio aracı çağrılıyor: {name}"),
                subagent_id=sid,
            )
        )
        if sid is None:
            await self.set_state(AgentState.running_tool, f"Studio aracı: {name}")
        if params.namespace is None and params.tool in self._tool_names:
            try:
                result = await self._tools.call(params.tool, args)
            except Exception as e:  # ToolHost should not raise; never let it kill the session
                log.exception("codex: studio tool %s raised", name)
                result = ToolResult(content=f"Tool error: {e}", is_error=True)
        else:
            result = ToolResult(content=f"Unknown or not permitted tool: {name}", is_error=True)
        await self._emit(
            ToolResultEv(
                call_id=params.call_id,
                output=truncate(result.content, m.OUTPUT_LIMIT),
                is_error=result.is_error,
                subagent_id=sid,
            )
        )
        if sid is None and self._active_turn is not None and self._approvals_waiting == 0:
            await self.set_state(AgentState.thinking)
        return p.DynamicToolCallResponse(
            content_items=[p.DynamicToolCallOutputText(text=result.content)], success=not result.is_error
        ).wire()

    async def _r_item_tool_requestUserInput(
        self, params: p.ToolRequestUserInputParams, request_id: int | str
    ) -> dict[str, Any]:
        # Questions to the user go through the ask_user Studio tool; this experimental channel
        # is answered empty so the turn continues.
        log.info("codex: requestUserInput with %d question(s) answered empty", len(params.questions))
        return p.ToolRequestUserInputResponse(answers={}).wire()

    async def _r_mcpServer_elicitation_request(self, params: Any, request_id: int | str) -> dict[str, Any]:
        return p.McpServerElicitationRequestResponse(action="decline").wire()

    async def _r_currentTime_read(self, params: Any, request_id: int | str) -> dict[str, Any]:
        return p.CurrentTimeReadResponse(current_time_at=int(time.time())).wire()

    async def _r_execCommandApproval(
        self, params: p.ExecCommandApprovalParams, request_id: int | str
    ) -> dict[str, Any]:
        command = " ".join(params.command)
        req = PermissionRequest(
            request_id=self._request_id(params.call_id, request_id),
            tool="shell",
            kind=ToolKind.command,
            input={"command": command, "cwd": params.cwd},
            summary=f"{m.one_line(m.unwrap_shell(command))} komutunu çalıştırmak istiyor",
            command=command,
            reason=params.reason,
        )
        req = await self._for_thread(req, params.conversation_id)
        decision = await self._decide(req)
        verdict: Any = "approved" if decision.allow else {"denied": {"rejection": decision.reason or "Reddedildi"}}
        return p.ReviewDecisionResponse(decision=verdict).wire()

    async def _r_applyPatchApproval(self, params: p.ApplyPatchApprovalParams, request_id: int | str) -> dict[str, Any]:
        paths = [m.rel_path(x, self._cwd) for x in params.file_changes]
        req = PermissionRequest(
            request_id=self._request_id(params.call_id, request_id),
            tool="apply_patch",
            kind=ToolKind.file_edit,
            input={"paths": paths},
            summary=f"{len(paths)} dosyada değişiklik yapmak istiyor"
            if len(paths) != 1
            else f"{paths[0]} dosyasını düzenlemek istiyor",
            paths=paths,
            reason=params.reason,
        )
        req = await self._for_thread(req, params.conversation_id)
        if self._advisor:
            return p.ApplyPatchReviewDecisionResponse(decision={"denied": {"rejection": "advisor"}}).wire()
        decision = await self._decide(req)
        verdict: Any = "approved" if decision.allow else {"denied": {"rejection": decision.reason or "Reddedildi"}}
        return p.ApplyPatchReviewDecisionResponse(decision=verdict).wire()

    def _request_id(self, item_id: str, rpc_id: int | str) -> str:
        return f"{item_id}#{rpc_id}"

    async def _decide(self, req: PermissionRequest) -> PermissionDecision:
        self._approvals_waiting += 1
        await self.set_state(AgentState.waiting_permission, req.summary)
        try:
            decision = await self._permissions(req)
        except asyncio.CancelledError:
            self._approvals_waiting -= 1
            if self._approvals_waiting == 0 and self._active_turn is not None and not self._closed:
                await self.set_state(AgentState.thinking)
            raise
        except Exception:
            log.exception("codex: permission handler failed; denying")
            decision = PermissionDecision(allow=False, reason="İzin işleyicisi hata verdi.", decided_by="policy")
        self._approvals_waiting -= 1
        if self._approvals_waiting == 0 and self._active_turn is not None:
            await self.set_state(AgentState.running_tool if decision.allow else AgentState.thinking)
        return decision

    # ================================================================== process lifecycle

    async def on_closed(self, info: CloseInfo) -> None:
        was_closed = self._closed
        self._closed = True
        if not self._started or was_closed:
            return
        expected = info.expected or self._closing
        error: str | None = None
        if not expected:
            error = f"Codex süreci beklenmedik şekilde sonlandı (çıkış kodu {info.exit_code})."
            if info.stderr_tail:
                error += f"\n{info.stderr_tail[-1500:]}"
            await self._emit(AgentErrorEv(message=error, code="process_exited"))
        status = "interrupted" if expected else "error"
        reason_text = "Oturum kapatıldı." if expected else error
        for payload in self._subs.finish_all("interrupted" if expected else "error"):
            await self._emit(payload)
        active = self._active_turn
        if active is not None:
            self._active_turn = None
            self._completed_turns.add(active)
            await self._emit(TurnCompleted(turn_id=active, status=status, error=reason_text))  # type: ignore[arg-type]
        for key, fut in list(self._futs.items()):
            if not fut.done():
                fut.set_result(TurnResult(turn_id=key, status=status, error=reason_text))  # type: ignore[arg-type]
        self._queue.clear()
        if expected:
            await self.set_state(AgentState.done)
            await self._emit(SessionEnded(reason="closed", exit_code=info.exit_code))
        else:
            await self.set_state(AgentState.error, "Codex süreci sonlandı.")
            await self._emit(SessionEnded(reason="error", exit_code=info.exit_code, error=error))

    # ================================================================== sink

    def _spawn(self, coro: Coroutine[Any, Any, Any], name: str) -> None:
        task = asyncio.create_task(coro, name=name)
        self._bg.add(task)
        task.add_done_callback(self._bg.discard)

    async def _emit(self, payload: AgentEventPayload) -> None:
        try:
            await self._sink.emit(payload)
        except Exception:
            log.exception("codex: sink.emit failed for %s", type(payload).__name__)

    async def _limits(self, windows: list[LimitWindow]) -> None:
        try:
            await self._sink.limits(windows)
        except Exception:
            log.exception("codex: sink.limits failed")
