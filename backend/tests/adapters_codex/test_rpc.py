"""RpcConnection unit tests with an in-memory process double."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from aistudio.adapters.codex.rpc import CloseInfo, RpcClosed, RpcConnection, RpcError, clean_stderr


class MemProcess:
    def __init__(self, *, exit_on_stdin_close: bool = True) -> None:
        self.lines: asyncio.Queue[bytes] = asyncio.Queue()
        self.written: list[dict[str, Any]] = []
        self.exit_on_stdin_close = exit_on_stdin_close
        self.returncode: int | None = None
        self.exited = asyncio.Event()
        self.stderr = b"\x1b[31mERROR\x1b[0m something broke\n"
        self.terminated = False
        self.killed = False

    @property
    def pid(self) -> int | None:
        return 1

    async def write(self, data: bytes) -> None:
        if self.returncode is not None:
            raise BrokenPipeError("closed")
        self.written.append(json.loads(data))

    async def close_stdin(self) -> None:
        if self.exit_on_stdin_close:
            self.exit(0)

    async def readline(self) -> bytes:
        return await self.lines.get()

    async def read_stderr(self) -> bytes:
        return self.stderr

    async def wait(self) -> int:
        await self.exited.wait()
        assert self.returncode is not None
        return self.returncode

    async def terminate(self) -> None:
        self.terminated = True

    async def kill(self) -> None:
        self.killed = True
        self.exit(-9)

    # test helpers
    def feed(self, obj: Any) -> None:
        self.lines.put_nowait((obj if isinstance(obj, str) else json.dumps(obj)).encode() + b"\n")

    def exit(self, code: int) -> None:
        if self.returncode is None:
            self.returncode = code
            self.lines.put_nowait(b"")
            self.exited.set()


async def _next_write(proc: MemProcess, n: int) -> dict[str, Any]:
    for _ in range(200):
        if len(proc.written) >= n:
            return proc.written[n - 1]
        await asyncio.sleep(0.01)
    raise AssertionError("no write")


async def test_request_response_and_errors() -> None:
    proc = MemProcess()
    conn = RpcConnection(proc)
    conn.start()
    task = asyncio.create_task(conn.request("thread/read", {"threadId": "t"}))
    sent = await _next_write(proc, 1)
    assert sent == {"id": 1, "method": "thread/read", "params": {"threadId": "t"}}
    proc.feed({"id": 1, "result": {"ok": True}})
    assert await task == {"ok": True}

    task2 = asyncio.create_task(conn.request("x"))
    sent2 = await _next_write(proc, 2)
    assert "params" not in sent2
    proc.feed({"id": sent2["id"], "error": {"code": -32600, "message": "bad", "data": {"a": 1}}})
    with pytest.raises(RpcError) as exc:
        await task2
    assert exc.value.code == -32600 and exc.value.message == "bad" and exc.value.data == {"a": 1}
    await conn.close()


async def test_notifications_in_order_and_malformed_lines_skipped() -> None:
    proc = MemProcess()
    seen: list[tuple[str, Any]] = []

    async def on_note(method: str, params: Any) -> None:
        if method == "boom":
            raise RuntimeError("handler bug")
        seen.append((method, params))

    conn = RpcConnection(proc, on_notification=on_note)
    conn.start()
    proc.feed("not json")
    proc.feed("[1]")
    proc.feed({"weird": True})
    proc.feed({"method": "boom"})
    proc.feed({"method": "a", "params": {"n": 1}, "emittedAtMs": 5})
    proc.feed({"method": "b"})
    proc.feed({"id": 99, "result": {}})  # unknown response id: ignored
    proc.feed("")
    for _ in range(100):
        if len(seen) == 2:
            break
        await asyncio.sleep(0.01)
    assert seen == [("a", {"n": 1}), ("b", None)]
    assert conn.malformed_lines == 3
    await conn.close()


async def test_server_requests_answered_and_cancellable() -> None:
    proc = MemProcess()
    gate = asyncio.Event()

    async def on_request(method: str, params: Any, rid: int | str) -> Any:
        if method == "fail":
            raise RpcError(-32001, "nope")
        if method == "crash":
            raise ValueError("bug")
        if method == "slow":
            await gate.wait()
        return {"echo": params, "rid": rid}

    conn = RpcConnection(proc, on_request=on_request)
    conn.start()
    proc.feed({"id": 0, "method": "ok", "params": {"x": 1}})
    proc.feed({"id": "s1", "method": "fail"})
    proc.feed({"id": 2, "method": "crash"})
    proc.feed({"id": 3, "method": "slow"})
    await _next_write(proc, 3)
    by_id = {w["id"]: w for w in proc.written}
    assert by_id[0] == {"id": 0, "result": {"echo": {"x": 1}, "rid": 0}}
    assert by_id["s1"]["error"] == {"code": -32001, "message": "nope"}
    assert by_id[2]["error"]["code"] == -32603
    assert conn.cancel_server_request(3) is True
    await asyncio.sleep(0.05)
    assert 3 not in {w["id"] for w in proc.written}
    assert conn.cancel_server_request(3) is False
    await conn.close()


async def test_default_handlers_reject_requests() -> None:
    proc = MemProcess()
    conn = RpcConnection(proc)
    conn.start()
    proc.feed({"id": 7, "method": "item/tool/call", "params": {}})
    reply = await _next_write(proc, 1)
    assert reply["error"]["code"] == -32601
    await conn.close()


async def test_process_exit_fails_pending_and_reports_once() -> None:
    proc = MemProcess()
    infos: list[CloseInfo] = []

    async def on_closed(info: CloseInfo) -> None:
        infos.append(info)

    conn = RpcConnection(proc, on_closed=on_closed)
    conn.start()
    task = asyncio.create_task(conn.request("turn/start", {}))
    await _next_write(proc, 1)
    proc.exit(3)
    with pytest.raises(RpcClosed):
        await task
    await conn.wait_closed()
    assert conn.closed and conn.exit_code == 3
    assert conn.stderr_tail == "ERROR something broke"
    (info,) = infos
    assert info.exit_code == 3 and not info.expected and info.error is None
    with pytest.raises(RpcClosed):
        await conn.request("x")
    with pytest.raises(RpcClosed):
        await conn.notify("x")
    assert await conn.close() == 3
    assert len(infos) == 1


async def test_close_escalates_to_kill() -> None:
    proc = MemProcess(exit_on_stdin_close=False)
    infos: list[CloseInfo] = []

    async def on_closed(info: CloseInfo) -> None:
        infos.append(info)

    conn = RpcConnection(proc, on_closed=on_closed)
    conn.start()
    code = await conn.close(grace=0.05)
    assert proc.terminated and proc.killed and code == -9
    assert infos[0].expected is True


async def test_request_timeout() -> None:
    proc = MemProcess()
    conn = RpcConnection(proc)
    conn.start()
    with pytest.raises(TimeoutError):
        await conn.request("never", timeout=0.05)
    await conn.close()


def test_clean_stderr_strips_ansi_and_keeps_tail() -> None:
    assert clean_stderr(b"\x1b[2mfoo\x1b[0m bar") == "foo bar"
    assert clean_stderr("x" * 10 + "END", limit=3) == "END"
