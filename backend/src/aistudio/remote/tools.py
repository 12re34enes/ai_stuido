"""Studio tools ``remote_exec`` and ``db_query`` (spec §11).

Both are ``mutating=False``: classification, the agent's boundaries and approvals do the gating,
so read-only agents can still inspect systems through them.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from aistudio.contracts.remote import DbQueryResult, RemoteExecResult
from aistudio.contracts.tools import ToolContext, ToolResult, ToolSpec
from aistudio.core.text import truncate

if TYPE_CHECKING:
    from aistudio.remote.service import RemoteServiceImpl

REMOTE_EXEC_DESCRIPTION = """\
Run a shell command on a registered SSH host (by host name or id) and get its exit code and output.
Commands run non-interactively with /bin/sh -c in the remote login environment.

Every command is classified before it runs:
- Read-only commands (ls, cat, tail, grep, find without -delete/-exec, journalctl, systemctl status,
  docker ps/logs, kubectl get/describe/logs, git status/log/diff, curl GET, ...) run immediately.
- Everything else is a write: file redirections (>, >>), tee, sed -i, sudo, package managers, service
  restarts, unknown programs, and anything the classifier cannot prove read-only (variables or globs in
  sensitive arguments, eval, encoded or indirect commands). Unknown counts as write.

Rules:
- On PRODUCTION hosts every write waits for an explicit human approval of that exact command. There is no
  standing permission; the human may reject it, and the call blocks until they decide.
- On other hosts writes may also need approval depending on the host's permission level.
- Your own remote-access boundary applies: 'none' denies everything, 'read' denies every write.
- Every call, including denied ones, is written to an immutable audit log together with your reason.

Do not try to evade classification; prefer specific read-only commands with bounded output
(head, tail -n 200, --since), and always give a clear `reason` (it is shown to the approver).
Output is secret-masked and truncated to 64 KiB."""

DB_QUERY_DESCRIPTION = """\
Run a query against a registered database profile (by name or id).

Query language depends on the profile kind:
- postgres / mysql / sqlite / mssql: SQL in that dialect. Several statements separated by ';' are
  evaluated one by one.
- redis: one command per line, e.g. `HGETALL user:1`.
- mongodb: a JSON command document, e.g. {"find": "users", "filter": {"active": true}, "limit": 20},
  or a mongosh call with strict JSON arguments, e.g. db.users.find({"active": true}).

Reads (SELECT, SHOW, DESCRIBE, EXPLAIN without ANALYZE of a write, read-only WITH; Redis read commands;
Mongo find, aggregate without $out/$merge, count, distinct) run immediately. On production and on
read-only profiles they run inside a read-only transaction. Everything else is a write (including
SELECT ... INTO, SELECT ... FOR UPDATE and statements that fail to parse): on PRODUCTION every write waits
for an explicit human approval of that exact query and may be rejected; elsewhere approval depends on the
profile's permission level. Your remote-access boundary applies ('none' denies all, 'read' denies writes).
All queries are audited. Results are limited to max_rows (default 500) and secret-masked; select only the
columns you need and give a clear `reason`."""


def _format_exec(host_label: str, r: RemoteExecResult) -> str:
    lines = [
        f"host: {host_label}",
        f"classification: {r.classification.klass} — " + "; ".join(r.classification.reasons),
    ]
    if r.denied:
        lines.append(f"DENIED: {r.denial_reason}")
        return "\n".join(lines)
    if r.approved_by:
        lines.append(f"approved by: {r.approved_by}")
    lines.append(f"exit code: {r.exit_code if r.exit_code is not None else 'none (timed out)'}")
    if r.duration_ms is not None:
        lines.append(f"duration: {r.duration_ms} ms")
    lines.append("--- output ---")
    lines.append(r.output or "(no output)")
    return "\n".join(lines)


def _format_rows(columns: list[str], rows: list[list[Any]], limit_chars: int = 48_000) -> str:
    if not columns:
        return ""
    out = ["\t".join(columns)]
    for row in rows:
        out.append("\t".join("NULL" if v is None else str(v).replace("\t", " ").replace("\n", " ") for v in row))
    return truncate("\n".join(out), limit_chars)


def _format_query(profile_label: str, r: DbQueryResult) -> str:
    lines = [
        f"database: {profile_label}",
        f"classification: {r.classification.klass} — " + "; ".join(r.classification.reasons),
    ]
    if r.denied:
        lines.append(f"DENIED: {r.denial_reason}")
        return "\n".join(lines)
    if r.approved_by:
        lines.append(f"approved by: {r.approved_by}")
    if r.error:
        lines.append(f"ERROR: {r.error}")
        return "\n".join(lines)
    lines.append(f"rows: {r.row_count if r.row_count is not None else '-'}" + (" (truncated)" if r.truncated else ""))
    table = _format_rows(r.columns, r.rows)
    if table:
        lines.append("--- result ---")
        lines.append(table)
    return "\n".join(lines)


class RemoteExecTool:
    spec = ToolSpec(
        name="remote_exec",
        description=REMOTE_EXEC_DESCRIPTION,
        input_schema={
            "type": "object",
            "properties": {
                "host": {"type": "string", "description": "Host name or id as registered in AI Studio."},
                "command": {"type": "string", "description": "Shell command line to run."},
                "reason": {"type": "string", "description": "Why you need to run this (shown to approvers)."},
                "timeout_s": {"type": "number", "description": "Timeout in seconds (default 300, max 3600)."},
            },
            "required": ["host", "command", "reason"],
            "additionalProperties": False,
        },
        mutating=False,
    )

    def __init__(self, svc: RemoteServiceImpl) -> None:
        self._svc = svc

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        host_ref = str(args.get("host") or "").strip()
        command = str(args.get("command") or "")
        if not host_ref or not command.strip():
            return ToolResult(content="`host` and `command` are required.", is_error=True)
        reason = str(args["reason"]) if args.get("reason") else None
        try:
            timeout = float(args.get("timeout_s") or 300)
        except (TypeError, ValueError):
            timeout = 300.0
        host = await self._svc.store.resolve_host(host_ref, ctx.workspace_id)
        result = await self._svc.exec(
            host.id,
            command,
            actor=f"agent:{ctx.session_id}",
            workspace_id=ctx.workspace_id,
            session_id=ctx.session_id,
            task_id=ctx.task_id,
            reason=reason,
            timeout=timeout,
            source="tool",
        )
        data = result.model_dump(mode="json")
        data["output"] = truncate(data.get("output") or "", 2000)
        data["environment"] = host.environment.value
        return ToolResult(
            content=_format_exec(f"{host.name} ({host.environment.value})", result), is_error=result.denied, data=data
        )


class DbQueryTool:
    spec = ToolSpec(
        name="db_query",
        description=DB_QUERY_DESCRIPTION,
        input_schema={
            "type": "object",
            "properties": {
                "profile": {"type": "string", "description": "Database profile name or id."},
                "query": {"type": "string", "description": "SQL, Redis commands or a MongoDB command."},
                "reason": {"type": "string", "description": "Why you need this query (shown to approvers)."},
                "max_rows": {"type": "integer", "description": "Maximum rows to return (default 500, max 5000)."},
            },
            "required": ["profile", "query", "reason"],
            "additionalProperties": False,
        },
        mutating=False,
    )

    def __init__(self, svc: RemoteServiceImpl) -> None:
        self._svc = svc

    async def __call__(self, ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        ref = str(args.get("profile") or "").strip()
        query = str(args.get("query") or "")
        if not ref or not query.strip():
            return ToolResult(content="`profile` and `query` are required.", is_error=True)
        reason = str(args["reason"]) if args.get("reason") else None
        try:
            max_rows = int(args.get("max_rows") or 500)
        except (TypeError, ValueError):
            max_rows = 500
        profile = await self._svc.store.resolve_db_profile(ref, ctx.workspace_id)
        result = await self._svc.db_query(
            profile.id,
            query,
            actor=f"agent:{ctx.session_id}",
            workspace_id=ctx.workspace_id,
            session_id=ctx.session_id,
            task_id=ctx.task_id,
            reason=reason,
            max_rows=max_rows,
            source="tool",
        )
        data = result.model_dump(mode="json", exclude={"rows"})
        data["rows_preview"] = result.rows[:20]
        data["environment"] = profile.environment.value
        label = f"{profile.name} ({profile.kind}, {profile.environment.value})"
        return ToolResult(content=_format_query(label, result), is_error=result.denied or bool(result.error), data=data)
