"""PR/MR description templates read from the repo's local checkout (spec §13: "Başlık ve
açıklama, repo'daki şablona göre doldurulur").

GitHub looks for ``pull_request_template(.md|.txt)`` in ``.github/``, the root or ``docs/``
(case-insensitive), then the first file of a ``PULL_REQUEST_TEMPLATE/`` directory. GitLab uses
``.gitlab/merge_request_templates/Default.md`` (or the first template there).
"""

from __future__ import annotations

import re
from pathlib import Path

from aistudio.contracts.git_hosting import HostingKind

_MAX_TEMPLATE_BYTES = 64 * 1024
_GITHUB_DIRS = (".github", "", "docs")
_GITHUB_NAMES = ("pull_request_template.md", "pull_request_template.txt", "pull_request_template")
_GITHUB_MULTI_DIRS = (".github/pull_request_template", "pull_request_template", "docs/pull_request_template")
_GITLAB_DIR = ".gitlab/merge_request_templates"
_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_SUMMARY_HINTS = ("summary", "description", "what", "changes", "özet", "açıklama", "değişiklik", "context")


def _child_ci(directory: Path, name: str) -> Path | None:
    """Case-insensitive lookup of ``name`` (may contain slashes) under ``directory``."""
    current = directory
    for part in [p for p in name.split("/") if p]:
        if not current.is_dir():
            return None
        match = next((c for c in current.iterdir() if c.name.lower() == part.lower()), None)
        if match is None:
            return None
        current = match
    return current


def _read(path: Path) -> str | None:
    try:
        if not path.is_file():
            return None
        with path.open("rb") as fh:
            data = fh.read(_MAX_TEMPLATE_BYTES)
    except OSError:
        return None
    text = data.decode("utf-8", errors="replace").strip()
    return text or None


def _first_template_in(directory: Path | None, preferred: str | None = None) -> str | None:
    if directory is None or not directory.is_dir():
        return None
    files = sorted(
        (f for f in directory.iterdir() if f.is_file() and f.suffix.lower() in (".md", ".txt")),
        key=lambda f: f.name.lower(),
    )
    if preferred:
        for f in files:
            if f.name.lower() == preferred:
                return _read(f)
    return _read(files[0]) if files else None


def find_template(root: str | Path, kind: HostingKind) -> str | None:
    """Return the PR/MR template text of the checkout at ``root`` (blocking; use a thread)."""
    base = Path(root)
    if not base.is_dir():
        return None
    if kind == "gitlab":
        return _first_template_in(_child_ci(base, _GITLAB_DIR), preferred="default.md")
    for d in _GITHUB_DIRS:
        folder = _child_ci(base, d) if d else base
        if folder is None:
            continue
        for name in _GITHUB_NAMES:
            found = _child_ci(folder, name)
            if found is not None and found.is_file():
                text = _read(found)
                if text:
                    return text
    for d in _GITHUB_MULTI_DIRS:
        text = _first_template_in(_child_ci(base, d))
        if text:
            return text
    return None


def compose_body(template: str | None, body: str) -> str:
    """Fill the repo template with ``body``.

    * no template -> ``body``; empty body -> the template as is
    * body already follows the template (contains every heading) -> ``body``
    * otherwise ``body`` goes under the summary-like (or first) heading, replacing that section's
      comment-only placeholder; the rest of the template (checklists...) is kept.
    """
    body = body.strip()
    if not template:
        return body
    tpl = template.strip("\n")
    if not body:
        return tpl
    lines = tpl.splitlines()
    headings = [(i, m.group(2).strip()) for i, line in enumerate(lines) if (m := _HEADING.match(line))]
    if not headings:
        return f"{body}\n\n{tpl}"
    lowered = body.lower()
    if all(title.lower() in lowered for _, title in headings):
        return body
    target_pos = next(
        (pos for pos, (_, title) in enumerate(headings) if any(h in title.lower() for h in _SUMMARY_HINTS)), 0
    )
    start = headings[target_pos][0]
    end = headings[target_pos + 1][0] if target_pos + 1 < len(headings) else len(lines)
    section = "\n".join(lines[start + 1 : end])
    remaining = _COMMENT.sub("", section).strip()
    new_section = body if not remaining else f"{body}\n\n{remaining}"
    out = [*lines[: start + 1], "", new_section, "", *lines[end:]]
    return "\n".join(out).strip() + "\n"
