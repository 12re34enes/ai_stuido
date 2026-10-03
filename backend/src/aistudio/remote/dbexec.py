"""Database execution for ``db_query``.

Each driver runs exactly the statements the classifier saw (one at a time, never a raw
multi-statement string), honours ``readonly`` as a second safety layer and returns at most
``max_rows`` rows:

* SQLite  - ``mode=ro`` URI + ``PRAGMA query_only`` when read-only; ``mode=rw`` otherwise (never creates files)
* Postgres (asyncpg) - ``BEGIN READ ONLY`` ... ``ROLLBACK``; extended protocol (single statement each)
* MySQL (aiomysql)   - ``SET SESSION TRANSACTION READ ONLY`` + ``START TRANSACTION READ ONLY`` ... ``ROLLBACK``;
                       multi-statement support disabled on the connection, ``LOCAL INFILE`` off
* MSSQL (pymssql, in a thread) - explicit transaction rolled back at the end for reads
* MongoDB (pymongo AsyncMongoClient) / Redis (redis.asyncio) - classification is the gate
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import datetime as dt
import decimal
import math
import os
import re
import sqlite3
import urllib.parse
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol

from aistudio.core.errors import NotFound, ValidationFailed
from aistudio.remote.classify import MongoOp

MAX_CELL_CHARS = 4000


@dataclass
class DbTarget:
    kind: str
    host: str | None
    port: int | None
    database: str | None
    username: str | None
    password: str | None
    options: Mapping[str, Any] = field(default_factory=dict)
    tunneled: bool = False


@dataclass
class PreparedQuery:
    sql: list[str] = field(default_factory=list)
    redis: list[list[str]] = field(default_factory=list)
    mongo: MongoOp | None = None


@dataclass
class QueryOutcome:
    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int | None = None
    truncated: bool = False


class DbDriver(Protocol):
    async def execute(
        self, target: DbTarget, prepared: PreparedQuery, *, readonly: bool, max_rows: int, timeout: float
    ) -> QueryOutcome: ...

    async def ping(self, target: DbTarget, *, timeout: float) -> str:
        """Connect and return a short server description."""
        ...


def cell(value: Any) -> Any:
    """JSON-safe, size-bounded representation of a database value."""
    if value is None or isinstance(value, bool | int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, str):
        return value if len(value) <= MAX_CELL_CHARS else value[:MAX_CELL_CHARS] + "…"
    if isinstance(value, decimal.Decimal | uuid.UUID):
        return str(value)
    if isinstance(value, dt.datetime | dt.date | dt.time):
        return value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, bytes | bytearray | memoryview):
        raw = bytes(value)
        text = "base64:" + base64.b64encode(raw[:2048]).decode()
        return text + ("…" if len(raw) > 2048 else "")
    if isinstance(value, Mapping):
        return {str(k): cell(v) for k, v in list(value.items())[:200]}
    if isinstance(value, list | tuple | set | frozenset):
        return [cell(v) for v in list(value)[:200]]
    return cell(str(value))


def _status_count(status: str | None) -> int | None:
    if not status:
        return None
    m = re.search(r"(\d+)\s*$", status)
    return int(m.group(1)) if m else None


# ============================================================================ SQLite


class SqliteDriver:
    def _path(self, target: DbTarget) -> str:
        if not target.database:
            raise ValidationFailed("SQLite dosya yolu tanımlı değil.")
        path = os.path.expanduser(target.database)
        if not os.path.isfile(path):
            raise NotFound(f"SQLite dosyası bulunamadı: {path}")
        return path

    def _connect(self, path: str, readonly: bool) -> sqlite3.Connection:
        uri = f"file:{urllib.parse.quote(path)}?mode={'ro' if readonly else 'rw'}"
        conn = sqlite3.connect(uri, uri=True, timeout=5, check_same_thread=False, isolation_level=None)
        if readonly:
            conn.execute("PRAGMA query_only = ON")
        return conn

    async def execute(
        self, target: DbTarget, prepared: PreparedQuery, *, readonly: bool, max_rows: int, timeout: float
    ) -> QueryOutcome:
        path = self._path(target)
        holder: dict[str, sqlite3.Connection] = {}

        def work() -> QueryOutcome:
            conn = self._connect(path, readonly)
            holder["conn"] = conn
            outcome = QueryOutcome()
            try:
                cur = conn.cursor()
                cur.execute("BEGIN")
                try:
                    for stmt in prepared.sql:
                        cur.execute(stmt)
                        if cur.description:
                            rows = cur.fetchmany(max_rows + 1)
                            outcome = QueryOutcome(
                                columns=[d[0] for d in cur.description],
                                rows=[[cell(v) for v in r] for r in rows[:max_rows]],
                                row_count=min(len(rows), max_rows),
                                truncated=len(rows) > max_rows,
                            )
                        else:
                            outcome = QueryOutcome(row_count=cur.rowcount if cur.rowcount >= 0 else None)
                    cur.execute("ROLLBACK" if readonly else "COMMIT")
                except BaseException:
                    with contextlib.suppress(sqlite3.Error):
                        cur.execute("ROLLBACK")
                    raise
            finally:
                conn.close()
            return outcome

        try:
            return await asyncio.wait_for(asyncio.to_thread(work), timeout)
        except TimeoutError:
            conn = holder.get("conn")
            if conn is not None:
                with contextlib.suppress(Exception):
                    conn.interrupt()
            raise

    async def ping(self, target: DbTarget, *, timeout: float) -> str:
        path = self._path(target)

        def work() -> str:
            conn = self._connect(path, True)
            try:
                return "SQLite " + str(conn.execute("select sqlite_version()").fetchone()[0])
            finally:
                conn.close()

        return await asyncio.wait_for(asyncio.to_thread(work), timeout)


# ============================================================================ PostgreSQL


class PostgresDriver:
    async def _connect(self, target: DbTarget, timeout: float) -> Any:
        import asyncpg

        return await asyncpg.connect(
            host=target.host or "localhost",
            port=target.port or 5432,
            user=target.username,
            password=target.password,
            database=target.database,
            timeout=max(1, int(min(timeout, 15))),
            command_timeout=timeout,
            ssl=target.options.get("ssl"),
            server_settings={"application_name": "AI Studio"},
        )

    async def execute(
        self, target: DbTarget, prepared: PreparedQuery, *, readonly: bool, max_rows: int, timeout: float
    ) -> QueryOutcome:
        conn = await self._connect(target, timeout)
        try:
            tr = conn.transaction(readonly=readonly)
            await tr.start()
            outcome = QueryOutcome()
            try:
                await conn.execute(f"SET LOCAL statement_timeout = {max(1, int(timeout * 1000))}")
                for stmt in prepared.sql:
                    ps = await conn.prepare(stmt)  # extended protocol: exactly one statement
                    attributes = ps.get_attributes()
                    if attributes:
                        cursor = await ps.cursor()
                        records = await cursor.fetch(max_rows + 1)
                        outcome = QueryOutcome(
                            columns=[a.name for a in attributes],
                            rows=[[cell(v) for v in r.values()] for r in records[:max_rows]],
                            row_count=min(len(records), max_rows),
                            truncated=len(records) > max_rows,
                        )
                    else:
                        await ps.fetch()
                        outcome = QueryOutcome(row_count=_status_count(ps.get_statusmsg()))
                if readonly:
                    await tr.rollback()
                else:
                    await tr.commit()
            except BaseException:
                with contextlib.suppress(Exception):
                    await tr.rollback()
                raise
            return outcome
        finally:
            with contextlib.suppress(Exception):
                await conn.close(timeout=5)

    async def ping(self, target: DbTarget, *, timeout: float) -> str:
        conn = await self._connect(target, timeout)
        try:
            return str(await conn.fetchval("select version()"))
        finally:
            with contextlib.suppress(Exception):
                await conn.close(timeout=5)


# ============================================================================ MySQL / MariaDB


async def _mysql_connect(target: DbTarget, timeout: float) -> Any:
    import aiomysql
    from pymysql.constants import CLIENT

    class _SingleStatementConnection(aiomysql.Connection):  # type: ignore[misc]
        """aiomysql always enables CLIENT_MULTI_STATEMENTS; we never want it."""

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self.client_flag &= ~CLIENT.MULTI_STATEMENTS

    conn = _SingleStatementConnection(
        host=target.host or "localhost",
        port=target.port or 3306,
        user=target.username,
        password=target.password or "",
        db=target.database,
        connect_timeout=min(timeout, 15),
        autocommit=False,
        local_infile=False,
        charset="utf8mb4",
        program_name="AI Studio",
    )
    await conn._connect()
    return conn


class MysqlDriver:
    async def execute(
        self, target: DbTarget, prepared: PreparedQuery, *, readonly: bool, max_rows: int, timeout: float
    ) -> QueryOutcome:
        import aiomysql

        conn = await _mysql_connect(target, timeout)
        outcome = QueryOutcome()
        try:
            async with conn.cursor() as cur:
                if readonly:
                    await cur.execute("SET SESSION TRANSACTION READ ONLY")
                with contextlib.suppress(Exception):
                    await cur.execute(f"SET SESSION MAX_EXECUTION_TIME = {max(1, int(timeout * 1000))}")
                await cur.execute("START TRANSACTION READ ONLY" if readonly else "START TRANSACTION")
            try:
                for stmt in prepared.sql:
                    cur = await conn.cursor(aiomysql.SSCursor)
                    try:
                        await cur.execute(stmt)
                        if cur.description:
                            rows = await cur.fetchmany(max_rows + 1)
                            outcome = QueryOutcome(
                                columns=[d[0] for d in cur.description],
                                rows=[[cell(v) for v in r] for r in rows[:max_rows]],
                                row_count=min(len(rows), max_rows),
                                truncated=len(rows) > max_rows,
                            )
                        else:
                            outcome = QueryOutcome(row_count=cur.rowcount if cur.rowcount >= 0 else None)
                    finally:
                        await cur.close()
                if readonly:
                    await conn.rollback()
                else:
                    await conn.commit()
            except BaseException:
                with contextlib.suppress(Exception):
                    await conn.rollback()
                raise
            return outcome
        finally:
            conn.close()

    async def ping(self, target: DbTarget, *, timeout: float) -> str:
        conn = await _mysql_connect(target, timeout)
        try:
            return str(conn.get_server_info())
        finally:
            conn.close()


# ============================================================================ MSSQL


class MssqlDriver:
    def _connect(self, target: DbTarget, timeout: float) -> Any:
        import pymssql

        return pymssql.connect(
            server=target.host or "localhost",
            port=str(target.port or 1433),
            user=target.username or "",
            password=target.password or "",
            database=target.database or "",
            login_timeout=int(min(timeout, 15)),
            timeout=max(1, int(timeout)),
            autocommit=False,
            appname="AI Studio",
        )

    async def execute(
        self, target: DbTarget, prepared: PreparedQuery, *, readonly: bool, max_rows: int, timeout: float
    ) -> QueryOutcome:
        def work() -> QueryOutcome:
            conn = self._connect(target, timeout)
            outcome = QueryOutcome()
            try:
                cur = conn.cursor()
                try:
                    for stmt in prepared.sql:
                        cur.execute(stmt)
                        if cur.description:
                            rows = cur.fetchmany(max_rows + 1)
                            outcome = QueryOutcome(
                                columns=[d[0] for d in cur.description],
                                rows=[[cell(v) for v in r] for r in rows[:max_rows]],
                                row_count=min(len(rows), max_rows),
                                truncated=len(rows) > max_rows,
                            )
                        else:
                            outcome = QueryOutcome(row_count=cur.rowcount if cur.rowcount >= 0 else None)
                    if readonly:
                        conn.rollback()  # MSSQL has no read-only transactions: always roll back reads
                    else:
                        conn.commit()
                except BaseException:
                    with contextlib.suppress(Exception):
                        conn.rollback()
                    raise
            finally:
                conn.close()
            return outcome

        return await asyncio.wait_for(asyncio.to_thread(work), timeout + 5)

    async def ping(self, target: DbTarget, *, timeout: float) -> str:
        def work() -> str:
            conn = self._connect(target, timeout)
            try:
                cur = conn.cursor()
                cur.execute("SELECT @@VERSION")
                row = cur.fetchone()
                return str(row[0]).splitlines()[0] if row else "MSSQL"
            finally:
                conn.close()

        return await asyncio.wait_for(asyncio.to_thread(work), timeout + 5)


# ============================================================================ MongoDB


class MongoDriver:
    def _client(self, target: DbTarget, timeout: float) -> Any:
        from pymongo import AsyncMongoClient

        opts = target.options
        kwargs: dict[str, Any] = {
            "host": target.host or "localhost",
            "port": target.port or 27017,
            "serverSelectionTimeoutMS": int(min(timeout, 15) * 1000),
            "connectTimeoutMS": int(min(timeout, 15) * 1000),
            "socketTimeoutMS": int(timeout * 1000),
            "appname": "AI Studio",
            "directConnection": bool(opts.get("direct_connection", target.tunneled)),
        }
        if target.username:
            kwargs["username"] = target.username
            kwargs["password"] = target.password
            kwargs["authSource"] = opts.get("auth_source") or target.database or "admin"
        if opts.get("tls"):
            kwargs["tls"] = True
        if opts.get("replica_set"):
            kwargs["replicaSet"] = opts["replica_set"]
        return AsyncMongoClient(**kwargs)

    async def execute(
        self, target: DbTarget, prepared: PreparedQuery, *, readonly: bool, max_rows: int, timeout: float
    ) -> QueryOutcome:
        op = prepared.mongo
        if op is None:
            raise ValidationFailed("MongoDB komutu eksik.")
        client = self._client(target, timeout)
        try:
            db_name = "admin" if op.extra.get("admin") else (target.database or "admin")
            db = client[db_name]
            command = dict(op.command)
            lname = op.name.lower()
            if lname == "find":
                limit = command.get("limit")
                cap = max_rows + 1
                command["limit"] = min(int(limit), cap) if isinstance(limit, int) and limit > 0 else cap
                command["batchSize"] = command["limit"]
                command["singleBatch"] = True
            elif lname == "aggregate":
                command["cursor"] = {"batchSize": max_rows + 1}
            result = await asyncio.wait_for(db.command(command), timeout)
            return await self._outcome(db, op, result, max_rows)
        finally:
            with contextlib.suppress(Exception):
                await client.close()

    async def _outcome(self, db: Any, op: MongoOp, result: Mapping[str, Any], max_rows: int) -> QueryOutcome:
        cursor = result.get("cursor")
        if isinstance(cursor, Mapping):
            docs = list(cursor.get("firstBatch") or [])
            cursor_id = cursor.get("id") or 0
            if cursor_id and op.collection:
                with contextlib.suppress(Exception):
                    await db.command({"killCursors": op.collection, "cursors": [cursor_id]})
            truncated = len(docs) > max_rows
            docs = docs[:max_rows]
            columns: list[str] = []
            for d in docs:
                for k in d:
                    if str(k) not in columns:
                        columns.append(str(k))
            rows = [[cell(d.get(c)) for c in columns] for d in docs]
            return QueryOutcome(columns=columns, rows=rows, row_count=len(rows), truncated=truncated)
        lname = op.name.lower()
        if lname == "count" and "n" in result:
            return QueryOutcome(columns=["n"], rows=[[cell(result["n"])]], row_count=1)
        if lname == "distinct" and "values" in result:
            values = list(result["values"])
            return QueryOutcome(
                columns=["value"],
                rows=[[cell(v)] for v in values[:max_rows]],
                row_count=min(len(values), max_rows),
                truncated=len(values) > max_rows,
            )
        n = result.get("n") if isinstance(result.get("n"), int) else None
        return QueryOutcome(columns=["result"], rows=[[cell(dict(result))]], row_count=n)

    async def ping(self, target: DbTarget, *, timeout: float) -> str:
        client = self._client(target, timeout)
        try:
            info = await asyncio.wait_for(client["admin"].command({"buildInfo": 1}), timeout)
            return f"MongoDB {info.get('version', '?')}"
        finally:
            with contextlib.suppress(Exception):
                await client.close()


# ============================================================================ Redis


def _decode(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    if isinstance(value, list | tuple):
        return [_decode(v) for v in value]
    if isinstance(value, dict):
        return {_decode(k): _decode(v) for k, v in value.items()}
    return value


class RedisDriver:
    def _client(self, target: DbTarget, timeout: float) -> Any:
        import redis.asyncio as aioredis

        try:
            db_index = int(target.database or 0)
        except ValueError:
            raise ValidationFailed("Redis veritabanı numarası tamsayı olmalı.") from None
        return aioredis.Redis(
            host=target.host or "localhost",
            port=target.port or 6379,
            db=db_index,
            username=target.username or None,
            password=target.password or None,
            socket_timeout=timeout,
            socket_connect_timeout=min(timeout, 15),
            ssl=bool(target.options.get("tls")),
        )

    async def execute(
        self, target: DbTarget, prepared: PreparedQuery, *, readonly: bool, max_rows: int, timeout: float
    ) -> QueryOutcome:
        client = self._client(target, timeout)
        result: Any = None
        try:
            for argv in prepared.redis:
                result = await asyncio.wait_for(client.execute_command(*argv), timeout)
        finally:
            with contextlib.suppress(Exception):
                await client.aclose()
        return self._outcome(_decode(result), max_rows)

    def _outcome(self, value: Any, max_rows: int) -> QueryOutcome:
        if isinstance(value, dict):
            items = list(value.items())
            return QueryOutcome(
                columns=["key", "value"],
                rows=[[cell(k), cell(v)] for k, v in items[:max_rows]],
                row_count=min(len(items), max_rows),
                truncated=len(items) > max_rows,
            )
        if isinstance(value, list):
            return QueryOutcome(
                columns=["value"],
                rows=[[cell(v)] for v in value[:max_rows]],
                row_count=min(len(value), max_rows),
                truncated=len(value) > max_rows,
            )
        return QueryOutcome(columns=["result"], rows=[[cell(value)]], row_count=1)

    async def ping(self, target: DbTarget, *, timeout: float) -> str:
        client = self._client(target, timeout)
        try:
            info = await asyncio.wait_for(client.info("server"), timeout)
            return f"Redis {_decode(info).get('redis_version', '?')}"
        finally:
            with contextlib.suppress(Exception):
                await client.aclose()


def default_drivers() -> dict[str, DbDriver]:
    return {
        "sqlite": SqliteDriver(),
        "postgres": PostgresDriver(),
        "mysql": MysqlDriver(),
        "mssql": MssqlDriver(),
        "mongodb": MongoDriver(),
        "redis": RedisDriver(),
    }
