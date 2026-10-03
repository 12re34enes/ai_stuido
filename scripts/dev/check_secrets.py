#!/usr/bin/env python3
"""Fail if tracked files (or a commit range) contain secret-shaped literals.

GitHub push protection rejects pushes containing things that look like real credentials,
even fake test values. Build such values at runtime from parts instead.

    python3 scripts/dev/check_secrets.py                 # all tracked files
    python3 scripts/dev/check_secrets.py origin/main..HEAD   # only files changed in range
"""

from __future__ import annotations

import re
import subprocess
import sys

PATTERNS = {
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    "GitHub token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b"),
    "GitLab token": re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b"),
    "Slack token": re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}\b"),
    "Slack webhook": re.compile(r"https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+"),
    "Anthropic key": re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"),
    "OpenAI key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{32,}"),
    "Private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "JWT": re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    "Telegram bot token": re.compile(r"\b\d{8,10}:AA[A-Za-z0-9_\-]{33}\b"),
}
SKIP_SUFFIXES = (".png", ".jpg", ".icns", ".ico", ".woff2", ".lock", ".svg")


def files(rng: str | None) -> list[str]:
    cmd = ["git", "diff", "--name-only", "--diff-filter=AM", rng] if rng else ["git", "ls-files"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    return [f for f in out.splitlines() if f and not f.endswith(SKIP_SUFFIXES)]


def main() -> int:
    rng = sys.argv[1] if len(sys.argv) > 1 else None
    hits = 0
    for path in files(rng):
        try:
            text = open(path, encoding="utf-8", errors="ignore").read()
        except (FileNotFoundError, IsADirectoryError):
            continue
        for name, pat in PATTERNS.items():
            for m in pat.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                print(f"{path}:{line}: {name}: {m.group(0)[:24]}…")
                hits += 1
    if hits:
        print(f"\n{hits} secret-shaped literal(s) found. Build test values at runtime from parts.")
        return 1
    print("No secret-shaped literals found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
