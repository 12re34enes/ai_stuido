"""Small text helpers (Turkish-aware)."""

from __future__ import annotations

import re
import unicodedata

_TR_MAP = str.maketrans(
    {
        "ç": "c",
        "Ç": "c",
        "ğ": "g",
        "Ğ": "g",
        "ı": "i",
        "İ": "i",
        "ö": "o",
        "Ö": "o",
        "ş": "s",
        "Ş": "s",
        "ü": "u",
        "Ü": "u",
    }
)


def slugify(text: str, *, max_len: int = 48, fallback: str = "x") -> str:
    text = text.translate(_TR_MAP)
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return (text[:max_len].rstrip("-")) or fallback


def truncate(text: str, limit: int, *, marker: str = "\n… [kısaltıldı]") -> str:
    if len(text) <= limit:
        return text
    return text[: max(0, limit - len(marker))] + marker
