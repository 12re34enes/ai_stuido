"""Newline-delimited JSON-RPC over a ``Transport`` process (codex app-server stdio).

* Client requests: integer ids, futures resolved by the reader task.
* Server notifications: awaited inline by the reader, so their order is preserved.
* Server requests: each handled in its own task (approvals may wait minutes for a human) and can be
  cancelled when the server sends ``serverRequest/resolved``.
* Malformed lines are logged and skipped. EOF (process exit) fails every pending request with
  :class:`RpcClosed` and calls ``on_closed`` exactly once.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from aistudio.contracts.transport import Process

log = logging.getLogger(__name__)

NotificationHandler = Callable[[str, Any], Awaitable[None]]
RequestHandler = Callable[[str, Any, "int | str"], Awaitable[Any]]
ClosedHandler = Callable[["CloseInfo"], Awaitable[None]]

METHOD_NOT_FOUND = -32601
INTERNAL_ERROR = -32603
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
STDERR_TAIL_CHARS = 4000


class RpcError(Exception):
    """A JSON-RPC error response (from the server, or raised by our handlers to answer one)."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"{message} (code {code})")
        self.code = code
        self.message = message
        self.data = data


class RpcClosed(Exception):
    """The connection is closed (process exited or close() was called)."""


class CloseInfo:
    def __init__(self, *, exit_code: int | None, stderr_tail: str, expected: bool, error: str | None) -> None:
        self.exit_code = exit_code
        self.stderr_tail = stderr_tail
        self.expected = expected  # close() was requested by us
        self.error = error  # reader failure, if any


def clean_stderr(raw: bytes | str, limit: int = STDERR_TAIL_CHARS) -> str:
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else raw
    text = _ANSI.sub("", text).strip()
    return text[-limit:]


async def _noop_notification(method: str, params: Any) -> None:
    return None


async def _reject_request(method: str, params: Any, request_id: int | str) -> Any:
    raise RpcError(METHOD_NOT_FOUND, f"client does not handle {method}")


class RpcConnection:
    def __init__(
        self,
        proc: Process,
        *,
        on_notification: NotificationHandler | None = None,
        on_request: RequestHandler | None = None,
        on_closed: ClosedHandler | None = None,
        label: str = "codex",
    ) -> None:
        self._proc = proc
        self._on_notification = on_notification or _noop_notification
        self._on_request = on_request or _reject_request
        self._on_closed = on_closed
        self._label = label
        self._ids = itertools.count(1)
        self._pending: dict[int | str, asyncio.Future[Any]] = {}
        self._serving: dict[int | str, asyncio.Task[None]] = {}
        self._write_lock = asyncio.Lock()
        self._reader: asyncio.Task[None] | None = None
        self._closed = asyncio.Event()
        self._closing = False
        self.exit_code: int | None = None
        self.stderr_tail = ""
        self.malformed_lines = 0

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self._reader is None:
            self._reader = asyncio.create_task(self._read_loop(), name=f"{self._label}-rpc-reader")

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    async def wait_closed(self) -> None:
        await self._closed.wait()

    async def close(self, *, grace: float = 5.0) -> int | None:
        """Graceful shutdown: close stdin (app-server exits on EOF), then terminate, then kill."""
        if self._closed.is_set():
            return self.exit_code
        self._closing = True
        with contextlib.suppress(Exception):
            await self._proc.close_stdin()
        if not await self._wait_reader(grace):
            log.info("%s: no exit %.1fs after stdin EOF, terminating", self._label, grace)
            with contextlib.suppress(Exception):
                await self._proc.terminate()
            if not await self._wait_reader(3.0):
                log.warning("%s: still alive after terminate, killing", self._label)
                with contextlib.suppress(Exception):
                    await self._proc.kill()
                await self._wait_reader(5.0)
        if not self._closed.is_set():  # reader never started or is stuck: finish by hand
            if self._reader is not None:
                self._reader.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._reader
            await self._finish(None)
        return self.exit_code

    async def _wait_reader(self, timeout: float) -> bool:
        if self._reader is None:
            return self._closed.is_set()
        try:
            await asyncio.wait_for(asyncio.shield(self._closed.wait()), timeout)
        except TimeoutError:
            return False
        return True

    # ------------------------------------------------------------------ sending

    async def request(self, method: str, params: Any = None, *, timeout: float | None = 60.0) -> Any:
        if self._closed.is_set() or self._closing:
            raise RpcClosed(f"{self._label}: connection closed")
        rid = next(self._ids)
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        msg: dict[str, Any] = {"id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        try:
            await self._send(msg)
            if timeout is None:
                return await fut
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(rid, None)

    async def notify(self, method: str, params: Any = None) -> None:
        msg: dict[str, Any] = {"method": method}
        if params is not None:
            msg["params"] = params
        await self._send(msg)

    async def _send(self, msg: dict[str, Any]) -> None:
        if self._closed.is_set():
            raise RpcClosed(f"{self._label}: connection closed")
        data = (json.dumps(msg, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        async with self._write_lock:
            try:
                await self._proc.write(data)
            except (BrokenPipeError, ConnectionResetError, OSError) as e:
                raise RpcClosed(f"{self._label}: write failed: {e}") from e

    def cancel_server_request(self, request_id: int | str) -> bool:
        """Stop handling a server request that the server no longer waits for."""
        task = self._serving.get(request_id)
        if task is None:
            return False
        task.cancel()
        return True

    # ------------------------------------------------------------------ reading

    async def _read_loop(self) -> None:
        error: str | None = None
        try:
            while True:
                line = await self._proc.readline()
                if not line:
                    break
                await self._dispatch(line)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            log.warning("%s: reader failed: %s", self._label, error)
        await self._finish(error)

    async def _dispatch(self, line: bytes) -> None:
        text = line.decode("utf-8", errors="replace").strip()
        if not text:
            return
        try:
            msg = json.loads(text)
        except json.JSONDecodeError:
            self._malformed(text)
            return
        if not isinstance(msg, dict):
            self._malformed(text)
            return
        method = msg.get("method")
        rid = msg.get("id")
        if isinstance(method, str):
            if rid is not None:
                self._serve(rid, method, msg.get("params"))
                return
            try:
                await self._on_notification(method, msg.get("params"))
            except Exception:
                log.exception("%s: notification handler failed for %s", self._label, method)
            return
        if rid is not None and ("result" in msg or "error" in msg):
            fut = self._pending.get(rid)
            if fut is None and isinstance(rid, str) and rid.isdigit():
                fut = self._pending.get(int(rid))
            if fut is None or fut.done():
                log.debug("%s: response for unknown request id %r", self._label, rid)
                return
            err = msg.get("error")
            if isinstance(err, dict):
                fut.set_exception(
                    RpcError(int(err.get("code", INTERNAL_ERROR)), str(err.get("message", "")), err.get("data"))
                )
            else:
                fut.set_result(msg.get("result"))
            return
        self._malformed(text)

    def _malformed(self, text: str) -> None:
        self.malformed_lines += 1
        log.warning("%s: skipping malformed line: %.200s", self._label, text)

    def _serve(self, rid: int | str, method: str, params: Any) -> None:
        task = asyncio.create_task(self._serve_one(rid, method, params), name=f"{self._label}-serve-{method}")
        self._serving[rid] = task
        task.add_done_callback(lambda _t: self._serving.pop(rid, None))

    async def _serve_one(self, rid: int | str, method: str, params: Any) -> None:
        try:
            result = await self._on_request(method, params, rid)
            response: dict[str, Any] = {"id": rid, "result": result if result is not None else {}}
        except asyncio.CancelledError:
            raise
        except RpcError as e:
            response = {"id": rid, "error": {"code": e.code, "message": e.message}}
        except Exception as e:
            log.exception("%s: request handler failed for %s", self._label, method)
            response = {"id": rid, "error": {"code": INTERNAL_ERROR, "message": f"client error: {e}"}}
        try:
            await self._send(response)
        except RpcClosed:
            log.debug("%s: could not answer %s, connection closed", self._label, method)

    async def _finish(self, error: str | None) -> None:
        if self._closed.is_set():
            return
        exit_code: int | None = None
        try:
            exit_code = await asyncio.wait_for(self._proc.wait(), 5.0)
        except TimeoutError:
            with contextlib.suppress(Exception):
                await self._proc.kill()
            with contextlib.suppress(Exception):
                exit_code = await asyncio.wait_for(self._proc.wait(), 5.0)
        except Exception as e:
            log.debug("%s: wait failed: %s", self._label, e)
        stderr = ""
        with contextlib.suppress(Exception):
            stderr = clean_stderr(await asyncio.wait_for(self._proc.read_stderr(), 5.0))
        self.exit_code = exit_code
        self.stderr_tail = stderr
        self._closed.set()
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(RpcClosed(f"{self._label}: process exited (code {exit_code})"))
        self._pending.clear()
        for task in list(self._serving.values()):
            task.cancel()
        if self._on_closed is not None:
            info = CloseInfo(exit_code=exit_code, stderr_tail=stderr, expected=self._closing, error=error)
            try:
                await self._on_closed(info)
            except Exception:
                log.exception("%s: close handler failed", self._label)
