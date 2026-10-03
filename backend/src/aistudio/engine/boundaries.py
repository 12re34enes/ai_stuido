"""Gitignore-style path matching for the boundary gate (spec §8, layer 3).

Rules follow ``.gitignore`` semantics: ``#`` comments, ``!`` negation (last match wins), a
leading ``/`` or an inner ``/`` anchors the pattern to the repo root, a trailing ``/`` matches
directories only, ``*`` and ``?`` never cross ``/``, ``**`` matches across directories, and a
pattern that matches a directory also matches everything below it.
"""

from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Literal

from pydantic import BaseModel

from aistudio.contracts.agents import Boundaries


@dataclass(frozen=True)
class _Rule:
    source: str
    negate: bool
    dir_only: bool
    regex: re.Pattern[str]


def _translate(body: str) -> str:
    out: list[str] = []
    i, n = 0, len(body)
    while i < n:
        c = body[i]
        if c == "*":
            if body.startswith("**", i):
                i += 2
                if i < n and body[i] == "/":
                    out.append("(?:.*/)?")
                    i += 1
                else:
                    out.append(".*")
                continue
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        elif c == "[":
            j = body.find("]", i + 1)
            if j == -1:
                out.append(re.escape(c))
            else:
                inner = body[i + 1 : j]
                if inner.startswith("!"):
                    inner = "^" + inner[1:]
                out.append(f"[{inner.replace('\\', '\\\\')}]")
                i = j
        elif c == "\\" and i + 1 < n:
            i += 1
            out.append(re.escape(body[i]))
        else:
            out.append(re.escape(c))
        i += 1
    return "".join(out)


@lru_cache(maxsize=2048)
def _compile(pattern: str) -> _Rule | None:
    raw = pattern.strip()
    if not raw or raw.startswith("#"):
        return None
    negate = raw.startswith("!")
    if negate:
        raw = raw[1:]
    dir_only = raw.endswith("/")
    raw = raw.rstrip("/")
    if not raw:
        return None
    anchored = raw.startswith("/") or "/" in raw
    raw = raw.lstrip("/")
    body = _translate(raw)
    prefix = "" if anchored else "(?:.*/)?"
    return _Rule(source=pattern, negate=negate, dir_only=dir_only, regex=re.compile(f"^{prefix}{body}$"))


def _candidates(path: str) -> tuple[list[str], str]:
    parts = [p for p in path.replace("\\", "/").split("/") if p and p != "."]
    parents = ["/".join(parts[:i]) for i in range(1, len(parts))]
    return parents, "/".join(parts)


def _rule_matches(rule: _Rule, path: str) -> bool:
    parents, full = _candidates(path)
    if any(rule.regex.match(p) for p in parents):
        return True
    return not rule.dir_only and bool(rule.regex.match(full))


def match_rule(patterns: list[str], path: str) -> str | None:
    """The pattern that decides ``path`` is matched (last match wins), or None."""
    decided: str | None = None
    for pattern in patterns:
        rule = _compile(pattern)
        if rule is None:
            continue
        if _rule_matches(rule, path):
            decided = None if rule.negate else rule.source
    return decided


def matches(patterns: list[str], path: str) -> bool:
    return match_rule(patterns, path) is not None


class Violation(BaseModel):
    path: str
    repo: str | None = None
    rule: str
    kind: Literal["forbidden", "readonly", "denied_command"]


def check_paths(changed: list[str], boundaries: Boundaries, *, repo: str | None = None) -> list[Violation]:
    """Changed (written) paths that hit a forbidden or read-only rule."""
    out: list[Violation] = []
    for path in changed:
        rule = match_rule(boundaries.forbidden_paths, path)
        if rule is not None:
            out.append(Violation(path=path, repo=repo, rule=rule, kind="forbidden"))
            continue
        rule = match_rule(boundaries.readonly_paths, path)
        if rule is not None:
            out.append(Violation(path=path, repo=repo, rule=rule, kind="readonly"))
    return out


def check_commands(commands: list[str], boundaries: Boundaries) -> list[Violation]:
    """Commands from the agent's command log that match a denied shell pattern (fnmatch)."""
    out: list[Violation] = []
    for command in commands:
        normalized = " ".join(command.split())
        for pattern in boundaries.denied_commands:
            pat = " ".join(pattern.split())
            if pat and (fnmatch.fnmatchcase(normalized, pat) or fnmatch.fnmatchcase(normalized, f"{pat} *")):
                out.append(Violation(path=normalized, rule=pattern, kind="denied_command"))
                break
    return out
