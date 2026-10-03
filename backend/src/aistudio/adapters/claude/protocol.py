"""Wire helpers for Claude Code's headless stream-json + SDK control protocol.

See ``PROTOCOL.md`` next to this file for the message catalogue. Everything here is pure
(no I/O) so it can be shared by the live session, the history parser and the tests.
"""

from __future__ import annotations

import json
import re
from typing import Any

# Versions this adapter was written and tested against (spec §6 "Sürüm politikası").
TESTED_MIN = (2, 1, 200)
TESTED_MAX_EXCLUSIVE = (2, 2, 0)
TESTED_RANGE = ">=2.1.200,<2.2"

# Name of the in-process SDK MCP server that serves Studio tools (tools appear to the
# model as ``mcp__studio__<tool>``).
STUDIO_SERVER = "studio"

# MCP protocol versions our in-process server can speak (newest first). We echo the
# client's requested version when we know it, otherwise answer with the newest.
MCP_PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07")

# Effort levels accepted by ``claude --effort``.
EFFORT_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})

_VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")


def encode(message: dict[str, Any]) -> bytes:
    """One NDJSON line (compact JSON, UTF-8, trailing newline)."""
    return (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def decode(line: bytes) -> dict[str, Any] | None:
    """Parse one stdout line. Returns ``None`` for blank lines; raises ``ValueError`` for
    lines that are not a JSON object."""
    text = line.decode("utf-8", errors="replace").strip()
    if not text:
        return None
    value = json.loads(text)
    if not isinstance(value, dict):
        raise ValueError("stream-json line is not an object")
    return value


def user_message(text: str, *, session_id: str | None, uuid: str, priority: str | None = None) -> dict[str, Any]:
    """A stream-json user turn. ``uuid`` is echoed back by the CLI on the reply frames and the
    result (``user_message_uuid(s)``), which is how we bind results to our turns."""
    msg: dict[str, Any] = {
        "type": "user",
        "message": {"role": "user", "content": text},
        "parent_tool_use_id": None,
        "uuid": uuid,
    }
    if session_id:
        msg["session_id"] = session_id
    if priority:
        msg["priority"] = priority
    return msg


def control_request(request_id: str, request: dict[str, Any]) -> dict[str, Any]:
    return {"type": "control_request", "request_id": request_id, "request": request}


def control_success(request_id: str, response: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request_id, "response": response or {}},
    }


def control_error(request_id: str, error: str) -> dict[str, Any]:
    return {"type": "control_response", "response": {"subtype": "error", "request_id": request_id, "error": error}}


def parse_version(text: str | None) -> tuple[int, int, int] | None:
    if not text:
        return None
    m = _VERSION_RE.search(text)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def version_in_tested_range(version: tuple[int, int, int]) -> bool:
    return TESTED_MIN <= version < TESTED_MAX_EXCLUSIVE


def format_version(version: tuple[int, int, int]) -> str:
    return ".".join(str(p) for p in version)


def as_dict(value: Any) -> dict[str, Any]:
    """``value`` if it is a dict, else an empty dict (tolerant field access)."""
    return value if isinstance(value, dict) else {}


def as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    return None


def as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    return None
