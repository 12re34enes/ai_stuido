"""Small Markdown helpers for memory documents (front matter, headings, compaction)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import yaml

_FRONT_MATTER = re.compile(r"\A---[ \t]*\r?\n(?P<yaml>.*?)(?:\r?\n)?^---[ \t]*(?:\r?\n|\Z)", re.DOTALL | re.MULTILINE)
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_HEADING = re.compile(r"^(?P<hashes>#{1,6})[ \t]+(?P<text>.+?)[ \t]*#*[ \t]*$")
_BLANK_RUNS = re.compile(r"\n{3,}")


@dataclass(frozen=True)
class FrontMatter:
    data: dict[str, Any] | None  # None = no front matter block
    body: str
    error: str | None = None  # Turkish, user-facing


def split_front_matter(text: str) -> FrontMatter:
    """Split a ``---`` YAML block off the top of ``text``. Invalid YAML yields ``error``."""
    m = _FRONT_MATTER.match(text)
    if m is None:
        return FrontMatter(None, text)
    body = text[m.end() :]
    try:
        data = yaml.safe_load(m.group("yaml"))
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f" (satır {mark.line + 2})" if mark is not None else ""
        return FrontMatter(None, body, f"Ön bilgi bölümündeki YAML okunamadı{where}.")
    if data is None:
        return FrontMatter({}, body)
    if not isinstance(data, dict):
        return FrontMatter(None, body, "Ön bilgi bölümü anahtar: değer biçiminde olmalı.")
    return FrontMatter({str(k): v for k, v in data.items()}, body)


def strip_comments(text: str) -> str:
    return _COMMENT.sub("", text)


def first_heading(text: str) -> str | None:
    for line in strip_comments(text).splitlines():
        m = _HEADING.match(line.strip())
        if m:
            return m.group("text").strip()
    return None


def first_paragraph_line(text: str, *, after_heading: str | None = None) -> str | None:
    """First prose line (not a heading, list marker only, table or rule). With ``after_heading``,
    start searching below the first heading whose text equals it (case-insensitive)."""
    lines = strip_comments(text).splitlines()
    start = 0
    if after_heading is not None:
        wanted = after_heading.casefold()
        for i, line in enumerate(lines):
            m = _HEADING.match(line.strip())
            if m and m.group("text").strip().casefold() == wanted:
                start = i + 1
                break
        else:
            return None
    for line in lines[start:]:
        s = line.strip()
        if not s:
            continue
        if _HEADING.match(s):
            if after_heading is not None:
                return None  # section ended without prose
            continue
        if s.startswith(("|", "```", "---", "===", ">")):
            continue
        s = re.sub(r"^([-*+]|\d+[.)])\s+", "", s).strip()
        if s:
            return s
    return None


def compact(text: str, *, shift_headings: int = 0, drop_h1: bool = True) -> str:
    """Make a document prompt-friendly: drop HTML comments, the top-level title, headings that
    have no content under them, and runs of blank lines. Optionally demote headings."""
    lines = strip_comments(text).splitlines()
    out: list[str] = []
    headings: list[tuple[int, int]] = []  # (index in out, level)
    for line in lines:
        m = _HEADING.match(line.strip())
        if m:
            level = len(m.group("hashes"))
            if drop_h1 and level == 1:
                continue
            new_level = min(6, level + shift_headings)
            out.append("#" * new_level + " " + m.group("text").strip())
            headings.append((len(out) - 1, level))
        else:
            out.append(line.rstrip())
    # Remove headings whose section (until the next heading of the same or higher level) is empty.
    keep = [True] * len(out)
    for pos, (idx, level) in enumerate(headings):
        end = len(out)
        for nidx, nlevel in headings[pos + 1 :]:
            if nlevel <= level:
                end = nidx
                break
        has_content = any(out[j].strip() and not _HEADING.match(out[j].strip()) for j in range(idx + 1, end))
        if not has_content:
            keep[idx] = False
    result = "\n".join(line for line, k in zip(out, keep, strict=True) if k)
    return _BLANK_RUNS.sub("\n\n", result).strip()


def truncate_lines(text: str, limit: int, *, marker: str) -> str:
    """Cut ``text`` to at most ``limit`` chars at a line boundary and append ``marker``."""
    if len(text) <= limit:
        return text
    room = limit - len(marker) - 1
    if room <= 0:
        return marker.strip()[:limit] if limit > 0 else ""
    cut = text.rfind("\n", 0, room)
    if cut < room // 2:  # no reasonable line boundary: hard cut
        cut = room
    return text[:cut].rstrip() + "\n" + marker


def one_line(text: str, limit: int) -> str:
    s = " ".join(text.split())
    if len(s) <= limit:
        return s
    return s[: max(0, limit - 1)].rstrip() + "…"
