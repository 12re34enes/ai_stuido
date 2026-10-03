"""Audit log of remote commands and database queries, read from the immutable event log."""

from __future__ import annotations

import csv
import io
import json
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any, Literal

from aistudio.core.eventlog import EventLog
from aistudio.core.events import ET, Event, EventFilter
from aistudio.remote.models import AuditEntry, AuditPage

AuditKind = Literal["all", "host", "db"]

_BATCH = 500
CSV_COLUMNS = [
    "event_id",
    "ts",
    "type",
    "severity",
    "actor",
    "workspace_id",
    "task_id",
    "session_id",
    "target_kind",
    "target_id",
    "target_name",
    "environment",
    "command",
    "klass",
    "reasons",
    "decision",
    "denied",
    "denial_reason",
    "approval_id",
    "approved_by",
    "exit_code",
    "row_count",
    "duration_ms",
    "source",
    "reason",
    "error",
    "output_preview",
    "prev_hash",
    "hash",
]


def to_entry(ev: Event) -> AuditEntry:
    p = ev.payload
    is_db = ev.type == ET.DB_QUERY
    classification = p.get("classification") or {}
    return AuditEntry(
        event_id=ev.id,
        ts=ev.ts,
        type=ev.type,
        severity=ev.severity.value,
        actor=ev.actor,
        workspace_id=ev.workspace_id,
        task_id=ev.task_id,
        session_id=ev.session_id,
        target_kind="db" if is_db else "host",
        target_id=p.get("profile_id") if is_db else p.get("host_id"),
        target_name=p.get("profile_name") if is_db else p.get("host_name"),
        environment=p.get("environment"),
        command=str((p.get("query") if is_db else p.get("command")) or ""),
        klass=classification.get("klass"),
        reasons=list(classification.get("reasons") or []),
        decision=p.get("outcome") or p.get("decision"),
        denied=bool(p.get("denied")),
        denial_reason=p.get("denial_reason"),
        approval_id=p.get("approval_id"),
        approved_by=p.get("approved_by"),
        exit_code=p.get("exit_code"),
        row_count=p.get("row_count"),
        duration_ms=p.get("duration_ms"),
        output_preview=p.get("output_preview"),
        source=p.get("source"),
        reason=p.get("reason"),
        error=p.get("error"),
        hash=ev.hash,
        prev_hash=ev.prev_hash,
    )


class AuditFilter:
    def __init__(
        self,
        *,
        kind: AuditKind = "all",
        target_id: str | None = None,
        environment: str | None = None,
        actor: str | None = None,
        klass: str | None = None,
        denied: bool | None = None,
        workspace_id: str | None = None,
        since: datetime | None = None,
        until: datetime | None = None,
        text: str | None = None,
    ) -> None:
        self.kind = kind
        self.target_id = target_id
        self.environment = environment
        self.actor = actor
        self.klass = klass
        self.denied = denied
        self.workspace_id = workspace_id
        self.since = since
        self.until = until
        self.text = text.casefold() if text else None

    def types(self) -> list[str]:
        if self.kind == "host":
            return [ET.REMOTE_COMMAND]
        if self.kind == "db":
            return [ET.DB_QUERY]
        return [ET.REMOTE_COMMAND, ET.DB_QUERY]

    def matches(self, e: AuditEntry) -> bool:
        if self.target_id and e.target_id != self.target_id:
            return False
        if self.environment and e.environment != self.environment:
            return False
        if self.actor:
            if self.actor == "agent":
                if not e.actor.startswith("agent:"):
                    return False
            elif e.actor != self.actor:
                return False
        if self.klass and e.klass != self.klass:
            return False
        if self.denied is not None and e.denied != self.denied:
            return False
        if self.since and e.ts < self.since:
            return False
        if self.until and e.ts > self.until:
            return False
        return not (self.text and self.text not in e.command.casefold())


async def iter_audit(
    events: EventLog, flt: AuditFilter, *, before_id: int | None = None, scan_limit: int = 200_000
) -> AsyncIterator[tuple[AuditEntry, int]]:
    """Newest first. Yields (entry, scanned_event_id)."""
    ev_filter = EventFilter(types=flt.types(), workspace_id=flt.workspace_id)
    cursor = before_id
    scanned = 0
    while scanned < scan_limit:
        batch = await events.query(ev_filter, before_id=cursor, limit=_BATCH, descending=True)
        if not batch:
            return
        for ev in batch:
            scanned += 1
            entry = to_entry(ev)
            if flt.since and entry.ts < flt.since:
                return
            if flt.matches(entry):
                yield entry, ev.id
        cursor = batch[-1].id
        if len(batch) < _BATCH:
            return


async def query_audit(
    events: EventLog, flt: AuditFilter, *, before_id: int | None = None, limit: int = 200
) -> AuditPage:
    limit = max(1, min(limit, 2000))
    entries: list[AuditEntry] = []
    async for entry, _ in iter_audit(events, flt, before_id=before_id):
        if len(entries) >= limit:
            return AuditPage(entries=entries, has_more=True, next_before_id=entries[-1].event_id)
        entries.append(entry)
    return AuditPage(entries=entries, has_more=False, next_before_id=None)


def _csv_value(entry: AuditEntry, column: str) -> Any:
    value = getattr(entry, column)
    if column == "reasons":
        return " | ".join(value)
    if isinstance(value, datetime):
        return value.isoformat()
    return "" if value is None else value


async def export_audit(
    events: EventLog, flt: AuditFilter, fmt: Literal["csv", "json"], *, max_rows: int = 100_000
) -> str:
    rows: list[AuditEntry] = []
    async for entry, _ in iter_audit(events, flt):
        rows.append(entry)
        if len(rows) >= max_rows:
            break
    rows.reverse()  # chronological, so the hash chain reads top to bottom
    if fmt == "json":
        return json.dumps([r.model_dump(mode="json") for r in rows], ensure_ascii=False, indent=2)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(CSV_COLUMNS)
    for r in rows:
        writer.writerow([_csv_value(r, c) for c in CSV_COLUMNS])
    return buf.getvalue()
