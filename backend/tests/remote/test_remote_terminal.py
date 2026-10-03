"""Remote terminal WebSocket (real SSH server) and keystroke line reconstruction."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from remote_testlib import SshServer, start_ssh_server
from starlette.testclient import WebSocketTestSession
from starlette.websockets import WebSocketDisconnect

from aistudio.core.context import AppContext
from aistudio.core.events import ET, EventFilter
from aistudio.remote.service import RemoteServiceImpl
from aistudio.remote.terminal import LineTracker

AppCtx = tuple[TestClient, AppContext, str]


@pytest.fixture
def served(app_ctx: AppCtx, tmp_path: Path) -> Iterator[tuple[TestClient, AppContext, SshServer]]:
    client, ctx, _ = app_ctx
    server: SshServer = client.portal.call(start_ssh_server, tmp_path / "sshd")  # type: ignore[union-attr]
    yield client, ctx, server
    svc = ctx.services.get(RemoteServiceImpl)
    client.portal.call(svc.pool.close)  # type: ignore[union-attr]
    client.portal.call(server.close)  # type: ignore[union-attr]


def _host(client: TestClient, server: SshServer, environment: str) -> dict[str, Any]:
    host = client.post(
        "/api/remote/hosts",
        json={
            "name": f"term-{environment}",
            "hostname": "127.0.0.1",
            "port": server.port,
            "username": server.username,
            "auth": "key",
            "key_path": str(server.client_key_path),
            "environment": environment,
        },
    ).json()
    r = client.post(f"/api/remote/hosts/{host['id']}/trust", json={"fingerprint": server.fingerprint})
    assert r.status_code == 200, r.text
    return host


def _read_until(
    ws: WebSocketTestSession, done: Callable[[dict[str, Any]], bool], limit: int = 500
) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []
    for _ in range(limit):
        message = ws.receive_json()
        seen.append(message)
        if done(message):
            return seen
    raise AssertionError(f"condition not met; got {seen[-5:]}")


def _events(client: TestClient, ctx: AppContext, *types: str, at_least: int = 0) -> list[Any]:
    """Events of these types; waits (briefly) until at least ``at_least`` exist, because the
    handler finishes its audit writes after the client has already disconnected."""

    async def query() -> list[Any]:
        found: list[Any] = []
        for _ in range(200):
            found = await ctx.events.query(EventFilter(types=list(types)), limit=1000)
            if len(found) >= at_least:
                break
            await asyncio.sleep(0.01)
        return found

    return client.portal.call(query)  # type: ignore[union-attr]


def test_terminal_non_production_opens_directly_and_audits_lines(
    served: tuple[TestClient, AppContext, SshServer],
) -> None:
    client, ctx, server = served
    host = _host(client, server, "test")
    with client.websocket_connect(f"/api/remote/hosts/{host['id']}/terminal?cols=100&rows=30") as ws:
        opened = _read_until(ws, lambda m: m.get("state") == "open")
        assert [m["state"] for m in opened if m["kind"] == "status"] == ["connecting", "open"]
        ws.send_json({"type": "resize", "cols": 120, "rows": 40})
        ws.send_json({"type": "input", "data": "echo hello-"})
        ws.send_json({"type": "input", "data": "term\n"})
        _read_until(ws, lambda m: m.get("kind") == "output" and "hello-term" in m["data"])
        ws.send_json({"type": "input", "data": "rm -rf /tmp/nothing-here-xyz\n"})
        ws.send_json({"type": "input", "data": "exit\n"})
        _read_until(ws, lambda m: m.get("kind") == "exit")

    commands = _events(client, ctx, ET.REMOTE_COMMAND, at_least=3)
    assert [e.payload["command"] for e in commands] == ["echo hello-term", "rm -rf /tmp/nothing-here-xyz", "exit"]
    assert [e.payload["classification"]["klass"] for e in commands] == ["read", "write", "read"]
    assert all(e.payload["source"] == "terminal" and e.actor == "user" for e in commands)
    assert len({e.payload["terminal_session_id"] for e in commands}) == 1
    assert len(_events(client, ctx, "remote.terminal.opened")) == 1
    (closed,) = _events(client, ctx, "remote.terminal.closed", at_least=1)
    assert closed.payload["lines"] == 3


def test_terminal_production_requires_approval(served: tuple[TestClient, AppContext, SshServer]) -> None:
    client, ctx, server = served
    host = _host(client, server, "production")
    with client.websocket_connect(f"/api/remote/hosts/{host['id']}/terminal") as ws:
        first = ws.receive_json()
        assert first["kind"] == "status" and first["state"] == "waiting_approval"
        approval = client.get(f"/api/approvals/{first['approval_id']}").json()
        assert approval["production"] is True and approval["severity"] == "critical"
        assert approval["kind"] == "remote_command" and approval["payload"]["purpose"] == "interactive_terminal"
        decided = client.post(f"/api/approvals/{first['approval_id']}/decision", json={"approve": True})
        assert decided.status_code == 200
        _read_until(ws, lambda m: m.get("state") == "open")
        ws.send_json({"type": "input", "data": "echo prod-ok\n"})
        _read_until(ws, lambda m: m.get("kind") == "output" and "prod-ok" in m["data"])
        ws.send_json({"type": "input", "data": "exit\n"})
        _read_until(ws, lambda m: m.get("kind") == "exit")
    (opened,) = _events(client, ctx, "remote.terminal.opened")
    assert opened.payload["approval_id"] == first["approval_id"] and opened.severity.value == "high"
    (cmd,) = [e for e in _events(client, ctx, ET.REMOTE_COMMAND) if e.payload["command"] == "echo prod-ok"]
    assert cmd.payload["approval_id"] == first["approval_id"] and cmd.payload["environment"] == "production"


def test_terminal_production_rejected(served: tuple[TestClient, AppContext, SshServer]) -> None:
    client, ctx, server = served
    host = _host(client, server, "production")
    with client.websocket_connect(f"/api/remote/hosts/{host['id']}/terminal") as ws:
        first = ws.receive_json()
        client.post(f"/api/approvals/{first['approval_id']}/decision", json={"approve": False, "note": "hayır"})
        error = ws.receive_json()
        assert error["kind"] == "error" and error["code"] == "approval_denied" and "hayır" in error["message"]
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4403
    assert _events(client, ctx, "remote.terminal.opened") == []


def test_terminal_unknown_host(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    with client.websocket_connect("/api/remote/hosts/host_missing/terminal") as ws:
        message = ws.receive_json()
        assert message["kind"] == "error" and message["code"] == "not_found"
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()


# ----------------------------------------------------------------------------- LineTracker


def test_line_tracker_editing_keys() -> None:
    t = LineTracker()
    assert t.feed("ls -l") == []
    assert t.feed("a\x7f\r") == [("ls -l", False, False)]
    assert t.feed("rm -rf /\x15echo ok\n") == [("echo ok", False, False)]
    assert t.feed("abc\x03") == [] and t.feed("pwd\r") == [("pwd", False, False)]
    assert t.feed("git status foo\x17\x17bar\r") == [("git bar", False, False)]


def test_line_tracker_marks_history_and_completion_as_approximate() -> None:
    t = LineTracker()
    assert t.feed("\x1b[A\r") == []  # history recall only: nothing typed
    assert t.feed("ls\x1b[D\x1b[Cx\r") == [("lsx", True, False)]
    assert t.feed("cat /etc/hos\tts\r") == [("cat /etc/hosts", True, False)]
    assert t.feed("echo\x1bOA\r") == [("echo", True, False)]


def test_line_tracker_hides_password_prompt_input() -> None:
    t = LineTracker()
    t.observe_output("\x1b[1m[sudo] password for deploy: \x1b[0m")
    assert t.feed("hunter2-not-real\r") == [("hunter2-not-real", False, True)]
    t.observe_output("\r\nroot@host:~# ")
    assert t.feed("whoami\r") == [("whoami", False, False)]
    t.observe_output("Parola: ")
    assert t.feed("x\r")[0][2] is True
