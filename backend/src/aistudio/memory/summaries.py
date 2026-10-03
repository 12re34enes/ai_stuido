"""Session summaries built from a session's events (no LLM call).

On ``agent.session.ended`` the memory service proposes ``sessions/YYYY-MM-DD-<session>.md``
containing the task, the final assistant message, changed files, commands and usage.
Event payloads are already masked by the event log.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from aistudio.core.events import ET, Event
from aistudio.core.text import slugify
from aistudio.memory.markdown import one_line

_MAX_REQUEST = 1200
_MAX_RESULT = 3000
_MAX_COMMANDS = 25
_MAX_FILES = 60
_MAX_ERRORS = 10

CHANGE_LABELS = {"add": "eklendi", "modify": "değiştirildi", "delete": "silindi", "rename": "yeniden adlandırıldı"}
END_LABELS = {"completed": "tamamlandı", "closed": "kapatıldı", "error": "hata ile bitti", "killed": "sonlandırıldı"}
PROVIDER_LABELS = {"claude": "Claude", "codex": "Codex"}


@dataclass
class SessionMeta:
    """Optional facts not present in the events (from the agent manager / engine)."""

    label: str | None = None
    provider: str | None = None
    model: str | None = None
    role: str | None = None
    task_title: str | None = None


@dataclass
class _Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    turns: int = 0

    def add(self, u: dict[str, Any]) -> None:
        for k in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"):
            v = u.get(k)
            if isinstance(v, int | float):
                setattr(self, k, getattr(self, k) + int(v))

    @property
    def any(self) -> bool:
        return bool(self.input_tokens or self.output_tokens or self.cache_read_tokens or self.cache_write_tokens)


@dataclass
class _Command:
    text: str
    exit_code: int | None = None
    is_error: bool = False


@dataclass
class _Collected:
    started: datetime | None = None
    ended: datetime | None = None
    end_reason: str | None = None
    end_error: str | None = None
    model: str | None = None
    cwd: str | None = None
    requests: list[str] = field(default_factory=list)
    final_text: str | None = None
    files: dict[str, str] = field(default_factory=dict)  # path -> change
    commands: dict[str, _Command] = field(default_factory=dict)  # call_id -> command
    errors: list[str] = field(default_factory=list)
    usage: _Usage = field(default_factory=_Usage)
    last_usage_event: dict[str, Any] | None = None
    turns: int = 0


def fmt_int(n: int) -> str:
    """Turkish thousands separator: 12345 -> 12.345."""
    return f"{n:,}".replace(",", ".")


def fmt_duration(seconds: float) -> str:
    s = max(0, round(seconds))
    if s < 60:
        return f"{s} sn"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m} dk {s} sn" if s else f"{m} dk"
    h, m = divmod(m, 60)
    return f"{h} sa {m} dk" if m else f"{h} sa"


def _command_text(payload: dict[str, Any]) -> str:
    raw = payload.get("input")
    inp: dict[str, Any] = raw if isinstance(raw, dict) else {}
    cmd = inp.get("command") or inp.get("cmd")
    if isinstance(cmd, list):
        cmd = " ".join(str(c) for c in cmd)
    text = cmd or payload.get("summary") or payload.get("tool") or "?"
    return one_line(str(text), 160)


def _collect(events: list[Event]) -> _Collected:
    c = _Collected()
    for ev in events:
        p = ev.payload
        if ev.type == ET.AGENT_SESSION_STARTED:
            c.started = c.started or ev.ts
            c.model = p.get("model") or c.model
            c.cwd = p.get("cwd") or c.cwd
        elif ev.type == ET.AGENT_TURN_STARTED:
            text = str(p.get("input") or "").strip()
            if text:
                c.requests.append(text)
            c.started = c.started or ev.ts
        elif ev.type == ET.AGENT_MESSAGE:
            # A subagent's text (a background one can even land after the turn) is not the
            # session's answer; its file changes and commands still count below.
            if p.get("subagent_id"):
                continue
            if p.get("role", "assistant") == "assistant" and str(p.get("text") or "").strip():
                c.final_text = str(p["text"]).strip()
        elif ev.type == ET.AGENT_TURN_COMPLETED:
            c.turns += 1
            result = str(p.get("result_text") or "").strip()
            if result:
                c.final_text = result
            usage = p.get("usage")
            if isinstance(usage, dict):
                c.usage.add(usage)
            if p.get("status") == "error" and p.get("error"):
                c.errors.append(one_line(str(p["error"]), 300))
        elif ev.type == ET.AGENT_USAGE:
            if not p.get("subagent_id"):  # a subagent's running total is not the session's usage
                c.last_usage_event = p
        elif ev.type == ET.AGENT_FILE_CHANGED:
            path = str(p.get("path") or "").strip()
            if path:
                change = str(p.get("change") or "modify")
                if path in c.files and c.files[path] == "add" and change == "modify":
                    change = "add"  # created then edited in the same session: still "added"
                c.files[path] = change
        elif ev.type == ET.AGENT_TOOL_CALL:
            call_id = str(p.get("call_id") or len(c.commands))
            if p.get("kind") == "command":
                c.commands[call_id] = _Command(_command_text(p))
            elif p.get("kind") == "file_edit":
                raw = p.get("input")
                inp: dict[str, Any] = raw if isinstance(raw, dict) else {}
                path = inp.get("file_path") or inp.get("path")
                if isinstance(path, str) and path.strip():
                    c.files.setdefault(path.strip(), "modify")
        elif ev.type == ET.AGENT_TOOL_RESULT:
            cmd = c.commands.get(str(p.get("call_id")))
            if cmd is not None:
                code = p.get("exit_code")
                cmd.exit_code = code if isinstance(code, int) else None
                cmd.is_error = bool(p.get("is_error"))
        elif ev.type == ET.AGENT_ERROR:
            msg = str(p.get("message") or "").strip()
            if msg:
                c.errors.append(one_line(msg, 300))
        elif ev.type == ET.AGENT_SESSION_ENDED:
            c.ended = ev.ts
            c.end_reason = p.get("reason")
            if p.get("error"):
                c.end_error = one_line(str(p["error"]), 300)
    if not c.usage.any and c.last_usage_event:
        c.usage.add(c.last_usage_event)
    return c


def _clip(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n\n… (kısaltıldı)"


def summary_path(session_id: str, ended_at: datetime) -> str:
    day = ended_at.astimezone().strftime("%Y-%m-%d")  # the user's local date
    return f"sessions/{day}-{slugify(session_id, max_len=60, fallback='oturum')}.md"


def build_session_summary(
    session_id: str, events: list[Event], meta: SessionMeta | None = None
) -> tuple[str, str] | None:
    """Return ``(path, markdown)``, or ``None`` when the session did nothing worth recording."""
    meta = meta or SessionMeta()
    c = _collect(events)
    if not c.requests and not c.final_text and not c.files and not c.commands:
        return None
    ended = c.ended or (events[-1].ts if events else None)
    if ended is None:
        return None
    local_end = ended.astimezone()
    provider = PROVIDER_LABELS.get(meta.provider or "", meta.provider or "")
    who = meta.label or provider or "Ajan"
    first_request = c.requests[0] if c.requests else ""
    topic = meta.task_title or (one_line(first_request, 80) if first_request else None)

    title = f"# Oturum özeti: {topic}" if topic else f"# Oturum özeti: {who}"
    lines: list[str] = [title, ""]
    model = meta.model or c.model
    agent_desc = ", ".join(x for x in (provider, model, meta.role) if x)
    session_line = f"- **Oturum:** `{session_id}`"
    if meta.label:
        session_line += f" — {who}"
    if agent_desc:
        session_line += f" ({agent_desc})"
    lines.append(session_line)
    if meta.task_title:
        lines.append(f"- **Görev:** {one_line(meta.task_title, 160)}")
    end_label = END_LABELS.get(c.end_reason or "", c.end_reason or "bilinmiyor")
    lines.append(f"- **Bitiş:** {local_end.strftime('%Y-%m-%d %H:%M')} — {end_label}")
    stats: list[str] = []
    if c.started and c.ended:
        stats.append(f"süre {fmt_duration((c.ended - c.started).total_seconds())}")
    if c.turns:
        stats.append(f"{c.turns} tur")
    if stats:
        lines.append("- **Çalışma:** " + ", ".join(stats))
    if c.usage.any:
        tokens = [f"giriş {fmt_int(c.usage.input_tokens)}", f"çıkış {fmt_int(c.usage.output_tokens)}"]
        if c.usage.cache_read_tokens or c.usage.cache_write_tokens:
            tokens.append(f"önbellek {fmt_int(c.usage.cache_read_tokens + c.usage.cache_write_tokens)}")
        lines.append("- **Token:** " + ", ".join(tokens))
    if c.cwd:
        lines.append(f"- **Dizin:** `{c.cwd}`")

    if first_request:
        quoted = [f"> {ln}" if ln.strip() else ">" for ln in _clip(first_request, _MAX_REQUEST).splitlines()]
        lines += ["", "## İstek", "", *quoted]
        if len(c.requests) > 1:
            lines += ["", f"Oturumda {len(c.requests) - 1} ek mesaj daha gönderildi."]

    result = _clip(c.final_text, _MAX_RESULT) if c.final_text else "_Ajan son bir yanıt üretmedi._"
    lines += ["", "## Sonuç", "", result]

    if c.files:
        lines += ["", "## Değişen dosyalar", ""]
        items = sorted(c.files.items())
        lines += [f"- `{path}` ({CHANGE_LABELS.get(change, change)})" for path, change in items[:_MAX_FILES]]
        if len(items) > _MAX_FILES:
            lines.append(f"- … ve {len(items) - _MAX_FILES} dosya daha")

    if c.commands:
        lines += ["", "## Çalıştırılan komutlar", ""]
        cmds = list(c.commands.values())
        for cmd in cmds[:_MAX_COMMANDS]:
            suffix = ""
            if cmd.exit_code is not None:
                suffix = f" — çıkış kodu {cmd.exit_code}"
            elif cmd.is_error:
                suffix = " — hata"
            lines.append(f"- `{cmd.text}`{suffix}")
        if len(cmds) > _MAX_COMMANDS:
            lines.append(f"- … ve {len(cmds) - _MAX_COMMANDS} komut daha")

    errors = [*c.errors, *([c.end_error] if c.end_error else [])]
    if errors:
        lines += ["", "## Hatalar", ""]
        lines += [f"- {e}" for e in dict.fromkeys(errors)][:_MAX_ERRORS]

    return summary_path(session_id, ended), "\n".join(lines).rstrip() + "\n"


# --------------------------------------------------------------------------- task summaries

GATE_LABELS: dict[str, str] = {
    "plan_approval": "Plan onayı",
    "boundary_check": "Sınır denetimi",
    "build_test": "Build/test kanıtı",
    "cross_review": "Çapraz inceleme",
    "user_final": "Son onay",
    "deploy_approval": "Deploy onayı",
    "custom_command": "Özel komut",
}
GATE_STATUS_LABELS: dict[str, str] = {"gate.passed": "geçti", "gate.failed": "geçemedi", "gate.skipped": "atlandı"}


def task_summary_path(task_id: str, title: str, ended_at: datetime) -> str:
    day = ended_at.astimezone().strftime("%Y-%m-%d")
    slug = slugify(title, max_len=40, fallback="gorev")
    return f"sessions/{day}-gorev-{slug}-{task_id[-6:].lower()}.md"


def build_task_summary(
    task_id: str,
    title: str,
    events: list[Event],
    *,
    status: str,
    mode: str | None = None,
    quality_score: float | None = None,
) -> tuple[str, str] | None:
    """One summary per finished task (flow sessions don't get their own): request, gate results,
    changed files, commands and usage across every agent of the task."""
    if not events:
        return None
    c = _collect([e for e in events if e.type.startswith("agent.")])
    ended = events[-1].ts
    status_label = {"completed": "tamamlandı", "failed": "başarısız"}.get(status, status)
    lines: list[str] = [f"# Görev özeti: {one_line(title, 120)}", ""]
    lines.append(f"- **Görev:** `{task_id}`" + (f" — mod: {mode}" if mode else ""))
    lines.append(f"- **Sonuç:** {status_label} ({ended.astimezone().strftime('%Y-%m-%d %H:%M')})")
    if quality_score is not None:
        lines.append(f"- **Kalite puanı:** {quality_score:.0f}/100")
    sessions = sorted({e.session_id for e in events if e.session_id})
    if sessions:
        lines.append(f"- **Ajan oturumları:** {len(sessions)}")
    if c.usage.any:
        lines.append(f"- **Token:** giriş {fmt_int(c.usage.input_tokens)}, çıkış {fmt_int(c.usage.output_tokens)}")

    if c.requests:
        quoted = [f"> {ln}" if ln.strip() else ">" for ln in _clip(c.requests[0], _MAX_REQUEST).splitlines()]
        lines += ["", "## İstek", "", *quoted]

    gates = [e for e in events if e.type in GATE_STATUS_LABELS]
    if gates:
        lines += ["", "## Kapılar", ""]
        for e in gates[-20:]:
            kind = str(e.payload.get("gate") or "")
            label = GATE_LABELS.get(kind, kind or "Kapı")
            note = one_line(str(e.payload.get("summary") or ""), 160)
            lines.append(f"- {label}: {GATE_STATUS_LABELS[e.type]}" + (f" — {note}" if note else ""))

    result = _clip(c.final_text, _MAX_RESULT) if c.final_text else None
    if result:
        lines += ["", "## Son yanıt", "", result]

    if c.files:
        lines += ["", "## Değişen dosyalar", ""]
        items = sorted(c.files.items())
        lines += [f"- `{path}` ({CHANGE_LABELS.get(change, change)})" for path, change in items[:_MAX_FILES]]
        if len(items) > _MAX_FILES:
            lines.append(f"- … ve {len(items) - _MAX_FILES} dosya daha")

    if c.commands:
        lines += ["", "## Çalıştırılan komutlar", ""]
        cmds = list(c.commands.values())
        lines += [
            f"- `{cmd.text}`" + (f" — çıkış kodu {cmd.exit_code}" if cmd.exit_code is not None else "")
            for cmd in cmds[:_MAX_COMMANDS]
        ]
        if len(cmds) > _MAX_COMMANDS:
            lines.append(f"- … ve {len(cmds) - _MAX_COMMANDS} komut daha")

    failures = (str(e.payload["error"]) for e in events if e.type == "task.failed" and e.payload.get("error"))
    flat = [*c.errors, *failures]
    if flat:
        lines += ["", "## Hatalar", ""]
        lines += [f"- {e}" for e in dict.fromkeys(flat)][:_MAX_ERRORS]

    return task_summary_path(task_id, title, ended), "\n".join(lines).rstrip() + "\n"
