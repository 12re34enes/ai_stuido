"""Secret masking.

Everything that leaves a process boundary (event payloads, logs, alerts, exports,
remote command output) passes through :class:`Masker` before it is stored or sent.
Raw secrets are never persisted.

Three layers, applied in order:
1. Exact known values: every secret the app reads from or writes to the Keychain is
   registered here, so it is masked wherever it appears.
2. Patterns: well-known token formats and ``key=value`` assignments with secret-ish keys.
3. Entropy: long, high-entropy tokens that look like random credentials.
"""

from __future__ import annotations

import math
import re
import threading
from collections import Counter
from typing import Any

MASK = "[gizli]"
_MIN_KNOWN_LEN = 6

_TOKEN_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----"),
    re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b"),
    re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b"),
    re.compile(r"\bgl(?:ptt|dt|rt|cbt|imt|agent)-[A-Za-z0-9_\-]{20,}\b"),
    re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}\b"),
    re.compile(r"\bxapp-\d-[A-Za-z0-9\-]{10,}\b"),
    re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b"),  # Telegram bot token
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
    re.compile(r"\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b"),  # JWT
    re.compile(r"https://hooks\.slack\.com/services/[A-Za-z0-9/]+"),
    re.compile(r"https://discord(?:app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_\-]+"),
]

# scheme://user:password@host  -> mask only the password
_URL_CREDENTIALS = re.compile(r"(?P<pre>\b[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s:/@]+:)(?P<secret>[^\s@/]+)(?P<post>@)")

# password = "..." / TOKEN: ... / --password=...  -> mask only the value
_ASSIGNMENT = re.compile(
    r"(?P<pre>(?i:\b[\w.\-]*(?:password|passwd|pwd|secret|token|api[_\-]?key|apikey|access[_\-]?key|"
    r"private[_\-]?key|client[_\-]?secret|auth)[\w.\-]*\b)\s*(?:=|:|\s)\s*['\"]?)"
    r"(?P<secret>[^\s'\"&,;]{6,})"
)

_ENTROPY_CANDIDATE = re.compile(r"[A-Za-z0-9+/=_\-]{40,}")
_HEX_ONLY = re.compile(r"^[0-9a-fA-F]+$")


def _shannon_entropy(s: str) -> float:
    counts = Counter(s)
    n = len(s)
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _looks_random(token: str) -> bool:
    if _HEX_ONLY.match(token):  # git SHAs, digests
        return False
    if "/" in token and token.count("/") > 2:  # paths
        return False
    has_upper = any(c.isupper() for c in token)
    has_lower = any(c.islower() for c in token)
    digits = sum(c.isdigit() for c in token)
    if not (has_upper and has_lower and digits >= 2):
        return False
    # Random base62 tokens of 40+ chars land around 4.4-5.1 bits/char; prose-like
    # identifiers stay well below 4.0.
    return _shannon_entropy(token) >= 4.2


class Masker:
    def __init__(self) -> None:
        self._known: set[str] = set()
        self._known_re: re.Pattern[str] | None = None
        self._lock = threading.Lock()

    def add_secret(self, value: str | None) -> None:
        if not value or len(value) < _MIN_KNOWN_LEN:
            return
        with self._lock:
            if value in self._known:
                return
            self._known.add(value)
            alternatives = sorted(self._known, key=len, reverse=True)
            self._known_re = re.compile("|".join(re.escape(v) for v in alternatives))

    def remove_secret(self, value: str) -> None:
        with self._lock:
            self._known.discard(value)
            alternatives = sorted(self._known, key=len, reverse=True)
            self._known_re = re.compile("|".join(re.escape(v) for v in alternatives)) if alternatives else None

    def mask(self, text: str) -> str:
        if not text:
            return text
        known_re = self._known_re
        if known_re is not None:
            text = known_re.sub(MASK, text)
        for pattern in _TOKEN_PATTERNS:
            text = pattern.sub(MASK, text)
        text = _URL_CREDENTIALS.sub(lambda m: f"{m['pre']}{MASK}{m['post']}", text)
        text = _ASSIGNMENT.sub(lambda m: m.group(0) if m["secret"] == MASK else f"{m['pre']}{MASK}", text)
        return _ENTROPY_CANDIDATE.sub(lambda m: MASK if _looks_random(m.group(0)) else m.group(0), text)

    def mask_obj(self, obj: Any) -> Any:
        """Recursively mask every string inside dicts/lists/tuples. Keys are left untouched."""
        if isinstance(obj, str):
            return self.mask(obj)
        if isinstance(obj, dict):
            return {k: self.mask_obj(v) for k, v in obj.items()}
        if isinstance(obj, list | tuple):
            return [self.mask_obj(v) for v in obj]
        return obj
