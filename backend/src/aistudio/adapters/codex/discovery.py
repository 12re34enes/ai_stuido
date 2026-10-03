"""Fallback discovery: scan ``~/.codex/sessions/**/rollout-*.jsonl`` when ``thread/list`` fails.

Rollout format (0.160.0): first line ``{"type": "session_meta", "payload": {"id", "cwd",
"timestamp", "cli_version", "source", "model_provider", ...}}``; conversation lines are
``{"type": "response_item", "payload": {"type": "message", "role": ..., "content": [...]}}``;
``turn_context`` lines carry the ``model``. Injected context messages start with ``<``.
"""

from __future__ import annotations

import json
import logging
import posixpath
from datetime import UTC, datetime
from typing import Any

from aistudio.adapters.codex.mapping import one_line
from aistudio.contracts.agents import NativeSessionInfo
from aistudio.contracts.common import Location
from aistudio.contracts.transport import Transport

log = logging.getLogger(__name__)

MAX_FILE_BYTES = 32 * 1024 * 1024


def _parse_ts(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def _message_text(payload: dict[str, Any]) -> str:
    parts = []
    for c in payload.get("content") or []:
        if isinstance(c, dict) and isinstance(c.get("text"), str):
            parts.append(c["text"])
    return "\n".join(parts)


def parse_rollout(data: bytes, *, path: str, location: Location) -> NativeSessionInfo | None:
    lines = data.decode("utf-8", errors="replace").splitlines()
    if not lines:
        return None
    try:
        first = json.loads(lines[0])
    except json.JSONDecodeError:
        return None
    if not isinstance(first, dict) or first.get("type") != "session_meta":
        return None
    meta = first.get("payload") or {}
    native_id = meta.get("id") or meta.get("session_id")
    if not native_id:
        return None
    title: str | None = None
    model: str | None = None
    count = 0
    last_ts = _parse_ts(first.get("timestamp"))
    for line in lines[1:]:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        last_ts = _parse_ts(rec.get("timestamp")) or last_ts
        payload = rec.get("payload")
        if not isinstance(payload, dict):
            continue
        if rec.get("type") == "turn_context" and isinstance(payload.get("model"), str):
            model = payload["model"]
        if rec.get("type") == "response_item" and payload.get("type") == "message":
            role = payload.get("role")
            text = _message_text(payload)
            if role == "assistant" or (role == "user" and not text.lstrip().startswith("<")):
                count += 1
                if role == "user" and title is None and text.strip():
                    title = one_line(text, 120)
    git = meta.get("git") if isinstance(meta.get("git"), dict) else {}
    return NativeSessionInfo(
        provider="codex",
        native_id=str(native_id),
        location=location,
        cwd=meta.get("cwd"),
        title=title,
        model=model,
        branch=git.get("branch") if git else None,
        message_count=count,
        created_at=_parse_ts(meta.get("timestamp")),
        updated_at=last_ts,
        file_path=path,
    )


async def scan_rollouts(
    transport: Transport, *, location: Location, cwd: str | None, limit: int
) -> list[NativeSessionInfo]:
    home = await transport.home()
    root = posixpath.join(home, ".codex", "sessions")
    try:
        files = await transport.glob(posixpath.join(root, "**", "rollout-*.jsonl"))
    except Exception as e:
        log.info("codex: cannot list %s: %s", root, e)
        return []
    # file names embed the start time (rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl): newest first
    files.sort(key=posixpath.basename, reverse=True)
    out: list[NativeSessionInfo] = []
    want_cwd = cwd.rstrip("/") if cwd else None
    for path in files:
        if len(out) >= limit:
            break
        try:
            data = await transport.read_file(path)
        except Exception as e:
            log.debug("codex: cannot read %s: %s", path, e)
            continue
        if len(data) > MAX_FILE_BYTES:
            data = data[:MAX_FILE_BYTES]
        info = parse_rollout(data, path=path, location=location)
        if info is None:
            continue
        if want_cwd and (info.cwd or "").rstrip("/") != want_cwd:
            continue
        out.append(info)
    out.sort(key=lambda i: i.updated_at or datetime.min.replace(tzinfo=UTC), reverse=True)
    return out
