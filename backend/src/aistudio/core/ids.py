"""Time-ordered, prefixed identifiers (ULID layout, Crockford base32).

``new_id("ws")`` -> ``"ws_01JABCDE..."``. The prefix makes ids self-describing in logs
and URLs; the ULID body sorts lexicographically by creation time.
"""

from __future__ import annotations

import os
import time

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _encode(value: int, length: int) -> str:
    out = []
    for _ in range(length):
        out.append(_ALPHABET[value & 31])
        value >>= 5
    return "".join(reversed(out))


def ulid() -> str:
    """Return a 26 character ULID string."""
    ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    return _encode(ms, 10) + _encode(rand, 16)


def new_id(prefix: str) -> str:
    if not prefix or not prefix.isalnum() or not prefix.islower():
        raise ValueError(f"id prefix must be short lowercase alphanumeric, got {prefix!r}")
    return f"{prefix}_{ulid()}"
