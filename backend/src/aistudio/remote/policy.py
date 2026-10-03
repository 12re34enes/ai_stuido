"""Permission policy for remote commands and database queries (spec §8, §12). Pure.

Inputs: the target's environment and permission level, the command classification, the
agent's ``Boundaries.remote_access`` when the actor is an agent, and whether every write
segment matches the target's limited-write patterns.

Rules (``unknown`` is always treated as ``write``):

* agent with ``remote_access: none``              -> deny (even reads)
* agent with ``remote_access: read`` and a write  -> deny
* agents are additionally capped at their access level (effective level = min(target, agent))
* read                                            -> allow (always audited); DB reads run in a
                                                     read-only transaction on production or at read level
* write on production                             -> individual approval, every time (never cached,
                                                     no "always allow"), regardless of level
* write elsewhere: level read -> approval; limited -> allowed only if every write segment matches
  a limited-write pattern, else approval; full -> allowed
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.remote import CommandClass
from aistudio.remote.classify import ClassifiedCommand

RemoteAccess = Literal["none", "read", "limited", "full"]
ActorKind = Literal["user", "agent", "system"]
Action = Literal["allow", "approve", "deny"]

_LEVEL_ORDER = [PermissionLevel.read, PermissionLevel.limited, PermissionLevel.full]


@dataclass(frozen=True)
class PolicyDecision:
    action: Action
    reason: str  # Turkish
    effective_level: PermissionLevel
    readonly_session: bool = False  # DB: open a read-only transaction


def actor_kind(actor: str) -> ActorKind:
    if actor.startswith("agent:"):
        return "agent"
    if actor == "system":
        return "system"
    return "user"


def agent_session_id(actor: str) -> str | None:
    if actor.startswith("agent:"):
        return actor.split(":", 1)[1] or None
    return None


def decide(
    *,
    environment: Environment,
    level: PermissionLevel,
    klass: CommandClass,
    agent_access: RemoteAccess | None,
    limited_match: bool,
) -> PolicyDecision:
    """``agent_access`` is ``None`` when the actor is not an agent."""
    is_write = klass != "read"
    unknown_note = "Bilinmeyen komut yazma sayılır. " if klass == "unknown" else ""
    effective = level
    if agent_access is not None:
        if agent_access == "none":
            return PolicyDecision("deny", "Bu ajanın uzak erişim yetkisi yok (remote_access: none).", level)
        if agent_access == "read" and is_write:
            return PolicyDecision(
                "deny",
                unknown_note + "Ajanın uzak erişimi salt okuma; yazma komutları reddedilir.",
                PermissionLevel.read,
            )
        effective = min(level, PermissionLevel(agent_access), key=_LEVEL_ORDER.index)
    production = environment == Environment.production
    if not is_write:
        return PolicyDecision(
            "allow",
            "Okuma işlemi; kayıt altına alınarak çalıştırılır.",
            effective,
            readonly_session=production or effective == PermissionLevel.read,
        )
    if production:
        return PolicyDecision(
            "approve",
            unknown_note + "Production ortamında yazma: her komut için ayrı onay gerekir.",
            effective,
        )
    if effective == PermissionLevel.read:
        return PolicyDecision("approve", unknown_note + "Salt okuma yetkili hedefte yazma: onay gerekir.", effective)
    if effective == PermissionLevel.limited:
        if limited_match:
            return PolicyDecision("allow", "Sınırlı yazma kalıbıyla eşleşti; izin verildi.", effective)
        return PolicyDecision(
            "approve", unknown_note + "Sınırlı yazma kalıplarıyla eşleşmedi: onay gerekir.", effective
        )
    return PolicyDecision("allow", unknown_note + "Tam yetki: yazma işlemine izin verildi.", effective)


# ---------------------------------------------------------------------------- limited-write patterns

PatternKind = Literal["shell", "sql", "redis", "mongodb"]

# A glob ``*``/``?`` never matches these, so a pattern cannot swallow command separators,
# substitutions or redirections.
_FORBIDDEN: dict[PatternKind, str] = {
    "shell": ";&|<>$`()\n\\",
    "sql": ";",
    "redis": "\n",
    "mongodb": "\n",
}


def compile_pattern(pattern: str, kind: PatternKind) -> re.Pattern[str]:
    """``re:<regex>`` is a full-match regular expression; anything else is a glob where ``*``
    and ``?`` cannot match shell/SQL metacharacters. SQL/Redis/Mongo patterns ignore case."""
    flags = re.IGNORECASE if kind != "shell" else 0
    if pattern.startswith("re:"):
        return re.compile(pattern[3:], flags)
    forbidden = re.escape(_FORBIDDEN[kind])
    out: list[str] = []
    for ch in " ".join(pattern.split()):
        if ch == "*":
            out.append(f"[^{forbidden}]*")
        elif ch == "?":
            out.append(f"[^{forbidden}]")
        else:
            out.append(re.escape(ch))
    return re.compile("".join(out), flags)


def validate_patterns(patterns: Sequence[str], kind: PatternKind) -> list[str]:
    """Normalise and validate; raises ``ValueError`` (Turkish) for an invalid regex."""
    cleaned: list[str] = []
    for p in patterns:
        p = p.strip()
        if not p:
            continue
        try:
            compile_pattern(p, kind)
        except re.error as e:
            raise ValueError(f"Geçersiz kalıp: {p} ({e})") from None
        cleaned.append(p)
    return cleaned


def matches_limited(cmd: ClassifiedCommand, patterns: Sequence[str], kind: PatternKind) -> bool:
    """True only if the command was fully parsed and EVERY non-read segment matches a pattern."""
    if not patterns or not cmd.parsed:
        return False
    writes = [s for s in cmd.segments if s.klass != "read"]
    if not writes:
        return cmd.klass == "read"
    compiled: list[re.Pattern[str]] = []
    for p in patterns:
        try:
            compiled.append(compile_pattern(p, kind))
        except re.error:
            continue
    return all(any(rx.fullmatch(seg.text.rstrip(";").strip()) for rx in compiled) for seg in writes)
