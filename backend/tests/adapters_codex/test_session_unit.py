"""CodexSession edge cases with a stub connection (no subprocess)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from aistudio.adapters.codex.protocol import Turn
from aistudio.adapters.codex.rpc import RpcClosed, RpcConnection, RpcError
from aistudio.adapters.codex.session import CodexSession
from aistudio.contracts.agents import AgentErrorEv, SessionSpec, TurnStarted
from aistudio.core.errors import Unavailable

from .conftest import FakeToolHost, Permissions, RecordingSink

Handler = Callable[[str, Any], Awaitable[Any]]


class StubConn:
    def __init__(self, handler: Handler) -> None:
        self.handler = handler
        self.calls: list[tuple[str, Any]] = []
        self.closed = False

    async def request(self, method: str, params: Any = None, *, timeout: float | None = 60.0) -> Any:
        self.calls.append((method, params))
        return await self.handler(method, params)

    def cancel_server_request(self, request_id: int | str) -> bool:
        return False

    async def close(self, *, grace: float = 5.0) -> int | None:
        self.closed = True
        return 0


def make_session(handler: Handler) -> tuple[CodexSession, StubConn, RecordingSink]:
    sink = RecordingSink()
    session = CodexSession(
        spec=SessionSpec(provider="codex", cwd="/w"),
        sink=sink,
        tools=FakeToolHost(),
        permissions=Permissions(),
        tool_names=set(),
    )
    conn = StubConn(handler)
    session.attach(conn)  # type: ignore[arg-type]
    session.mark_started("thr", model="m", cli_version="0.160.0")
    return session, conn, sink


def turn(tid: str) -> dict[str, Any]:
    return {"turn": {"id": tid, "items": [], "status": "inProgress", "error": None}}


async def test_failed_start_still_runs_queued_messages() -> None:
    gate = asyncio.Event()
    starts = 0

    async def handler(method: str, params: Any) -> Any:
        nonlocal starts
        if method == "turn/start":
            starts += 1
            if starts == 1:
                await gate.wait()
                raise RpcError(-32600, "thread not loaded")
            return turn("t2")
        return {}

    session, _conn, sink = make_session(handler)
    first = asyncio.create_task(session.send("A"))
    await asyncio.sleep(0.01)
    ticket = await session.send("B")
    assert ticket.startswith("queued_")
    gate.set()
    with pytest.raises(Unavailable):
        await first
    for _ in range(100):
        if sink.of(TurnStarted):
            break
        await asyncio.sleep(0.01)
    assert [t.turn_id for t in sink.of(TurnStarted)] == ["t2"]
    assert sink.of(TurnStarted)[0].input == "B"


async def test_queued_start_failure_resolves_ticket_with_error() -> None:
    gate = asyncio.Event()

    async def handler(method: str, params: Any) -> Any:
        if method == "turn/start":
            if params["input"][0]["text"] == "A":
                return turn("t1")
            await gate.wait()
            raise RpcClosed("gone")
        return {}

    session, _conn, sink = make_session(handler)
    await session.send("A")
    ticket = await session.send("B")
    await session._on_turn_completed(Turn(id="t1", status="completed"))  # A done -> B starts from the queue
    gate.set()
    result = await session.wait_turn(ticket, timeout=2)
    assert result.status == "error" and result.error is not None and "başlatılamadı" in result.error
    assert any(isinstance(e, AgentErrorEv) and e.code == "turn_start_failed" for e in sink.events)


async def test_steer_transport_failure_is_unavailable() -> None:
    async def handler(method: str, params: Any) -> Any:
        if method == "turn/start":
            return turn("t1")
        if method == "turn/steer":
            raise RpcClosed("pipe closed")
        return {}

    session, _conn, _sink = make_session(handler)
    await session.send("A")
    with pytest.raises(Unavailable):
        await session.steer("yön")


async def test_interrupt_during_start_is_deferred() -> None:
    gate = asyncio.Event()

    async def handler(method: str, params: Any) -> Any:
        if method == "turn/start":
            await gate.wait()
            return turn("t1")
        if method == "turn/interrupt":
            return {}
        return {}

    session, conn, _sink = make_session(handler)
    sending = asyncio.create_task(session.send("A"))
    await asyncio.sleep(0.01)
    await session.interrupt()  # turn/start still in flight
    gate.set()
    assert await sending == "t1"
    for _ in range(100):
        if any(m == "turn/interrupt" for m, _ in conn.calls):
            break
        await asyncio.sleep(0.01)
    assert ("turn/interrupt", {"threadId": "thr", "turnId": "t1"}) in conn.calls


async def test_interrupt_does_not_hang_when_server_never_answers() -> None:
    never = asyncio.Event()

    async def handler(method: str, params: Any) -> Any:
        if method == "turn/start":
            return turn("t1")
        if method == "turn/interrupt":
            await never.wait()  # real 0.160.0 behaviour for an already finished turn
        return {}

    session, _conn, _sink = make_session(handler)
    await session.send("A")
    interrupting = asyncio.create_task(session.interrupt())
    await asyncio.sleep(0.01)
    await session._on_turn_completed(Turn(id="t1", status="interrupted"))
    await asyncio.wait_for(interrupting, 1)


def test_stub_matches_connection_surface() -> None:
    for name in ("request", "cancel_server_request", "close"):
        assert hasattr(RpcConnection, name)
