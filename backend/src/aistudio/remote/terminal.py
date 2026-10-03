"""Interactive remote terminal over WebSocket (spec §12).

``GET /api/remote/hosts/{id}/terminal?token=..&cols=120&rows=32`` (same token + Origin check as
``/ws/events``). Production hosts require a critical approval before the shell opens. Every
submitted input line is written to the audit log as a ``remote.command`` event (actor ``user``,
``source: terminal``) with an attempted classification; lines typed at password prompts are
recorded as ``[gizli]``.

Client -> server (JSON text frames)::

    {"type": "input", "data": "ls -la\\r"}
    {"type": "resize", "cols": 120, "rows": 32}

Server -> client::

    {"kind": "status", "state": "waiting_approval" | "connecting" | "open", "approval_id": ...}
    {"kind": "output", "data": "..."}
    {"kind": "exit", "code": 0}
    {"kind": "error", "message": "...", "code": "..."}
"""

from __future__ import annotations

import asyncio
import codecs
import contextlib
import logging
import re
import time
from collections.abc import Coroutine
from typing import TYPE_CHECKING, Any

from fastapi import WebSocket, WebSocketDisconnect

from aistudio.api.auth import TOKEN_REF, token_ok, websocket_token
from aistudio.contracts.approvals import Approval, ApprovalKind
from aistudio.contracts.common import Environment
from aistudio.core.errors import StudioError
from aistudio.core.events import Severity
from aistudio.core.ids import new_id
from aistudio.remote.classify import ClassifiedCommand, Segment, classify_shell
from aistudio.remote.models import HostRecord
from aistudio.remote.ssh import SSHTransport

if TYPE_CHECKING:
    from aistudio.remote.service import RemoteServiceImpl

log = logging.getLogger(__name__)

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-_]")
_SECRET_PROMPT = re.compile(r"(?i)(password|passphrase|parola|şifre|passcode|pin|token)[^\n]{0,40}[:：]\s*$")
_MAX_LINE = 8000


def _log_failure(task: asyncio.Task[Any]) -> None:
    if not task.cancelled() and task.exception() is not None:
        log.error("terminal audit write failed", exc_info=task.exception())


async def _persist(coro: Coroutine[Any, Any, Any]) -> None:
    """Audit writes must complete even if the client disconnects (the handler is cancelled)."""
    task = asyncio.ensure_future(coro)
    task.add_done_callback(_log_failure)
    await asyncio.shield(task)


def expected_token(ws: WebSocket, svc: RemoteServiceImpl) -> str | None:
    """The API token without access to ``create_app``'s closure: ``app.state.token`` if the app
    exposes it, else the dev token, else the Keychain item the app itself uses."""
    token = getattr(ws.app.state, "token", None)
    if isinstance(token, str) and token:
        return token
    settings = svc.ctx.settings
    if settings.dev and settings.dev_token:
        return settings.dev_token
    return svc.ctx.secrets.get(TOKEN_REF)


class LineTracker:
    """Reconstructs submitted lines from raw keystrokes (best effort: history recall and tab
    completion mark the line as approximate)."""

    def __init__(self) -> None:
        self.buf: list[str] = []
        self.approximate = False
        self._esc: str | None = None  # None | "start" | "csi" | "ss3"
        self.output_tail = ""

    def observe_output(self, text: str) -> None:
        self.output_tail = (self.output_tail + _ANSI.sub("", text))[-300:]

    def at_secret_prompt(self) -> bool:
        return bool(_SECRET_PROMPT.search(self.output_tail))

    def feed(self, data: str) -> list[tuple[str, bool, bool]]:
        """Returns completed lines as (text, approximate, secret)."""
        done: list[tuple[str, bool, bool]] = []
        for c in data:
            if self._esc == "start":
                self._esc = "csi" if c == "[" else ("ss3" if c == "O" else None)
                continue
            if self._esc == "csi":
                if "@" <= c <= "~":
                    self._esc = None
                continue
            if self._esc == "ss3":
                self._esc = None
                continue
            if c == "\x1b":
                self._esc = "start"
                self.approximate = True
            elif c in "\r\n":
                if self.buf:
                    done.append(("".join(self.buf)[:_MAX_LINE], self.approximate, self.at_secret_prompt()))
                self.buf = []
                self.approximate = False
            elif c in "\x7f\b":
                if self.buf:
                    self.buf.pop()
            elif c in "\x15\x03":  # Ctrl-U clears, Ctrl-C abandons the line
                self.buf = []
                self.approximate = False
            elif c == "\x17":  # Ctrl-W: delete previous word
                while self.buf and self.buf[-1] == " ":
                    self.buf.pop()
                while self.buf and self.buf[-1] != " ":
                    self.buf.pop()
            elif c == "\t":
                self.approximate = True
            elif ord(c) >= 32:
                self.buf.append(c)
        return done


def _clamp(value: Any, low: int, high: int, default: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except (TypeError, ValueError):
        return default


async def _send(ws: WebSocket, payload: dict[str, Any]) -> None:
    with contextlib.suppress(Exception):
        await ws.send_json(payload)


async def terminal_session(ws: WebSocket, svc: RemoteServiceImpl, host_id: str) -> None:
    origin = ws.headers.get("origin")
    if (origin and origin not in svc.ctx.settings.allowed_origins) or not token_ok(
        expected_token(ws, svc) or "", websocket_token(ws)
    ):
        await ws.close(code=4401)
        return
    await ws.accept()
    try:
        host = await svc.store.get_host(host_id)
    except StudioError as e:
        await _send(ws, {"kind": "error", "message": e.message, "code": e.code})
        await ws.close(code=4404)
        return
    cols = _clamp(ws.query_params.get("cols"), 10, 1000, 120)
    rows = _clamp(ws.query_params.get("rows"), 5, 500, 32)
    term_id = new_id("term")
    production = host.environment == Environment.production

    approval: Approval | None = None
    if production:
        approval = await svc.begin_approval(
            kind=ApprovalKind.remote_command,
            title=f"Production terminal oturumu: {host.name}",
            summary=f"{host.username}@{host.hostname} üzerinde etkileşimli terminal açılacak.",
            payload={
                "host_id": host.id,
                "host_name": host.name,
                "hostname": host.hostname,
                "environment": host.environment.value,
                "purpose": "interactive_terminal",
                "terminal_session_id": term_id,
            },
            production=True,
            actor="user",
            workspace_id=host.workspace_id,
            task_id=None,
            session_id=None,
        )
        await _send(ws, {"kind": "status", "state": "waiting_approval", "approval_id": approval.id})
        approval, denial = await _wait_or_disconnect(ws, svc, approval)
        if approval is None:
            return  # client went away; approval cancelled
        if denial is not None:
            await _send(ws, {"kind": "error", "message": denial, "code": "approval_denied"})
            await ws.close(code=4403)
            return

    await _send(ws, {"kind": "status", "state": "connecting"})
    try:
        proc = await SSHTransport(svc.pool, host.id).open_terminal(cols=cols, rows=rows)
    except StudioError as e:
        await _send(ws, {"kind": "error", "message": e.message, "code": e.code, "details": e.details})
        await ws.close(code=4502)
        return
    await _persist(
        svc.ctx.events.append(
            "remote.terminal.opened",
            {
                "host_id": host.id,
                "host_name": host.name,
                "environment": host.environment.value,
                "terminal_session_id": term_id,
                "approval_id": approval.id if approval else None,
            },
            severity=Severity.high if production else Severity.info,
            actor="user",
            workspace_id=host.workspace_id,
        )
    )
    await _send(ws, {"kind": "status", "state": "open", "terminal_session_id": term_id})
    started = time.monotonic()
    tracker = LineTracker()
    stats = {"lines": 0}

    async def pump_output() -> None:
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = await proc.stdout.read(4096)
            if not chunk:
                break
            text = decoder.decode(bytes(chunk))
            if text:
                tracker.observe_output(text)
                await ws.send_json({"kind": "output", "data": text})
        await proc.wait_closed()
        await _send(ws, {"kind": "exit", "code": proc.returncode})

    async def pump_input() -> None:
        while True:
            message = await ws.receive_json()
            if not isinstance(message, dict):
                continue
            mtype = message.get("type")
            if mtype == "input":
                data = str(message.get("data") or "")
                if not data:
                    continue
                for line, approximate, secret in tracker.feed(data):
                    stats["lines"] += 1
                    await _persist(
                        _audit_line(svc, host, line, term_id, approval, approximate=approximate, secret=secret)
                    )
                proc.stdin.write(data.encode())
            elif mtype == "resize":
                proc.change_terminal_size(
                    _clamp(message.get("cols"), 10, 1000, cols), _clamp(message.get("rows"), 5, 500, rows)
                )

    output_task = asyncio.create_task(pump_output())
    input_task = asyncio.create_task(pump_input())
    try:
        done, pending = await asyncio.wait({output_task, input_task}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        for t in done:
            exc = t.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                log.warning("terminal session %s ended with %r", term_id, exc)
    finally:
        for t in (output_task, input_task):
            if not t.done():
                t.cancel()
        with contextlib.suppress(Exception):
            proc.close()
        await _persist(
            svc.ctx.events.append(
                "remote.terminal.closed",
                {
                    "host_id": host.id,
                    "terminal_session_id": term_id,
                    "lines": stats["lines"],
                    "duration_ms": int((time.monotonic() - started) * 1000),
                },
                actor="user",
                workspace_id=host.workspace_id,
            )
        )
        with contextlib.suppress(Exception):
            await ws.close()


async def _wait_or_disconnect(
    ws: WebSocket, svc: RemoteServiceImpl, approval: Approval
) -> tuple[Approval | None, str | None]:
    wait_task = asyncio.create_task(svc.wait_approval(approval))

    async def watch() -> None:
        with contextlib.suppress(Exception):
            while True:
                await ws.receive_text()  # ignore input until the session opens

    watch_task = asyncio.create_task(watch())
    try:
        done, _ = await asyncio.wait({wait_task, watch_task}, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        # Handler cancelled (client gone): cancelling wait_approval also cancels the approval.
        watch_task.cancel()
        wait_task.cancel()
        raise
    if wait_task in done:
        watch_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await watch_task
        return wait_task.result()
    wait_task.cancel()  # wait_approval cancels the pending approval on cancellation
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await wait_task
    return None, None


async def _audit_line(
    svc: RemoteServiceImpl,
    host: HostRecord,
    line: str,
    term_id: str,
    approval: Approval | None,
    *,
    approximate: bool,
    secret: bool,
) -> None:
    if secret:
        text = "[gizli]"
        cls = ClassifiedCommand("read", ("Parola istemine girilen değer kaydedilmedi",), (Segment(text, "read"),))
    else:
        text = line
        cls = classify_shell(line)
    await svc.audit_command(
        host=host,
        command=text,
        cls=cls,
        actor="user",
        outcome="terminal",
        approval=approval,
        workspace_id=host.workspace_id,
        source="terminal",
        extra={"terminal_session_id": term_id, "approximate": approximate, "secret_input": secret},
    )
