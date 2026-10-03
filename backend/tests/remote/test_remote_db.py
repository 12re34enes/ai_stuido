"""db_query(): classification, policy, approvals, read-only enforcement and drivers."""

from __future__ import annotations

import asyncio
import sqlite3
import sys
import types
from pathlib import Path
from typing import Any

import pytest
from remote_testlib import RemoteEnv, auto_decide

from aistudio.contracts.approvals import ApprovalKind
from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.tools import ToolContext
from aistudio.core.errors import ValidationFailed
from aistudio.core.events import ET, Severity
from aistudio.remote import dbexec
from aistudio.remote.classify import parse_mongo
from aistudio.remote.dbexec import (
    DbTarget,
    MongoDriver,
    MssqlDriver,
    MysqlDriver,
    PostgresDriver,
    PreparedQuery,
    QueryOutcome,
    RedisDriver,
    SqliteDriver,
    cell,
)


@pytest.fixture
def sqlite_db(tmp_path: Path) -> Path:
    path = tmp_path / "app.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, token TEXT)")
    conn.executemany("INSERT INTO users (name, token) VALUES (?, ?)", [(f"u{i}", None) for i in range(30)])
    conn.commit()
    conn.close()
    return path


def _count(path: Path) -> int:
    conn = sqlite3.connect(path)
    try:
        return int(conn.execute("SELECT count(*) FROM users").fetchone()[0])
    finally:
        conn.close()


class RecordingDriver:
    def __init__(self, outcome: QueryOutcome | None = None) -> None:
        self.calls: list[tuple[PreparedQuery, bool, int]] = []
        self.outcome = outcome or QueryOutcome(columns=["x"], rows=[[1]], row_count=1)

    async def execute(
        self, target: DbTarget, prepared: PreparedQuery, *, readonly: bool, max_rows: int, timeout: float
    ) -> QueryOutcome:
        self.calls.append((prepared, readonly, max_rows))
        return self.outcome

    async def ping(self, target: DbTarget, *, timeout: float) -> str:
        return "fake 1.0"


# ----------------------------------------------------------------------------- sqlite end-to-end


async def test_sqlite_read(renv: RemoteEnv, sqlite_db: Path) -> None:
    profile = await renv.add_db(database=str(sqlite_db))
    result = await renv.svc.db_query(profile.id, "SELECT id, name FROM users ORDER BY id", actor="user", max_rows=5)
    assert result.error is None and not result.denied
    assert result.columns == ["id", "name"]
    assert result.rows == [[1, "u0"], [2, "u1"], [3, "u2"], [4, "u3"], [5, "u4"]]
    assert result.truncated and result.row_count == 5
    (event,) = await renv.events(ET.DB_QUERY)
    assert event.payload["outcome"] == "executed" and event.payload["readonly_session"] is True
    assert event.payload["row_count"] == 5 and event.severity == Severity.info


async def test_sqlite_write_requires_approval_at_read_level(renv: RemoteEnv, sqlite_db: Path) -> None:
    profile = await renv.add_db(database=str(sqlite_db), permission_level=PermissionLevel.read)
    decider = auto_decide(renv)
    result = await renv.svc.db_query(profile.id, "INSERT INTO users (name) VALUES ('new')", actor="user")
    approval = await decider
    assert approval.kind == ApprovalKind.db_write and not approval.production
    assert approval.payload["query"] == "INSERT INTO users (name) VALUES ('new')"
    assert result.error is None and result.approved_by == "user" and result.row_count == 1
    assert _count(sqlite_db) == 31


async def test_sqlite_rejected_write_changes_nothing(renv: RemoteEnv, sqlite_db: Path) -> None:
    profile = await renv.add_db(database=str(sqlite_db), environment=Environment.production)
    decider = auto_decide(renv, approve=False)
    result = await renv.svc.db_query(profile.id, "SELECT 1; DELETE FROM users", actor="user")
    approval = await decider
    assert approval.production and approval.severity == Severity.critical
    assert result.denied and _count(sqlite_db) == 30
    (event,) = await renv.events(ET.DB_QUERY)
    assert event.payload["outcome"] == "rejected" and event.payload["denied"] is True


async def test_sqlite_full_level_non_production_write_runs(renv: RemoteEnv, sqlite_db: Path) -> None:
    profile = await renv.add_db(database=str(sqlite_db), permission_level=PermissionLevel.full)
    result = await renv.svc.db_query(profile.id, "DELETE FROM users WHERE id = 1", actor="user")
    assert result.error is None and result.approved_by is None and _count(sqlite_db) == 29


async def test_sqlite_read_only_second_layer(sqlite_db: Path) -> None:
    driver = SqliteDriver()
    target = DbTarget(kind="sqlite", host=None, port=None, database=str(sqlite_db), username=None, password=None)
    with pytest.raises(sqlite3.OperationalError, match="readonly"):
        await driver.execute(
            target, PreparedQuery(sql=["INSERT INTO users (name) VALUES ('x')"]), readonly=True, max_rows=10, timeout=5
        )
    assert _count(sqlite_db) == 30
    # A read-only run never commits, even for statements the classifier would allow.
    out = await driver.execute(
        target, PreparedQuery(sql=["SELECT count(*) FROM users"]), readonly=True, max_rows=10, timeout=5
    )
    assert out.rows == [[30]]
    assert (await driver.ping(target, timeout=5)).startswith("SQLite")


async def test_sqlite_missing_file_is_an_error_not_a_new_db(renv: RemoteEnv, tmp_path: Path) -> None:
    missing = tmp_path / "nope.db"
    profile = await renv.add_db(database=str(missing), permission_level=PermissionLevel.full)
    result = await renv.svc.db_query(profile.id, "CREATE TABLE x (a int)", actor="user")
    assert result.error and "bulunamadı" in result.error
    assert not missing.exists()


async def test_sqlite_sql_error_is_returned(renv: RemoteEnv, sqlite_db: Path) -> None:
    profile = await renv.add_db(database=str(sqlite_db))
    result = await renv.svc.db_query(profile.id, "SELECT nope FROM users", actor="user")
    assert result.error and "OperationalError" in result.error
    (event,) = await renv.events(ET.DB_QUERY)
    assert event.payload["outcome"] == "failed"


async def test_unparseable_query_is_unknown_and_needs_approval(renv: RemoteEnv, sqlite_db: Path) -> None:
    profile = await renv.add_db(database=str(sqlite_db))
    decider = auto_decide(renv, approve=False)
    result = await renv.svc.db_query(profile.id, "SELEKT * FROM users", actor="user")
    await decider
    assert result.classification.klass == "unknown" and result.denied


async def test_rows_are_masked(renv: RemoteEnv, sqlite_db: Path) -> None:
    secret = "tok-" + "z" * 16
    renv.ctx.masker.add_secret(secret)
    conn = sqlite3.connect(sqlite_db)
    conn.execute("UPDATE users SET token = ? WHERE id = 1", (secret,))
    conn.commit()
    conn.close()
    profile = await renv.add_db(database=str(sqlite_db))
    result = await renv.svc.db_query(profile.id, "SELECT token FROM users WHERE id = 1", actor="user")
    assert result.rows == [["[gizli]"]]


async def test_agent_boundary_applies_to_db(renv: RemoteEnv, sqlite_db: Path) -> None:
    await renv.add_db(name="appdb", database=str(sqlite_db), permission_level=PermissionLevel.full)
    tools = renv.tools.bind(ToolContext(workspace_id="ws_test", session_id="ses_nobody", provider="claude"))
    result = await tools.call("db_query", {"profile": "appdb", "query": "SELECT 1", "reason": "x"})
    assert result.is_error and "DENIED" in result.content


# ----------------------------------------------------------------------------- policy wiring with fake drivers


async def test_production_reads_use_read_only_session_even_at_full(renv: RemoteEnv) -> None:
    fake = RecordingDriver()
    renv.svc.drivers["postgres"] = fake
    profile = await renv.add_db(
        kind="postgres", host="db.internal", environment=Environment.production, permission_level=PermissionLevel.full
    )
    result = await renv.svc.db_query(profile.id, "SELECT 1; SELECT 2", actor="user")
    assert result.error is None
    prepared, readonly, _ = fake.calls[0]
    assert readonly is True and prepared.sql == ["SELECT 1", "SELECT 2"]
    decider = auto_decide(renv)
    await renv.svc.db_query(profile.id, "UPDATE t SET a = 1", actor="user")
    approval = await decider
    assert approval.production and fake.calls[1][1] is False


async def test_non_production_full_reads_are_not_forced_read_only(renv: RemoteEnv) -> None:
    fake = RecordingDriver()
    renv.svc.drivers["mysql"] = fake
    profile = await renv.add_db(kind="mysql", host="x", permission_level=PermissionLevel.full)
    await renv.svc.db_query(profile.id, "SELECT 1", actor="user", max_rows=10_000)
    assert fake.calls[0][1] is False and fake.calls[0][2] == 5000


async def test_redis_and_mongo_prepared(renv: RemoteEnv) -> None:
    redis_fake, mongo_fake = RecordingDriver(), RecordingDriver()
    renv.svc.drivers["redis"] = redis_fake
    renv.svc.drivers["mongodb"] = mongo_fake
    r = await renv.add_db(kind="redis", host="cache")
    await renv.svc.db_query(r.id, "GET a\nHGETALL 'user 1'", actor="user")
    assert redis_fake.calls[0][0].redis == [["GET", "a"], ["HGETALL", "user 1"]]
    m = await renv.add_db(kind="mongodb", host="mongo", database="app")
    await renv.svc.db_query(m.id, 'db.users.find({"a": 1})', actor="user")
    op = mongo_fake.calls[0][0].mongo
    assert op is not None and op.command == {"find": "users", "filter": {"a": 1}}
    bad = await renv.svc.db_query(m.id, "db.users.find({a: 1})", actor="user")
    assert bad.error and "JSON" in bad.error and len(mongo_fake.calls) == 1


async def test_limited_db_patterns(renv: RemoteEnv) -> None:
    fake = RecordingDriver()
    renv.svc.drivers["postgres"] = fake
    profile = await renv.add_db(
        kind="postgres",
        host="x",
        permission_level=PermissionLevel.limited,
        limited_write_patterns=["INSERT INTO audit *"],
    )
    ok = await renv.svc.db_query(profile.id, "insert into audit values (1)", actor="user")
    assert ok.approved_by is None and not ok.denied
    decider = auto_decide(renv, approve=False)
    no = await renv.svc.db_query(profile.id, "INSERT INTO users VALUES (1)", actor="user")
    await decider
    assert no.denied and len(fake.calls) == 1


async def test_profile_validation(renv: RemoteEnv) -> None:
    with pytest.raises(ValidationFailed):
        await renv.add_db(kind="sqlite")
    with pytest.raises(ValidationFailed, match="Gizli"):
        await renv.add_db(kind="postgres", options={"password": "x"})
    host = await renv.add_host()
    with pytest.raises(ValidationFailed):
        await renv.add_db(kind="sqlite", database="/x.db", via_host_id=host.id)
    with pytest.raises(ValidationFailed):
        await renv.add_db(kind="redis", limited_write_patterns=["re:("])


async def test_test_db(renv: RemoteEnv, sqlite_db: Path) -> None:
    ok = await renv.add_db(database=str(sqlite_db))
    assert (await renv.svc.test_db(ok.id)).ok
    bad = await renv.add_db(database=str(sqlite_db) + ".missing")
    result = await renv.svc.test_db(bad.id)
    assert not result.ok and "Bağlantı başarısız" in result.message


# ----------------------------------------------------------------------------- driver internals with fakes


def _target(kind: str, **kw: Any) -> DbTarget:
    defaults: dict[str, Any] = {
        "kind": kind,
        "host": "h",
        "port": None,
        "database": "d",
        "username": "u",
        "password": "p" * 8,
    }
    defaults.update(kw)
    return DbTarget(**defaults)


async def test_postgres_driver_read_only_transaction(monkeypatch: pytest.MonkeyPatch) -> None:
    log: list[Any] = []

    class Attr:
        def __init__(self, name: str) -> None:
            self.name = name

    class Record:
        def __init__(self, values: list[Any]) -> None:
            self._v = values

        def values(self) -> list[Any]:
            return self._v

    class Cursor:
        async def fetch(self, n: int) -> list[Record]:
            log.append(("fetch", n))
            return [Record([i]) for i in range(min(n, 5))]

    class Prepared:
        def __init__(self, sql: str) -> None:
            self.sql = sql

        def get_attributes(self) -> list[Attr]:
            return [Attr("n")] if self.sql.startswith("SELECT") else []

        async def cursor(self) -> Cursor:
            return Cursor()

        async def fetch(self) -> list[Any]:
            log.append(("exec", self.sql))
            return []

        def get_statusmsg(self) -> str:
            return "UPDATE 3"

    class Tx:
        def __init__(self, readonly: bool) -> None:
            log.append(("tx", readonly))

        async def start(self) -> None:
            log.append("begin")

        async def rollback(self) -> None:
            log.append("rollback")

        async def commit(self) -> None:
            log.append("commit")

    class Conn:
        def transaction(self, *, readonly: bool) -> Tx:
            return Tx(readonly)

        async def execute(self, sql: str) -> None:
            log.append(("raw", sql))

        async def prepare(self, sql: str) -> Prepared:
            log.append(("prepare", sql))
            return Prepared(sql)

        async def close(self, timeout: float) -> None:
            log.append("close")

    async def fake_connect(**kwargs: Any) -> Conn:
        log.append(("connect", kwargs["host"], kwargs["port"], kwargs["database"]))
        return Conn()

    import asyncpg

    monkeypatch.setattr(asyncpg, "connect", fake_connect)
    out = await PostgresDriver().execute(
        _target("postgres"), PreparedQuery(sql=["SELECT n FROM t"]), readonly=True, max_rows=3, timeout=10
    )
    assert out.rows == [[0], [1], [2]] and out.truncated
    assert ("tx", True) in log and "rollback" in log and "commit" not in log
    assert ("fetch", 4) in log
    assert ("raw", "SET LOCAL statement_timeout = 10000") in log
    log.clear()
    out = await PostgresDriver().execute(
        _target("postgres"), PreparedQuery(sql=["UPDATE t SET a = 1"]), readonly=False, max_rows=3, timeout=10
    )
    assert out.row_count == 3 and ("tx", False) in log and "commit" in log


async def test_mysql_driver_read_only_session(monkeypatch: pytest.MonkeyPatch) -> None:
    executed: list[str] = []

    class Cur:
        description = None
        rowcount = 0

        async def __aenter__(self) -> Cur:
            return self

        async def __aexit__(self, *a: object) -> None:
            return None

        async def execute(self, sql: str) -> None:
            executed.append(sql)
            self.description = (("n",),) if sql.startswith("SELECT") else None
            self.rowcount = 2

        async def fetchmany(self, n: int) -> list[tuple[int]]:
            return [(1,), (2,)]

        async def close(self) -> None:
            return None

    class CursorCall:
        def __call__(self, *args: object) -> Any:
            return self

        def __await__(self) -> Any:
            async def make() -> Cur:
                return Cur()

            return make().__await__()

        async def __aenter__(self) -> Cur:
            return Cur()

        async def __aexit__(self, *a: object) -> None:
            return None

    class Conn:
        def __init__(self) -> None:
            self.cursor = CursorCall()

        async def rollback(self) -> None:
            executed.append("ROLLBACK")

        async def commit(self) -> None:
            executed.append("COMMIT")

        def close(self) -> None:
            executed.append("CLOSE")

    async def fake_connect(target: DbTarget, timeout: float) -> Conn:
        return Conn()

    monkeypatch.setattr(dbexec, "_mysql_connect", fake_connect)
    out = await MysqlDriver().execute(
        _target("mysql"), PreparedQuery(sql=["SELECT 1"]), readonly=True, max_rows=10, timeout=5
    )
    assert out.rows == [[1], [2]]
    assert executed[0] == "SET SESSION TRANSACTION READ ONLY"
    assert "START TRANSACTION READ ONLY" in executed and "ROLLBACK" in executed and "COMMIT" not in executed
    executed.clear()
    await MysqlDriver().execute(
        _target("mysql"), PreparedQuery(sql=["DELETE FROM t"]), readonly=False, max_rows=10, timeout=5
    )
    assert "START TRANSACTION" in executed and "COMMIT" in executed


def test_mysql_connection_disables_multi_statements() -> None:
    from pymysql.constants import CLIENT

    captured: dict[str, int] = {}

    async def scenario() -> None:
        import aiomysql

        orig = aiomysql.Connection._connect

        async def fake_connect(self: Any) -> None:
            captured["flag"] = self.client_flag

        aiomysql.Connection._connect = fake_connect  # type: ignore[method-assign]
        try:
            await dbexec._mysql_connect(_target("mysql"), 5)
        finally:
            aiomysql.Connection._connect = orig  # type: ignore[method-assign]

    asyncio.run(scenario())
    assert not captured["flag"] & CLIENT.MULTI_STATEMENTS
    assert not captured["flag"] & CLIENT.LOCAL_FILES


async def test_mssql_driver_rolls_back_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    class Cur:
        description = (("n",),)
        rowcount = 1

        def execute(self, sql: str) -> None:
            calls.append(sql)

        def fetchmany(self, n: int) -> list[tuple[int]]:
            return [(7,)]

    class Conn:
        def cursor(self) -> Cur:
            return Cur()

        def rollback(self) -> None:
            calls.append("rollback")

        def commit(self) -> None:
            calls.append("commit")

        def close(self) -> None:
            calls.append("close")

    fake_module = types.SimpleNamespace(connect=lambda **kw: Conn())
    monkeypatch.setitem(sys.modules, "pymssql", fake_module)
    out = await MssqlDriver().execute(
        _target("mssql"), PreparedQuery(sql=["SELECT 7"]), readonly=True, max_rows=5, timeout=5
    )
    assert out.rows == [[7]] and calls == ["SELECT 7", "rollback", "close"]


async def test_redis_driver(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[tuple[Any, ...]] = []

    class FakeRedis:
        def __init__(self, **kwargs: Any) -> None:
            sent.append(("init", kwargs["db"]))

        async def execute_command(self, *argv: Any) -> Any:
            sent.append(argv)
            return {b"k": b"v"} if argv[0] == "HGETALL" else [b"a", b"b", b"c"]

        async def aclose(self) -> None:
            sent.append(("closed",))

    import redis.asyncio as aioredis

    monkeypatch.setattr(aioredis, "Redis", FakeRedis)
    out = await RedisDriver().execute(
        _target("redis", database="2"), PreparedQuery(redis=[["KEYS", "*"]]), readonly=True, max_rows=2, timeout=5
    )
    assert out.rows == [["a"], ["b"]] and out.truncated and sent[0] == ("init", 2)
    out = await RedisDriver().execute(
        _target("redis", database=None), PreparedQuery(redis=[["HGETALL", "h"]]), readonly=True, max_rows=10, timeout=5
    )
    assert out.columns == ["key", "value"] and out.rows == [["k", "v"]]


async def test_mongo_driver(monkeypatch: pytest.MonkeyPatch) -> None:
    commands: list[dict[str, Any]] = []

    class FakeDb:
        async def command(self, cmd: dict[str, Any]) -> dict[str, Any]:
            commands.append(cmd)
            if "find" in cmd:
                return {"cursor": {"firstBatch": [{"_id": 1, "a": 1}, {"_id": 2, "b": 2}], "id": 0}, "ok": 1}
            return {"n": 5, "ok": 1}

    class FakeClient:
        def __init__(self, **kwargs: Any) -> None:
            self.kwargs = kwargs

        def __getitem__(self, name: str) -> FakeDb:
            return FakeDb()

        async def close(self) -> None:
            return None

    import pymongo

    monkeypatch.setattr(pymongo, "AsyncMongoClient", FakeClient)
    out = await MongoDriver().execute(
        _target("mongodb"),
        PreparedQuery(mongo=parse_mongo('{"find": "users", "limit": 100}')),
        readonly=True,
        max_rows=10,
        timeout=5,
    )
    assert commands[0]["limit"] == 11 and commands[0]["singleBatch"] is True
    assert out.columns == ["_id", "a", "b"] and out.rows == [[1, 1, None], [2, None, 2]]
    out = await MongoDriver().execute(
        _target("mongodb"),
        PreparedQuery(mongo=parse_mongo('{"count": "users"}')),
        readonly=True,
        max_rows=10,
        timeout=5,
    )
    assert out.rows == [[5]]


def test_cell_conversion() -> None:
    import datetime as dt
    import decimal
    import uuid

    assert cell(decimal.Decimal("1.5")) == "1.5"
    assert cell(dt.datetime(2026, 1, 2, 3, 4, 5)) == "2026-01-02T03:04:05"
    assert cell(b"\x00\x01").startswith("base64:")
    assert cell(float("nan")) == "nan"
    assert cell("x" * 5000).endswith("…")
    assert cell({"a": [1, uuid.UUID(int=0)]}) == {"a": [1, "00000000-0000-0000-0000-000000000000"]}
