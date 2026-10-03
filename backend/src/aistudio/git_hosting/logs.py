"""CI log clean-up: strip ANSI/GitLab section markers and GitHub timestamps, keep the tail."""

from __future__ import annotations

import re

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")
_GITLAB_SECTION = re.compile(r"section_(?:start|end):\d+:[A-Za-z0-9_\-.]+(?:\[[^\]]*\])?\r?")
_GITHUB_TS = re.compile(r"^﻿?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ", re.M)
TRUNCATED_HEAD = "… [logun başı kısaltıldı]\n"


def clean_log(text: str) -> str:
    text = _ANSI.sub("", text)
    text = _GITLAB_SECTION.sub("", text)
    text = _GITHUB_TS.sub("", text)
    text = text.replace("\r\n", "\n")
    # Progress bars rewrite the same line with \r; keep the final state of each line.
    text = "\n".join(line.rsplit("\r", 1)[-1] for line in text.split("\n"))
    return text.strip("\n")


def tail(text: str, limit: int) -> str:
    """Keep the last ``limit`` characters (errors are at the end of CI logs), on a line boundary."""
    if limit <= 0 or len(text) <= limit:
        return text
    budget = max(0, limit - len(TRUNCATED_HEAD))
    cut = text[-budget:] if budget else ""
    newline = cut.find("\n")
    if 0 <= newline < len(cut) // 4:
        cut = cut[newline + 1 :]
    return TRUNCATED_HEAD + cut
