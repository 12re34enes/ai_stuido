"""Compact memory text for an agent's system prompt (spec §10).

Only facts, a boundaries summary, the decision index and the latest session titles go into the
prompt; agents read details with ``memory_read``. The text is trimmed per role (advisors get
more decisions, writers more boundary detail) and hard-capped at :data:`CONTEXT_CAP` chars.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from aistudio.contracts.agents import AgentRole, Boundaries
from aistudio.memory.boundaries import summarize_boundaries
from aistudio.memory.markdown import compact, one_line, truncate_lines

CONTEXT_CAP = 8000
TRUNCATION_MARKER = "… (kısaltıldı; tamamı için `memory_read`)"
_SECTION_SEP = "\n\n"


@dataclass(frozen=True)
class DecisionEntry:
    path: str
    date: str
    title: str
    summary: str | None = None
    status: str | None = None


@dataclass(frozen=True)
class SessionEntry:
    path: str
    date: str
    title: str


@dataclass(frozen=True)
class RoleProfile:
    order: tuple[str, ...]  # section keys, highest priority first
    facts_chars: int
    notes_chars: int  # human explanation part of boundaries.md (0 = omitted)
    decisions: int  # max decision entries
    decisions_chars: int
    sessions: int
    sessions_chars: int


_WRITER = RoleProfile(
    order=("boundaries", "facts", "notes", "decisions", "sessions"),
    facts_chars=3600,
    notes_chars=1600,
    decisions=8,
    decisions_chars=1300,
    sessions=3,
    sessions_chars=500,
)
_ADVISOR = RoleProfile(
    order=("boundaries", "facts", "decisions", "sessions"),
    facts_chars=3000,
    notes_chars=0,
    decisions=30,
    decisions_chars=3600,
    sessions=3,
    sessions_chars=500,
)

ROLE_PROFILES: dict[AgentRole, RoleProfile] = {
    "writer": _WRITER,
    "tester": replace(_WRITER, decisions=6, decisions_chars=1000),
    "reviewer": RoleProfile(
        order=("boundaries", "facts", "notes", "decisions", "sessions"),
        facts_chars=3200,
        notes_chars=1200,
        decisions=12,
        decisions_chars=1800,
        sessions=2,
        sessions_chars=400,
    ),
    "planner": RoleProfile(
        order=("boundaries", "facts", "decisions", "notes", "sessions"),
        facts_chars=3200,
        notes_chars=700,
        decisions=20,
        decisions_chars=2600,
        sessions=4,
        sessions_chars=600,
    ),
    "advisor": _ADVISOR,
    "synthesizer": _ADVISOR,
    "judge": RoleProfile(
        order=("boundaries", "facts", "decisions", "sessions"),
        facts_chars=3000,
        notes_chars=0,
        decisions=15,
        decisions_chars=2000,
        sessions=2,
        sessions_chars=400,
    ),
}


def _decision_line(d: DecisionEntry) -> str:
    line = f"- {d.date} — {one_line(d.title, 100)}"
    if d.status:
        line += f" [{one_line(d.status, 30)}]"
    if d.summary:
        line += f": {one_line(d.summary, 160)}"
    return line + f" (`{d.path}`)"


def _list_section(lines: list[str], total: int, shown: int, more_label: str) -> str:
    if total > shown:
        lines = [*lines, f"- … ve {total - shown} {more_label} daha (`memory_read` ile listelenebilir)"]
    return "\n".join(lines)


def build_context(
    *,
    workspace_name: str,
    role: AgentRole,
    facts: str,
    boundaries: Boundaries,
    boundary_notes: str,
    decisions: list[DecisionEntry],
    sessions: list[SessionEntry],
    cap: int = CONTEXT_CAP,
) -> str:
    """``decisions`` and ``sessions`` must be ordered newest first."""
    profile = ROLE_PROFILES.get(role, _WRITER)
    header = (
        f"# Ortak hafıza: {workspace_name}\n"
        "Bu bölüm çalışma alanının ortak hafızasından gelir; tüm ajanlar aynı bilgiyi görür."
    )
    footer = (
        "Ayrıntı için `memory_read` aracını kullan. Kalıcı bir bilgi ya da karar eklemek için "
        "`memory_propose` ile öneri yap; öneri kullanıcı onayından sonra kaydedilir. "
        "Hafıza dosyalarını doğrudan düzenleme."
    )

    facts_body = compact(facts, shift_headings=1) or "_Henüz proje gerçeği yazılmamış._"
    notes_body = compact(boundary_notes, shift_headings=1) if profile.notes_chars else ""
    shown_decisions = decisions[: profile.decisions]
    shown_sessions = sessions[: profile.sessions]

    # key -> (heading, body, max chars or None for "as much as fits")
    sections: dict[str, tuple[str, str, int | None]] = {
        "boundaries": (
            "## Sınırlar (zorunlu)",
            "\n".join(summarize_boundaries(boundaries)),
            None,
        ),
        "facts": ("## Proje gerçekleri", facts_body, profile.facts_chars),
        "notes": ("## Sınırlar hakkında açıklamalar", notes_body, profile.notes_chars),
        "decisions": (
            "## Karar dizini (en yeni önce)",
            _list_section([_decision_line(d) for d in shown_decisions], len(decisions), len(shown_decisions), "karar")
            if decisions
            else "",
            profile.decisions_chars,
        ),
        "sessions": (
            "## Son oturumlar",
            _list_section(
                [f"- {s.date} — {one_line(s.title, 120)} (`{s.path}`)" for s in shown_sessions],
                len(sessions),
                len(shown_sessions),
                "oturum",
            )
            if sessions
            else "",
            profile.sessions_chars,
        ),
    }

    parts: dict[str, str] = {}
    remaining = cap - len(header) - len(footer) - 2 * len(_SECTION_SEP)
    for key in profile.order:
        heading, body, limit = sections[key]
        if not body.strip():
            continue
        room = remaining - len(heading) - 1 - len(_SECTION_SEP)
        if limit is not None:
            room = min(room, limit)
        if room < 120:  # not enough space left for anything useful
            continue
        text = heading + "\n" + truncate_lines(body, room, marker=TRUNCATION_MARKER)
        parts[key] = text
        remaining -= len(text) + len(_SECTION_SEP)

    ordered = [parts[k] for k in ("boundaries", "facts", "notes", "decisions", "sessions") if k in parts]
    result = _SECTION_SEP.join([header, *ordered, footer])
    if len(result) > cap:  # defensive: the budget above should already guarantee this
        result = truncate_lines(result, cap, marker=TRUNCATION_MARKER)
    return result
