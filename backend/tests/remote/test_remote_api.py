"""/api/remote routes (all modules loaded, real token auth)."""

from __future__ import annotations

import csv
import io
import json
import sqlite3
from pathlib import Path

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient
from remote_testlib import FakeRunner, SshServer, make_password, start_ssh_server

from aistudio.core.context import AppContext
from aistudio.core.events import EventFilter
from aistudio.remote.models import HostRecord
from aistudio.remote.service import RemoteServiceImpl
from aistudio.remote.tables import remote_hosts

AppCtx = tuple[TestClient, AppContext, str]


def _svc(ctx: AppContext) -> RemoteServiceImpl:
    return ctx.services.get(RemoteServiceImpl)


def _install_runner(ctx: AppContext) -> FakeRunner:
    runner = FakeRunner()

    async def factory(host: HostRecord) -> FakeRunner:
        return runner

    _svc(ctx).runner_factory = factory
    return runner


def test_host_crud_keeps_secrets_out_of_db_and_responses(app_ctx: AppCtx) -> None:
    client, ctx, _ = app_ctx
    password = make_password()
    r = client.post(
        "/api/remote/hosts",
        json={"name": "web-1", "hostname": "10.0.0.5", "username": "deploy", "auth": "password", "password": password},
    )
    assert r.status_code == 201, r.text
    host = r.json()
    assert host["has_password"] is True and "password" not in host
    assert host["environment"] == "test" and host["permission_level"] == "read"
    assert ctx.secrets.get(f"host/{host['id']}/password") == password

    async def raw_row() -> str:
        async with ctx.db.connect() as conn:
            row = (await conn.execute(sa.select(remote_hosts).where(remote_hosts.c.id == host["id"]))).mappings().one()
        return json.dumps(dict(row), default=str)

    assert password not in client.portal.call(raw_row)  # type: ignore[union-attr]
    assert password not in client.get("/api/remote/hosts").text

    assert (
        client.post(
            "/api/remote/hosts", json={"name": "WEB-1", "hostname": "x", "username": "u", "auth": "agent"}
        ).status_code
        == 409
    )
    assert (
        client.post("/api/remote/hosts", json={"name": "x", "hostname": "bad host", "username": "u"}).status_code == 422
    )
    assert (
        client.post(
            "/api/remote/hosts", json={"name": "k", "hostname": "h", "username": "u", "auth": "key"}
        ).status_code
        == 422
    )

    r = client.patch(f"/api/remote/hosts/{host['id']}", json={"environment": "production"})
    assert r.status_code == 200 and r.json()["environment"] == "production"

    async def updated_events() -> list[dict[str, object]]:
        evs = await ctx.events.query(EventFilter(types=["remote.host.updated"]))
        return [{"severity": e.severity.value, **e.payload} for e in evs]

    (ev,) = client.portal.call(updated_events)  # type: ignore[union-attr]
    assert ev["severity"] == "high" and ev["changes"] == {"environment": ["test", "production"]}  # type: ignore[comparison-overlap]

    r = client.patch(f"/api/remote/hosts/{host['id']}", json={"password": ""})
    assert r.status_code == 422  # password auth without a password is refused
    r = client.patch(f"/api/remote/hosts/{host['id']}", json={"auth": "agent", "password": ""})
    assert r.status_code == 200 and r.json()["has_password"] is False
    assert ctx.secrets.get(f"host/{host['id']}/password") is None

    jump = client.post(
        "/api/remote/hosts", json={"name": "bastion", "hostname": "b", "username": "u", "auth": "agent"}
    ).json()
    assert client.patch(f"/api/remote/hosts/{host['id']}", json={"jump_host_id": jump["id"]}).status_code == 200
    cycle = client.patch(f"/api/remote/hosts/{jump['id']}", json={"jump_host_id": host["id"]})
    assert cycle.status_code == 422 and "döngü" in cycle.json()["error"]["message"]
    assert client.delete(f"/api/remote/hosts/{jump['id']}").status_code == 409
    assert client.delete(f"/api/remote/hosts/{host['id']}").status_code == 204
    assert client.get(f"/api/remote/hosts/{host['id']}").status_code == 404
    assert client.delete(f"/api/remote/hosts/{jump['id']}").status_code == 204


def test_moving_to_production_resets_level_to_read(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    host = client.post(
        "/api/remote/hosts",
        json={"name": "h", "hostname": "h", "username": "u", "auth": "agent", "permission_level": "full"},
    ).json()
    moved = client.patch(f"/api/remote/hosts/{host['id']}", json={"environment": "production"}).json()
    assert moved["environment"] == "production" and moved["permission_level"] == "read"
    explicit = client.patch(f"/api/remote/hosts/{host['id']}", json={"permission_level": "limited"}).json()
    assert explicit["permission_level"] == "limited"  # an explicit choice is respected
    db = client.post(
        "/api/remote/db-profiles", json={"name": "d", "kind": "redis", "host": "c", "permission_level": "full"}
    ).json()
    moved_db = client.patch(f"/api/remote/db-profiles/{db['id']}", json={"environment": "production"}).json()
    assert moved_db["permission_level"] == "read"
    both = client.patch(
        f"/api/remote/db-profiles/{db['id']}", json={"environment": "test", "permission_level": "full"}
    ).json()
    assert both["permission_level"] == "full"


def test_db_profile_crud(app_ctx: AppCtx, tmp_path: Path) -> None:
    client, _, _ = app_ctx
    db = tmp_path / "x.db"
    sqlite3.connect(db).close()
    r = client.post("/api/remote/db-profiles", json={"name": "local", "kind": "sqlite", "database": str(db)})
    assert r.status_code == 201, r.text
    profile = r.json()
    assert profile["permission_level"] == "read" and profile["has_password"] is False
    pw = make_password()
    r = client.post(
        "/api/remote/db-profiles",
        json={"name": "pg", "kind": "postgres", "host": "db.internal", "username": "app", "password": pw},
    )
    assert r.status_code == 201 and r.json()["has_password"]
    bad = client.post("/api/remote/db-profiles", json={"name": "z", "kind": "postgres", "options": {"api_token": "x"}})
    assert bad.status_code == 422
    r = client.patch(f"/api/remote/db-profiles/{profile['id']}", json={"permission_level": "full"})
    assert r.json()["permission_level"] == "full"
    assert client.post(f"/api/remote/db-profiles/{profile['id']}/test").json()["ok"] is True
    assert client.delete(f"/api/remote/db-profiles/{profile['id']}").status_code == 204
    assert len(client.get("/api/remote/db-profiles").json()) == 1


def test_classify_endpoint(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    r = client.post("/api/remote/classify", json={"language": "shell", "text": "ls; rm -rf /"}).json()
    assert r["klass"] == "write" and [s["klass"] for s in r["segments"]] == ["read", "write"]
    r = client.post("/api/remote/classify", json={"language": "sql", "dialect": "mysql", "text": "SHOW TABLES"}).json()
    assert r["klass"] == "read"
    r = client.post("/api/remote/classify", json={"language": "redis", "text": "FLUSHALL"}).json()
    assert r["klass"] == "write"
    r = client.post("/api/remote/classify", json={"language": "mongodb", "text": '{"find": "x"}'}).json()
    assert r["klass"] == "read"


def test_exec_query_and_audit_export(app_ctx: AppCtx, tmp_path: Path) -> None:
    client, ctx, _ = app_ctx
    runner = _install_runner(ctx)
    host = client.post(
        "/api/remote/hosts",
        json={"name": "app", "hostname": "h", "username": "u", "auth": "agent", "permission_level": "full"},
    ).json()
    r = client.post(f"/api/remote/hosts/{host['id']}/exec", json={"command": "uptime", "reason": "kontrol"})
    assert r.status_code == 200 and r.json()["exit_code"] == 0 and runner.commands == ["uptime"]
    client.post(f"/api/remote/hosts/{host['id']}/exec", json={"command": "touch /tmp/x"})

    db = tmp_path / "a.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE t (a INTEGER)")
    conn.execute("INSERT INTO t VALUES (42)")
    conn.commit()
    conn.close()
    profile = client.post("/api/remote/db-profiles", json={"name": "a", "kind": "sqlite", "database": str(db)}).json()
    q = client.post(f"/api/remote/db-profiles/{profile['id']}/query", json={"query": "SELECT a FROM t"}).json()
    assert q["rows"] == [[42]] and q["columns"] == ["a"]

    page = client.get("/api/remote/audit").json()
    assert [e["command"] for e in page["entries"]] == ["SELECT a FROM t", "touch /tmp/x", "uptime"]
    assert page["entries"][2]["reason"] == "kontrol" and page["entries"][2]["klass"] == "read"
    assert page["entries"][0]["target_kind"] == "db"
    hosts_only = client.get("/api/remote/audit", params={"kind": "host", "klass": "write"}).json()
    assert [e["command"] for e in hosts_only["entries"]] == ["touch /tmp/x"]
    limited = client.get("/api/remote/audit", params={"limit": 1}).json()
    assert limited["has_more"] and limited["next_before_id"]
    rest = client.get("/api/remote/audit", params={"before_id": limited["next_before_id"]}).json()
    assert len(rest["entries"]) == 2
    assert client.get("/api/remote/audit", params={"q": "UPTIME"}).json()["entries"][0]["command"] == "uptime"

    exported = client.get("/api/remote/audit/export", params={"format": "csv"})
    assert exported.status_code == 200 and exported.headers["content-type"].startswith("text/csv")
    assert "attachment" in exported.headers["content-disposition"]
    rows = list(csv.DictReader(io.StringIO(exported.text)))
    assert [r["command"] for r in rows] == ["uptime", "touch /tmp/x", "SELECT a FROM t"]
    assert all(len(r["hash"]) == 64 for r in rows)
    as_json = client.get("/api/remote/audit/export", params={"format": "json", "kind": "db"}).json()
    assert [e["command"] for e in as_json] == ["SELECT a FROM t"]


def test_websocket_routes_reject_bad_token(app_ctx: AppCtx) -> None:
    from starlette.websockets import WebSocketDisconnect

    client, _, _ = app_ctx
    host = client.post(
        "/api/remote/hosts", json={"name": "t", "hostname": "h", "username": "u", "auth": "agent"}
    ).json()
    url = f"/api/remote/hosts/{host['id']}/terminal?token=wrong"
    with (
        pytest.raises(WebSocketDisconnect) as exc,
        client.websocket_connect(url, headers={"Authorization": "Bearer wrong"}) as ws,
    ):
        ws.receive_json()
    assert exc.value.code == 4401
    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(
            f"/api/remote/hosts/{host['id']}/terminal", headers={"Origin": "https://evil.example"}
        ) as ws,
    ):
        ws.receive_json()


def test_host_test_and_trust_endpoints(app_ctx: AppCtx, tmp_path: Path) -> None:
    client, _, _ = app_ctx
    server: SshServer = client.portal.call(start_ssh_server, tmp_path / "sshd")  # type: ignore[union-attr]
    try:
        host = client.post(
            "/api/remote/hosts",
            json={
                "name": "local-ssh",
                "hostname": "127.0.0.1",
                "port": server.port,
                "username": server.username,
                "auth": "key",
                "key_path": str(server.client_key_path),
            },
        ).json()
        first = client.post(f"/api/remote/hosts/{host['id']}/test").json()
        assert first["ok"] is False and first["error_code"] == "host_key_unknown"
        assert first["details"]["fingerprint"] == server.fingerprint
        wrong = client.post(f"/api/remote/hosts/{host['id']}/trust", json={"fingerprint": "SHA256:wrong-print"})
        assert wrong.status_code == 422
        trusted = client.post(f"/api/remote/hosts/{host['id']}/trust", json={"fingerprint": server.fingerprint})
        assert trusted.status_code == 200 and trusted.json()["key_type"] == "ssh-ed25519"
        second = client.post(f"/api/remote/hosts/{host['id']}/test").json()
        assert second["ok"] is True and second["message"] == "Bağlantı başarılı."
        agents = client.get(f"/api/remote/hosts/{host['id']}/agents").json()
        assert {a["provider"] for a in agents} == {"claude", "codex"}
    finally:
        svc = _svc(app_ctx[1])
        client.portal.call(svc.pool.close)  # type: ignore[union-attr]
        client.portal.call(server.close)  # type: ignore[union-attr]


def test_ssh_config_routes(app_ctx: AppCtx, user_home: Path) -> None:
    client, _, _ = app_ctx
    (user_home / ".ssh" / "config").write_text("Host alpha\n  HostName alpha.example\n  User ops\n")
    preview = client.get("/api/remote/ssh-config").json()
    assert preview == [
        {
            "alias": "alpha",
            "hostname": "alpha.example",
            "user": "ops",
            "port": 22,
            "identity_file": None,
            "proxy_jump": None,
            "exists": False,
        }
    ]
    result = client.post("/api/remote/hosts/import-ssh-config", json={}).json()
    assert [h["name"] for h in result["created"]] == ["alpha"]
    assert client.get("/api/remote/ssh-config").json()[0]["exists"] is True
