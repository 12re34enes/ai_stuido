"""Existing Claude Code sessions on disk (spec §6 "Mevcut oturumları ekleme").

Transcripts live in ``<config>/projects/<sanitized cwd>/<session id>.jsonl`` (one JSON record
per line, append-only). ``<sanitized cwd>`` is the cwd with every non-alphanumeric character
replaced by ``-``; names longer than 200 chars are cut and get a hash suffix. Subagent
transcripts live in ``<session id>/subagents/agent-<agentId>.jsonl`` (every record has
``isSidechain: true`` and ``agentId``) next to ``agent-<agentId>.meta.json`` (``agentType``,
``description``, ``toolUseId`` = the spawning tool_use id, ``spawnDepth``, ``requestShape``);
they are not sessions of their own and are replayed inside the parent's history.

Listing reads only the head and tail of each file (like the official SDK) through a single
``sh`` invocation per batch, so it is cheap over SSH as well; the full file is read only when a
session's history is imported.
"""

from __future__ import annotations

import json
import re
import secrets
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from aistudio.adapters.claude.normalize import ClaudeNormalizer, content_text, context_tokens
from aistudio.adapters.claude.protocol import as_dict, as_int, as_list, as_str
from aistudio.adapters.claude.subagents import parse_task_notification
from aistudio.contracts.agents import (
    AgentErrorEv,
    AgentEventPayload,
    NativeSessionInfo,
    SessionStarted,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.contracts.common import Location

SCAN_BYTES = 65536
TITLE_LIMIT = 200
_PROJECT_NAME_LIMIT = 200
_SESSION_ID_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z_-]{7,127}$")
_COMMAND_RE = re.compile(r"<command-name>(.*?)</command-name>")
_BASH_INPUT_RE = re.compile(r"<bash-input>([\s\S]*?)</bash-input>")
_SKIP_PROMPT_RE = re.compile(r"^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])")
_INTERRUPT_RE = re.compile(r"^\s*\[Request interrupted by user[^\]]*\]")
_INTERRUPT_TEXT = "[Request interrupted"

# stat for many files in one process: GNU (-c) or BSD/macOS (-f). Output: "<mtime> <size> <path>".
STAT_SCRIPT = (
    "if stat -c %Y / >/dev/null 2>&1; then exec stat -c '%Y %s %n' -- \"$@\"; "
    "else exec stat -f '%m %z %N' -- \"$@\"; fi"
)

# Head, tail and message counts of many files in one process. $1 is a random marker.
SNAPSHOT_SCRIPT = r"""m="$1"; shift
for f in "$@"; do
  printf '\n%s FILE %s\n' "$m" "$f"
  head -c 65536 -- "$f" 2>/dev/null
  printf '\n%s TAIL\n' "$m"
  tail -c 65536 -- "$f" 2>/dev/null
  printf '\n%s COUNT ' "$m"
  awk '/"type":"user"/ && !/"tool_result"/ && !/"isMeta":true/ &&
       !/"isSidechain":true/ && !/\[Request interrupted/ {u++}
       /"type":"assistant"/ && /"type":"text"/ {a++}
       END {printf "%d %d\n", u, a}' "$f" 2>/dev/null || printf '0 0\n'
done
"""


def valid_session_id(native_id: str) -> bool:
    return bool(_SESSION_ID_RE.match(native_id))


def project_dir_name(cwd: str) -> str:
    """Directory name the CLI uses for ``cwd``. For long paths (hash suffix we cannot compute)
    returns the 200-char prefix followed by ``-``, to be used as a glob prefix."""
    name = re.sub(r"[^a-zA-Z0-9]", "-", cwd)
    if len(name) <= _PROJECT_NAME_LIMIT:
        return name
    return name[:_PROJECT_NAME_LIMIT] + "-"


def new_marker() -> str:
    return f"@@AISTUDIO-{secrets.token_hex(8)}@@"


# --------------------------------------------------------------------------- record helpers


def iter_records(text: str) -> Iterator[dict[str, Any]]:
    """JSON objects of a (possibly truncated) JSONL text; unparsable lines are skipped."""
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            yield value


def _user_texts(rec: dict[str, Any]) -> list[str] | None:
    """Text parts of a user record, or None when it is not a human prompt candidate."""
    if rec.get("type") != "user" or rec.get("isMeta") is True or rec.get("isCompactSummary") is True:
        return None
    content = as_dict(rec.get("message")).get("content")
    if isinstance(content, str):
        return [content]
    texts: list[str] = []
    for raw in as_list(content):
        block = as_dict(raw)
        if block.get("type") == "tool_result":
            return None
        if block.get("type") == "text":
            texts.append(as_str(block.get("text")) or "")
    return texts


def is_interrupt_marker(rec: dict[str, Any]) -> bool:
    texts = _user_texts(rec)
    return bool(texts) and any(_INTERRUPT_RE.match(t) for t in texts or [])


def prompt_text(rec: dict[str, Any]) -> str | None:
    """Full text of a human prompt record (None for tool results, meta, commands, markers)."""
    texts = _user_texts(rec)
    if not texts:
        return None
    kept: list[str] = []
    for t in texts:
        s = t.strip()
        if not s:
            continue
        bash = _BASH_INPUT_RE.search(s)
        if bash:
            kept.append(f"! {bash.group(1).strip()}")
            continue
        if _COMMAND_RE.search(s) or _SKIP_PROMPT_RE.match(s):
            continue
        kept.append(s)
    return "\n".join(kept) if kept else None


def _command_name(rec: dict[str, Any]) -> str | None:
    for t in _user_texts(rec) or []:
        m = _COMMAND_RE.search(t)
        if m:
            return m.group(1).strip() or None
    return None


def _one_line(text: str, limit: int = TITLE_LIMIT) -> str:
    s = " ".join(text.split())
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def _ts(value: Any) -> datetime | None:
    text = as_str(value)
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def count_messages(text: str) -> tuple[int, int]:
    """(human prompt records, assistant text records): same rule as the awk in SNAPSHOT_SCRIPT."""
    users = assistants = 0
    for line in text.splitlines():
        if '"type":"user"' in line and '"tool_result"' not in line:
            if '"isMeta":true' not in line and '"isSidechain":true' not in line and _INTERRUPT_TEXT not in line:
                users += 1
        elif '"type":"assistant"' in line and '"type":"text"' in line:
            assistants += 1
    return users, assistants


# --------------------------------------------------------------------------- listing


@dataclass
class FileSnapshot:
    path: str
    head: str
    tail: str
    mtime: float | None = None
    size: int | None = None
    counts: tuple[int, int] | None = None


def parse_stat_output(out: str) -> dict[str, tuple[float, int]]:
    stats: dict[str, tuple[float, int]] = {}
    for line in out.splitlines():
        parts = line.split(" ", 2)
        if len(parts) != 3:
            continue
        try:
            stats[parts[2]] = (float(parts[0]), int(parts[1]))
        except ValueError:
            continue
    return stats


def parse_snapshot_output(out: str, marker: str) -> list[FileSnapshot]:
    snaps: list[FileSnapshot] = []
    for part in out.split(f"\n{marker} FILE ")[1:]:
        path, _, rest = part.partition("\n")
        head, _, rest = rest.partition(f"\n{marker} TAIL\n")
        tail, _, rest = rest.partition(f"\n{marker} COUNT ")
        counts: tuple[int, int] | None = None
        nums = rest.split("\n", 1)[0].split()
        if len(nums) == 2 and all(n.isdigit() for n in nums):
            counts = (int(nums[0]), int(nums[1]))
        snaps.append(FileSnapshot(path=path, head=head, tail=tail, counts=counts))
    return snaps


def snapshot_from_text(path: str, text: str, *, mtime: float | None = None) -> FileSnapshot:
    return FileSnapshot(
        path=path,
        head=text[:SCAN_BYTES],
        tail=text[-SCAN_BYTES:],
        mtime=mtime,
        size=len(text.encode("utf-8", errors="replace")),
        counts=count_messages(text),
    )


def _first(records: Iterable[dict[str, Any]], key: str) -> str | None:
    for rec in records:
        value = as_str(rec.get(key))
        if value:
            return value
    return None


def _last(records: list[dict[str, Any]], key: str) -> str | None:
    return _first(reversed(records), key)


def _model(records: Iterable[dict[str, Any]]) -> str | None:
    for rec in records:
        if rec.get("type") != "assistant":
            continue
        model = as_str(as_dict(rec.get("message")).get("model"))
        if model and not model.startswith("<"):
            return model
    return None


def session_info(snap: FileSnapshot, *, location: Location) -> NativeSessionInfo | None:
    """Metadata of one transcript from its head/tail. None for sidechains and empty files."""
    first_line = snap.head.split("\n", 1)[0]
    if '"isSidechain":true' in first_line:
        return None
    head = list(iter_records(snap.head))
    tail = list(iter_records(snap.tail))
    native_id = snap.path.rsplit("/", 1)[-1].removesuffix(".jsonl")
    if not native_id:
        return None
    convo = [r for r in head + tail if r.get("type") in ("user", "assistant")]
    message_count = snap.counts[0] + snap.counts[1] if snap.counts is not None else None
    if not convo and not message_count:
        return None

    first_prompt: str | None = None
    command: str | None = None
    for rec in head:
        if rec.get("isSidechain") is True:
            continue
        text = prompt_text(rec)
        if text:
            first_prompt = _one_line(text)
            break
        command = command or _command_name(rec)
    summary = None
    for rec in reversed(tail):
        if rec.get("type") == "summary" and as_str(rec.get("summary")):
            summary = as_str(rec.get("summary"))
            break
    title = (
        _last(tail, "customTitle")
        or _last(head, "customTitle")
        or _last(tail, "aiTitle")
        or _last(head, "aiTitle")
        or summary
        or first_prompt
        or _last(tail, "lastPrompt")
        or command
    )
    created = _ts(_first(head, "timestamp"))
    updated = _ts(_last(tail, "timestamp"))
    if snap.mtime is not None:
        mtime = datetime.fromtimestamp(snap.mtime, UTC)
        updated = max(updated, mtime) if updated else mtime
    return NativeSessionInfo(
        provider="claude",
        native_id=native_id,
        location=location,
        cwd=_first(head, "cwd") or _last(tail, "cwd"),
        title=_one_line(title) if title else None,
        model=_model(reversed(tail)) or _model(head),
        branch=_last(tail, "gitBranch") or _first(head, "gitBranch"),
        message_count=message_count,
        created_at=created,
        updated_at=updated or created,
        file_path=snap.path,
    )


# --------------------------------------------------------------------------- full history


@dataclass
class _HistTurn:
    turn_id: str
    interrupted: bool = False
    failed: str | None = None
    last_text: str | None = None
    usages: dict[str, dict[str, Any]] = field(default_factory=dict)  # message id -> usage


def _close_turn(turn: _HistTurn) -> list[AgentEventPayload]:
    usage: Usage | None = None
    if turn.usages:
        values = list(turn.usages.values())
        usage = Usage(
            input_tokens=sum(as_int(u.get("input_tokens")) or 0 for u in values),
            output_tokens=sum(as_int(u.get("output_tokens")) or 0 for u in values),
            cache_read_tokens=sum(as_int(u.get("cache_read_input_tokens")) or 0 for u in values),
            cache_write_tokens=sum(as_int(u.get("cache_creation_input_tokens")) or 0 for u in values),
            reasoning_tokens=sum(
                as_int(as_dict(u.get("output_tokens_details")).get("thinking_tokens")) or 0 for u in values
            ),
            context_used=context_tokens(values[-1]),
            turns=len(values),
        )
    status: Literal["success", "error", "interrupted"] = (
        "interrupted" if turn.interrupted else "error" if turn.failed else "success"
    )
    out: list[AgentEventPayload] = []
    if usage is not None:
        out.append(usage)
    out.append(
        TurnCompleted(turn_id=turn.turn_id, status=status, result_text=turn.last_text, usage=usage, error=turn.failed)
    )
    return out


@dataclass
class SubagentTranscript:
    """``subagents/agent-<agent_id>.jsonl`` (+ its ``.meta.json``) of a session."""

    agent_id: str
    text: str
    meta: dict[str, Any] = field(default_factory=dict)


def agent_id_from_path(path: str) -> str | None:
    name = path.rsplit("/", 1)[-1]
    for suffix in (".meta.json", ".jsonl"):
        if name.startswith("agent-") and name.endswith(suffix):
            return name[len("agent-") : -len(suffix)] or None
    return None


def _task_notification_text(rec: dict[str, Any]) -> str | None:
    for t in _user_texts(rec) or []:
        if "<task-notification>" in t:
            return t
    return None


class _SubagentReplay:
    """Splices subagent transcripts into the parent's replay right before the spawning tool's
    result (foreground) or at launch (background), tagging everything with ``subagent_id``."""

    def __init__(self, norm: ClaudeNormalizer, transcripts: Mapping[str, SubagentTranscript]) -> None:
        self._norm = norm
        self._transcripts = transcripts
        self._by_tool_use = {
            str(t.meta["toolUseId"]): t.agent_id for t in transcripts.values() if as_str(t.meta.get("toolUseId"))
        }
        self._done: set[str] = set()

    def before_results(self, rec: dict[str, Any]) -> list[AgentEventPayload]:
        results = [as_dict(b) for b in as_list(as_dict(rec.get("message")).get("content"))]
        results = [b for b in results if b.get("type") == "tool_result"]
        out: list[AgentEventPayload] = []
        for block in results:
            call_id = as_str(block.get("tool_use_id"))
            if not call_id or not self._norm.subagents.known(call_id):
                continue
            agent_id = as_str(as_dict(rec.get("toolUseResult")).get("agentId")) if len(results) == 1 else None
            agent_id = agent_id or self._by_tool_use.get(call_id)
            if agent_id:
                out += self._replay(agent_id, call_id)
        return out

    def _replay(self, agent_id: str, subagent_id: str) -> list[AgentEventPayload]:
        transcript = self._transcripts.get(agent_id)
        if transcript is None or agent_id in self._done:
            return []
        self._done.add(agent_id)
        out: list[AgentEventPayload] = []
        for rec in iter_records(transcript.text):
            rtype = rec.get("type")
            if rtype not in ("user", "assistant"):
                continue
            tagged = {**rec, "parent_tool_use_id": subagent_id}
            if rtype == "user":
                if not any(
                    as_dict(b).get("type") == "tool_result" for b in as_list(as_dict(rec.get("message")).get("content"))
                ):
                    continue  # the subagent's prompt and harness notes
                out += self.before_results(tagged)
                out += self._norm.user(tagged, tool_use_result=rec.get("toolUseResult")).payloads
            elif rec.get("isApiErrorMessage") is not True:
                out += self._norm.assistant(tagged).payloads
        return out


def history_payloads(
    text: str, native_id: str, subagents: Mapping[str, SubagentTranscript] | None = None
) -> list[AgentEventPayload]:
    """Normalized replay of a transcript: SessionStarted, then per human prompt a TurnStarted,
    the assistant messages / tool calls / results / file changes, Usage and TurnCompleted.
    CLI-native subagents (``subagents``: transcripts by agent id) are replayed in place as
    SubagentStarted, their tagged payloads and SubagentCompleted."""
    records = [r for r in iter_records(text) if r.get("isSidechain") is not True]
    convo = [r for r in records if r.get("type") in ("user", "assistant")]
    if not convo:
        return []
    cwd = _first(convo, "cwd")
    norm = ClaudeNormalizer(cwd)
    replay = _SubagentReplay(norm, subagents or {})
    out: list[AgentEventPayload] = [
        SessionStarted(native_id=native_id, model=_model(convo), cwd=cwd or "", cli_version=_first(convo, "version"))
    ]
    turn: _HistTurn | None = None
    index = -1
    for rec in records:
        rtype = rec.get("type")
        if rtype == "attachment":
            att = as_dict(rec.get("attachment"))
            if att.get("type") == "queued_command" and att.get("commandMode") == "task-notification":
                out += norm.subagents.text_notification(as_str(att.get("prompt")) or "", att.get("usage"))
            continue
        if rtype not in ("user", "assistant"):
            continue
        index += 1
        if rtype == "user":
            notification = _task_notification_text(rec)
            if notification is not None and parse_task_notification(notification):
                out += norm.subagents.text_notification(notification)
                continue
            prompt = prompt_text(rec)
            if prompt is not None:
                if turn is not None:
                    out += _close_turn(turn)
                turn_id = f"hist_{as_str(rec.get('uuid')) or index}"
                turn = _HistTurn(turn_id=turn_id)
                out.append(TurnStarted(turn_id=turn_id, input=prompt))
                continue
            if is_interrupt_marker(rec):
                if turn is not None:
                    turn.interrupted = True
                continue
            out += replay.before_results(rec)
            out += norm.user(rec, tool_use_result=rec.get("toolUseResult")).payloads
            continue
        message = as_dict(rec.get("message"))
        if rec.get("isApiErrorMessage") is True:
            err = content_text(message.get("content")) or "API hatası"
            out.append(AgentErrorEv(message=err, code="api_error"))
            if turn is not None:
                turn.failed = err
            continue
        result = norm.assistant(rec)
        out += result.payloads
        if turn is not None:
            msg_id = as_str(message.get("id")) or as_str(rec.get("uuid")) or str(index)
            usage = as_dict(message.get("usage"))
            if usage:
                turn.usages[msg_id] = usage
            for raw in as_list(message.get("content")):
                block = as_dict(raw)
                if block.get("type") == "text" and (as_str(block.get("text")) or "").strip():
                    turn.last_text = as_str(block.get("text"))
    out += norm.subagents.finish("interrupted")  # never saw their end (session stopped first)
    if turn is not None:
        out += _close_turn(turn)
    return out
