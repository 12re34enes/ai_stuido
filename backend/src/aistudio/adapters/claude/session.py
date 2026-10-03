"""A live Claude Code process: stream-json in/out plus the SDK control protocol.

One reader task consumes stdout in order. Control requests from the CLI (``can_use_tool``,
``mcp_message``) are answered from separate tasks so a slow permission decision or Studio tool
never blocks the stream. All writes go through one lock so NDJSON lines never interleave.

Turn bookkeeping: every user message we write carries a fresh ``uuid``; the CLI echoes the
uuids a turn consumed in ``result.user_message_uuids``. That lets us tell whether a steering
message was folded into the running turn or started a turn of its own. State transitions that
decide "which turn is current" are synchronous (no ``await`` between check and update), so no
lock is needed for them.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets
import uuid
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from aistudio.adapters.claude import protocol
from aistudio.adapters.claude.limits import windows_from_rate_limit_event
from aistudio.adapters.claude.mcp import StudioMcpServer
from aistudio.adapters.claude.normalize import ClaudeNormalizer, Normalized, build_usage, cost_of
from aistudio.adapters.claude.protocol import STUDIO_SERVER, as_dict, as_int, as_list, as_str
from aistudio.adapters.claude.toolinfo import (
    permission_summary,
    tool_command,
    tool_kind,
    tool_paths,
    tool_summary,
)
from aistudio.contracts.agents import (
    AgentErrorEv,
    AgentEventPayload,
    AgentEventSink,
    AgentState,
    Message,
    PermissionDecision,
    PermissionHandler,
    PermissionRequest,
    SessionEnded,
    SessionSpec,
    SessionStarted,
    StatusChanged,
    TurnCompleted,
    TurnResult,
    TurnStarted,
)
from aistudio.contracts.tools import ToolHost
from aistudio.contracts.transport import Process
from aistudio.core.clock import utcnow
from aistudio.core.errors import NotFound, Unavailable
from aistudio.core.ids import new_id

log = logging.getLogger(__name__)

TurnStatus = Literal["success", "error", "interrupted", "max_turns"]

_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_ABORTED = frozenset({"aborted_streaming", "aborted_tools"})
_STDERR_TAIL = 4000
_MAX_TURN_HISTORY = 500
# Input of a turn the CLI started on its own (e.g. a steering message that was not folded
# into the running turn, or work resumed after a background task).
AUTO_TURN_INPUT = ""
DEFAULT_DENY_MESSAGE = "The user denied this action."
# How foreground subagents still open when their turn ends are reported.
_SUBAGENT_END: dict[TurnStatus, Literal["error", "interrupted"]] = {
    "success": "interrupted",
    "max_turns": "interrupted",
    "interrupted": "interrupted",
    "error": "error",
}


class ClaudeControlError(Exception):
    """A control request failed (error response, process exit or write failure)."""


@dataclass(eq=False)
class _Turn:
    turn_id: str
    input: str
    future: asyncio.Future[TurnResult]
    uuids: set[str] = field(default_factory=set)
    interrupt_requested: bool = False
    started: bool = False


def _clean(text: str | None) -> str | None:
    if not text:
        return None
    return _ANSI_RE.sub("", text).strip() or None


class ClaudeSession:
    """Implements :class:`aistudio.contracts.agents.AgentSessionHandle`."""

    def __init__(
        self,
        *,
        proc: Process,
        spec: SessionSpec,
        sink: AgentEventSink,
        tools: ToolHost,
        permissions: PermissionHandler,
        native_id: str,
        cli_version: str | None = None,
        on_closed: Callable[[ClaudeSession], None] | None = None,
        init_timeout: float = 90.0,
        close_timeout: float = 10.0,
    ) -> None:
        self._proc = proc
        self._spec = spec
        self._sink = sink
        self._permissions = permissions
        self._mcp = StudioMcpServer(tools)
        self._native_id = native_id
        self._cli_version = cli_version
        self._on_closed = on_closed
        self._init_timeout = init_timeout
        self._close_timeout = close_timeout
        self._norm = ClaudeNormalizer(spec.cwd)

        self._state = AgentState.starting
        self._detail: str | None = None
        self._write_lock = asyncio.Lock()
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._handlers: dict[str, asyncio.Task[None]] = {}
        self._waiting_permissions = 0
        self._req_seq = 0

        self._turns: dict[str, _Turn] = {}
        self._queue: deque[_Turn] = deque()
        self._current: _Turn | None = None
        self._last_turn: _Turn | None = None
        self._steers: dict[str, str] = {}  # uuid -> text, written mid-turn, fold not yet confirmed
        self._last_cost: float | None = None

        self._reader: asyncio.Task[None] | None = None
        self._started_ok = False
        self._closing = False
        self._ended = False
        self._closed = asyncio.Event()
        self.exit_code: int | None = None
        self.stderr_tail = ""
        self.model: str | None = spec.model
        self.init_response: dict[str, Any] = {}

    # ------------------------------------------------------------------ handle protocol

    @property
    def native_id(self) -> str | None:
        return self._native_id

    @property
    def state(self) -> AgentState:
        return self._state

    @property
    def closed(self) -> bool:
        return self._ended

    async def start(self) -> None:
        """Start reading and perform the ``initialize`` handshake. Raises ``Unavailable`` (with
        the CLI's stderr) when the process does not come up."""
        self._reader = asyncio.create_task(self._read_loop(), name=f"claude-reader-{self._native_id}")
        await self._emit(StatusChanged(state=AgentState.starting))
        try:
            self.init_response = await self.control(
                "initialize", timeout=self._init_timeout, sdkMcpServers=[STUDIO_SERVER]
            )
        except (ClaudeControlError, TimeoutError) as e:
            await self._abort()
            detail = self._stderr_summary() or str(e) or "yanıt yok"
            message = f"Claude oturumu başlatılamadı: {detail}"
            await self._emit(AgentErrorEv(message=message, retryable=True, code="start_failed"))
            raise Unavailable(message) from e
        self._started_ok = True
        started = SessionStarted(
            native_id=self._native_id, model=self._spec.model, cwd=self._spec.cwd, cli_version=self._cli_version
        )
        await self._emit(started)
        if self._current is None:
            await self._set_state(AgentState.idle)

    async def send(self, text: str) -> str:
        self._ensure_open()
        turn = self._new_turn(text)
        if self._current is None and not self._queue:
            self._claim(turn)
            await self._begin(turn)
        else:
            self._queue.append(turn)
        return turn.turn_id

    async def steer(self, text: str) -> None:
        """Write a user message while a turn runs. The CLI queues it and folds it into the running
        turn at the next tool boundary (priority ``next``); if the turn ends first, the CLI runs
        it as a turn of its own, which we then report as a new turn."""
        self._ensure_open()
        if self._current is None:
            await self.send(text)
            return
        u = str(uuid.uuid4())
        self._steers[u] = text
        await self._emit(Message(message_id=f"steer:{u}", role="user", text=text))
        ok = await self._write(protocol.user_message(text, session_id=self._native_id, uuid=u, priority="next"))
        if not ok:
            self._steers.pop(u, None)
            raise Unavailable("Claude sürecine mesaj yazılamadı.")

    async def interrupt(self) -> None:
        turn = self._current
        if turn is None or self._ended:
            return
        turn.interrupt_requested = True
        try:
            await self.control("interrupt", timeout=15.0)
        except (ClaudeControlError, TimeoutError) as e:
            log.warning("claude interrupt failed: %s", e)

    async def wait_turn(self, turn_id: str | None = None, timeout: float | None = None) -> TurnResult:
        if turn_id is not None:
            turn = self._turns.get(turn_id)
            if turn is None:
                raise NotFound(f"Tur bulunamadı: {turn_id}")
        else:
            turn = self._current or self._last_turn
            if turn is None:
                raise NotFound("Beklenecek bir tur yok.")
        return await asyncio.wait_for(asyncio.shield(turn.future), timeout)

    async def close(self) -> None:
        if self._ended or self._closing:  # already gone, or another close()/abort is running
            await self._closed.wait()
            return
        self._closing = True
        turn = self._current
        if turn is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.interrupt(), 5.0)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(asyncio.shield(turn.future), 5.0)
        with contextlib.suppress(Exception):
            await self._proc.close_stdin()
        if await self._wait_closed(self._close_timeout):
            return
        log.warning("claude process %s did not exit after stdin close; terminating", self._native_id)
        with contextlib.suppress(Exception):
            await self._proc.terminate()
        if await self._wait_closed(5.0):
            return
        with contextlib.suppress(Exception):
            await self._proc.kill()
        if await self._wait_closed(5.0):
            return
        if self._reader is not None:  # reader stuck: finish by hand
            self._reader.cancel()
            with contextlib.suppress(BaseException):
                await self._reader
        if not self._closed.is_set():
            await self._finish()

    # ------------------------------------------------------------------ control requests (ours)

    async def control(self, subtype: str, *, timeout: float | None = 30.0, **fields: Any) -> dict[str, Any]:
        """Send a control request and return its success payload (``list_permission_rules``,
        ``get_context_usage``, ``get_usage``, ...)."""
        if self._ended:
            raise ClaudeControlError("Claude süreci kapalı")
        self._req_seq += 1
        req_id = f"req_{self._req_seq}_{secrets.token_hex(4)}"
        fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        try:
            if not await self._write(protocol.control_request(req_id, {"subtype": subtype, **fields})):
                raise ClaudeControlError("control request could not be written")
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(req_id, None)

    def _on_control_response(self, msg: dict[str, Any]) -> None:
        response = as_dict(msg.get("response"))
        req_id = as_str(response.get("request_id"))
        fut = self._pending.get(req_id or "")
        if fut is None or fut.done():
            log.debug("claude: control_response for unknown request %s", req_id)
            return
        if response.get("subtype") == "error":
            fut.set_exception(ClaudeControlError(as_str(response.get("error")) or "control request failed"))
        else:
            fut.set_result(as_dict(response.get("response")))

    # ------------------------------------------------------------------ control requests (CLI's)

    def _spawn_handler(self, msg: dict[str, Any]) -> None:
        req_id = as_str(msg.get("request_id"))
        request = as_dict(msg.get("request"))
        if not req_id:
            log.warning("claude: control_request without request_id")
            return
        if req_id in self._handlers:
            return  # duplicate delivery of an in-flight request
        task = asyncio.create_task(self._handle_control(req_id, request), name=f"claude-control-{req_id}")
        self._handlers[req_id] = task

        def _done(t: asyncio.Task[None]) -> None:
            if self._handlers.get(req_id) is t:
                self._handlers.pop(req_id, None)

        task.add_done_callback(_done)

    def _on_cancel(self, msg: dict[str, Any]) -> None:
        req_id = as_str(msg.get("request_id"))
        task = self._handlers.pop(req_id or "", None)
        if task is not None:
            task.cancel()

    async def _handle_control(self, req_id: str, request: dict[str, Any]) -> None:
        subtype = as_str(request.get("subtype"))
        try:
            if subtype == "can_use_tool":
                response = await self._on_can_use_tool(req_id, request)
            elif subtype == "mcp_message":
                response = await self._on_mcp_message(request)
            elif subtype == "elicitation":
                response = {"action": "decline"}
            elif subtype == "request_user_dialog":
                return  # we declare no dialog kinds; per protocol, never answer
            else:
                await self._write(protocol.control_error(req_id, f"Unsupported control request: {subtype}"))
                return
            await self._write(protocol.control_success(req_id, response))
        except asyncio.CancelledError:
            raise  # withdrawn by control_cancel_request (or session closing): no reply
        except Exception as e:
            log.exception("claude: control request %s (%s) failed", req_id, subtype)
            await self._write(protocol.control_error(req_id, str(e) or type(e).__name__))

    async def _on_can_use_tool(self, req_id: str, request: dict[str, Any]) -> dict[str, Any]:
        tool = as_str(request.get("tool_name")) or "unknown"
        args = as_dict(request.get("input"))
        cwd = self._spec.cwd
        summary = permission_summary(tool, args, cwd)
        reason = _clean(as_str(request.get("decision_reason"))) or _clean(as_str(request.get("description")))
        blocked = as_str(request.get("blocked_path"))
        paths = tool_paths(tool, args, cwd)
        if blocked and blocked not in paths:
            paths.append(blocked)
        tool_use_id = as_str(request.get("tool_use_id"))
        perm = PermissionRequest(
            request_id=req_id,
            tool=tool,
            kind=tool_kind(tool),
            input=args,
            summary=summary,
            paths=paths,
            command=tool_command(tool, args),
            reason=reason,
            subagent_id=self._norm.subagents.permission_subagent(tool_use_id, as_str(request.get("agent_id"))),
        )
        self._waiting_permissions += 1
        await self._set_state(AgentState.waiting_permission, summary)
        try:
            decision = await self._permissions(perm)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("claude: permission handler failed for %s", tool)
            decision = PermissionDecision(allow=False, reason=f"Permission check failed: {e}")
        finally:
            self._waiting_permissions -= 1
        if decision.allow:
            updated = decision.updated_input if decision.updated_input is not None else args
            response: dict[str, Any] = {"behavior": "allow", "updatedInput": updated}
            next_state, detail = AgentState.running_tool, tool_summary(tool, updated, cwd)
        else:
            response = {"behavior": "deny", "message": decision.reason or DEFAULT_DENY_MESSAGE}
            next_state, detail = AgentState.thinking, None
        if tool_use_id:
            response["toolUseID"] = tool_use_id
        if self._waiting_permissions == 0 and self._current is not None:
            await self._set_state(next_state, detail)
        return response

    async def _on_mcp_message(self, request: dict[str, Any]) -> dict[str, Any]:
        server = as_str(request.get("server_name"))
        if server != self._mcp.name:
            raise RuntimeError(f"SDK MCP server not found: {server}")
        reply = await self._mcp.handle(as_dict(request.get("message")))
        if reply is None:  # notification: acknowledge like the official SDK does
            return {"mcp_response": {"jsonrpc": "2.0", "result": {}, "id": 0}}
        return {"mcp_response": reply}

    # ------------------------------------------------------------------ reader

    async def _read_loop(self) -> None:
        try:
            while True:
                line = await self._proc.readline()
                if not line:
                    break
                try:
                    msg = protocol.decode(line)
                except ValueError:
                    log.warning("claude: skipping malformed stdout line: %r", line[:200])
                    continue
                if msg is None:
                    continue
                try:
                    await self._dispatch(msg)
                except Exception:
                    log.exception("claude: failed to handle %r message", msg.get("type"))
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("claude: reading stdout failed")
        await self._finish()

    async def _dispatch(self, msg: dict[str, Any]) -> None:
        mtype = msg.get("type")
        if mtype == "control_request":
            self._spawn_handler(msg)
        elif mtype == "control_response":
            self._on_control_response(msg)
        elif mtype == "control_cancel_request":
            self._on_cancel(msg)
        elif mtype == "stream_event":
            await self._ensure_turn(msg)
            self._note_uuids(msg)
            await self._apply(self._norm.stream_event(msg))
        elif mtype == "assistant":
            await self._ensure_turn(msg)
            self._note_uuids(msg)
            await self._apply(self._norm.assistant(msg))
        elif mtype == "user":
            if msg.get("isReplay"):
                return
            await self._ensure_turn(msg)
            await self._apply(self._norm.user(msg))
        elif mtype == "result":
            await self._on_result(msg)
        elif mtype == "rate_limit_event":
            await self._on_rate_limit(msg)
        elif mtype == "system":
            await self._on_system(msg)
        elif mtype == "keep_alive":
            return
        else:
            log.debug("claude: ignoring message type %r", mtype)

    async def _apply(self, norm: Normalized) -> None:
        for payload in norm.payloads:
            await self._emit(payload)
        if norm.state is not None and self._current is not None and self._waiting_permissions == 0:
            await self._set_state(norm.state, norm.detail)

    async def _on_system(self, msg: dict[str, Any]) -> None:
        subtype = as_str(msg.get("subtype"))
        if subtype == "init":
            model = as_str(msg.get("model"))
            if model:
                self.model = model
                self._norm.model = model
            version = as_str(msg.get("claude_code_version"))
            if version:
                self._cli_version = version
            sid = as_str(msg.get("session_id"))
            if sid and sid != self._native_id:
                log.warning("claude: session id changed %s -> %s", self._native_id, sid)
                self._native_id = sid
        elif subtype == "task_started":
            await self._emit_all(self._norm.subagents.task_started(msg))
        elif subtype == "task_notification":
            await self._emit_all(self._norm.subagents.system_task_notification(msg))
        elif subtype == "task_updated":
            await self._emit_all(self._norm.subagents.task_updated(msg))
        elif subtype == "status":
            if msg.get("status") == "compacting" and self._current is not None:
                await self._set_state(AgentState.thinking, "Bağlam sıkıştırılıyor")
        elif subtype == "api_retry":
            attempt = as_int(msg.get("attempt"))
            total = as_int(msg.get("max_retries"))
            count = f" ({attempt}/{total})" if attempt and total else ""
            await self._emit(
                AgentErrorEv(message=f"Claude API hatası, yeniden deneniyor{count}.", retryable=True, code="api_retry")
            )

    async def _on_rate_limit(self, msg: dict[str, Any]) -> None:
        windows = windows_from_rate_limit_event(msg, observed_at=utcnow())
        if not windows:
            return
        try:
            await self._sink.limits(windows)
        except Exception:
            log.exception("claude: limit sink failed")

    # ------------------------------------------------------------------ turns

    def _new_turn(self, text: str) -> _Turn:
        turn = _Turn(turn_id=new_id("turn"), input=text, future=asyncio.get_running_loop().create_future())
        self._turns[turn.turn_id] = turn
        if len(self._turns) > _MAX_TURN_HISTORY:
            for tid in list(self._turns)[: len(self._turns) - _MAX_TURN_HISTORY]:
                if self._turns[tid].future.done():
                    del self._turns[tid]
        return turn

    def _claim(self, turn: _Turn) -> None:
        """Make ``turn`` current (synchronous on purpose)."""
        turn.started = True
        self._current = turn
        self._last_turn = turn
        self._norm.reset_turn()

    async def _begin(self, turn: _Turn) -> None:
        u = str(uuid.uuid4())
        turn.uuids.add(u)
        await self._emit(TurnStarted(turn_id=turn.turn_id, input=turn.input))
        await self._set_state(AgentState.thinking)
        if not await self._write(protocol.user_message(turn.input, session_id=self._native_id, uuid=u)):
            log.warning("claude: could not write user message for %s", turn.turn_id)

    async def _ensure_turn(self, msg: dict[str, Any]) -> None:
        """Conversation frames outside any turn mean the CLI started one by itself."""
        if self._current is not None or self._ended or msg.get("parent_tool_use_id"):
            return
        turn = self._new_turn(AUTO_TURN_INPUT)
        if self._steers:
            turn.input = "\n".join(self._steers.values())
            turn.uuids.update(self._steers)
            self._steers.clear()
        self._claim(turn)
        await self._emit(TurnStarted(turn_id=turn.turn_id, input=turn.input))
        await self._set_state(AgentState.thinking)

    def _note_uuids(self, msg: dict[str, Any]) -> None:
        if self._current is None or not self._steers:
            return
        for u in self._consumed(msg):
            if u in self._steers:
                self._steers.pop(u)
                self._current.uuids.add(u)

    @staticmethod
    def _consumed(msg: dict[str, Any]) -> set[str]:
        out = {u for u in as_list(msg.get("user_message_uuids")) if isinstance(u, str)}
        single = as_str(msg.get("user_message_uuid"))
        if single:
            out.add(single)
        return out

    @staticmethod
    def _result_status(msg: dict[str, Any], turn: _Turn) -> tuple[TurnStatus, str | None]:
        subtype = as_str(msg.get("subtype")) or ""
        terminal = as_str(msg.get("terminal_reason"))
        is_error = bool(msg.get("is_error"))
        if terminal in _ABORTED or (turn.interrupt_requested and terminal != "completed"):
            return "interrupted", None
        if subtype == "error_max_turns" or terminal == "max_turns":
            return "max_turns", "Azami tur sayısına ulaşıldı."
        if subtype == "success" and not is_error:
            return "success", None
        errors = [e for e in as_list(msg.get("errors")) if isinstance(e, str) and e]
        text = "; ".join(errors) or as_str(msg.get("result")) or subtype or "Bilinmeyen hata"
        return "error", text

    async def _on_result(self, msg: dict[str, Any]) -> None:
        if self._current is None:
            await self._ensure_turn({})
        turn = self._current
        assert turn is not None
        consumed = self._consumed(msg)
        if consumed:
            for u in list(self._steers):
                if u in consumed:
                    del self._steers[u]
                    turn.uuids.add(u)
        else:  # producer without uuid echo: assume steering was folded into this turn
            turn.uuids.update(self._steers)
            self._steers.clear()
        status, error = self._result_status(msg, turn)
        cost = cost_of(msg)
        delta = cost - self._last_cost if cost is not None and self._last_cost is not None else cost
        if cost is not None:
            self._last_cost = cost
        usage = build_usage(msg, model=self._norm.model, context_used=self._norm.context_used, cost_delta=delta)
        text = as_str(msg.get("result"))
        result = TurnResult(
            turn_id=turn.turn_id, status=status, text=text if status == "success" else None, usage=usage, error=error
        )

        # decide what runs next before any await (see module docstring)
        self._current = None
        auto: _Turn | None = None
        nxt: _Turn | None = None
        if self._closing:
            pass  # nothing new starts while closing; _finish settles what is still queued
        elif self._steers:  # written mid-turn but not folded: the CLI runs them as the next turn
            auto = self._new_turn("\n".join(self._steers.values()))
            auto.uuids.update(self._steers)
            self._steers.clear()
            self._claim(auto)
        elif self._queue:
            nxt = self._queue.popleft()
            self._claim(nxt)

        # foreground subagents cannot outlive their turn (background ones end with a task_notification)
        await self._emit_all(self._norm.subagents.finish(_SUBAGENT_END[status], foreground_only=True))
        await self._emit(usage)
        await self._emit(
            TurnCompleted(turn_id=turn.turn_id, status=status, result_text=result.text, usage=usage, error=error)
        )
        if not turn.future.done():
            turn.future.set_result(result)
        if status == "interrupted":
            await self._set_state(AgentState.interrupted)
        if auto is not None:
            await self._emit(TurnStarted(turn_id=auto.turn_id, input=auto.input))
            await self._set_state(AgentState.thinking)
        elif nxt is not None:
            await self._begin(nxt)
        else:
            await self._set_state(AgentState.idle)

    # ------------------------------------------------------------------ shutdown

    async def _wait_closed(self, timeout: float) -> bool:
        try:
            await asyncio.wait_for(self._closed.wait(), timeout)
        except TimeoutError:
            return False
        return True

    async def _abort(self) -> None:
        """Kill the process (failed start)."""
        self._closing = True
        with contextlib.suppress(Exception):
            await self._proc.kill()
        if not await self._wait_closed(5.0) and self._reader is not None:
            self._reader.cancel()
            with contextlib.suppress(BaseException):
                await self._reader
            if not self._closed.is_set():
                await self._finish()

    async def _finish(self) -> None:
        """Process ended (EOF on stdout): settle every waiter and report how it ended."""
        if self._ended:
            return
        self._ended = True
        try:
            rc: int | None = None
            try:
                rc = await asyncio.wait_for(self._proc.wait(), 5.0)
            except Exception:
                with contextlib.suppress(Exception):
                    await self._proc.kill()
                with contextlib.suppress(Exception):
                    rc = await asyncio.wait_for(self._proc.wait(), 5.0)
            self.exit_code = rc
            with contextlib.suppress(Exception):
                err = await asyncio.wait_for(self._proc.read_stderr(), 5.0)
                self.stderr_tail = err.decode("utf-8", errors="replace")[-_STDERR_TAIL:]
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(ClaudeControlError("Claude süreci sonlandı"))
            for task in list(self._handlers.values()):
                task.cancel()

            turn = self._current
            self._current = None
            unexpected = not self._closing and (rc != 0 or turn is not None)
            error_text: str | None = None
            if unexpected:
                error_text = f"Claude süreci beklenmedik şekilde sonlandı (çıkış kodu {rc})"
                detail = self._stderr_summary()
                if detail:
                    error_text += f": {detail}"
            if turn is not None and not turn.future.done():
                status: TurnStatus = "error" if unexpected else "interrupted"
                result = TurnResult(turn_id=turn.turn_id, status=status, error=error_text)
                if self._started_ok:
                    await self._emit(TurnCompleted(turn_id=turn.turn_id, status=status, error=error_text))
                turn.future.set_result(result)
            while self._queue:
                queued = self._queue.popleft()
                if not queued.future.done():
                    queued.future.set_result(
                        TurnResult(turn_id=queued.turn_id, status="error", error=error_text or "Oturum kapatıldı")
                    )
            self._steers.clear()
            if self._started_ok:
                await self._emit_all(self._norm.subagents.finish("error" if unexpected else "interrupted"))
                if error_text:
                    await self._emit(AgentErrorEv(message=error_text, retryable=True, code="process_exit"))
                reason: Literal["completed", "closed", "error", "killed"] = (
                    "closed" if self._closing else ("completed" if rc == 0 else "error")
                )
                await self._emit(SessionEnded(reason=reason, exit_code=rc, error=error_text))
                await self._set_state(AgentState.error if error_text else AgentState.done)
        finally:
            self._closed.set()
            if self._on_closed is not None:
                with contextlib.suppress(Exception):
                    self._on_closed(self)

    def _stderr_summary(self) -> str | None:
        lines = [ln.strip() for ln in self.stderr_tail.splitlines() if ln.strip()]
        if not lines:
            return None
        return _clean(" | ".join(lines[-3:]))

    # ------------------------------------------------------------------ plumbing

    def _ensure_open(self) -> None:
        if self._ended or self._closing:
            raise Unavailable("Claude oturumu kapalı.")

    async def _write(self, message: dict[str, Any]) -> bool:
        data = protocol.encode(message)
        async with self._write_lock:
            try:
                await self._proc.write(data)
            except Exception as e:  # broken pipe / process gone
                log.warning("claude: stdin write failed: %s", e)
                return False
        return True

    async def _emit(self, payload: AgentEventPayload) -> None:
        try:
            await self._sink.emit(payload)
        except Exception:
            log.exception("claude: event sink failed for %s", type(payload).__name__)

    async def _emit_all(self, payloads: Sequence[AgentEventPayload]) -> None:
        for payload in payloads:
            await self._emit(payload)

    async def _set_state(self, state: AgentState, detail: str | None = None) -> None:
        if state == self._state and detail == self._detail:
            return
        self._state = state
        self._detail = detail
        await self._emit(StatusChanged(state=state, detail=detail))
