"""Tolerant parsing of ``boundaries.md`` front matter into :class:`Boundaries`.

A typo in one field must never disable every boundary: each field is validated on its own,
invalid ones are dropped (with a Turkish warning) and the rest still apply. Unreadable YAML
yields empty ``Boundaries`` plus a warning; the service turns warnings into an event.
"""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from aistudio.contracts.agents import Boundaries, SandboxLevel
from aistudio.memory.markdown import split_front_matter

_LIST_FIELDS = ("forbidden_paths", "readonly_paths", "allowed_commands", "denied_commands")

SANDBOX_LABELS: dict[SandboxLevel, str] = {
    SandboxLevel.read_only: "salt okuma",
    SandboxLevel.workspace_write: "yalnız çalışma alanına yazma",
    SandboxLevel.full: "tam yetki",
}
REMOTE_LABELS: dict[str, str] = {
    "none": "yok",
    "read": "salt okuma",
    "limited": "sınırlı yazma",
    "full": "tam yetki",
}


def _coerce_list(value: Any) -> list[str] | None:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list | tuple):
        return None
    return [str(v).strip() for v in value if v is not None and str(v).strip()]


def parse_boundaries(text: str) -> tuple[Boundaries, list[str]]:
    """Return ``(boundaries, warnings)``. Never raises."""
    fm = split_front_matter(text)
    if fm.error:
        return Boundaries(), [fm.error]
    if fm.data is None:
        return Boundaries(), []
    values: dict[str, Any] = {}
    warnings: list[str] = []
    for key, raw in fm.data.items():
        if key not in Boundaries.model_fields:
            warnings.append(f"Bilinmeyen alan yok sayıldı: {key}")
            continue
        if raw is None:
            continue
        candidate: Any = raw
        if key in _LIST_FIELDS:
            candidate = _coerce_list(raw)
            if candidate is None:
                warnings.append(f"`{key}` bir liste olmalı; yok sayıldı.")
                continue
        try:
            values[key] = getattr(Boundaries.model_validate({key: candidate}), key)
        except ValidationError:
            warnings.append(f"`{key}` için geçersiz değer yok sayıldı: {raw!r}")
    return Boundaries(**values), warnings


def summarize_boundaries(b: Boundaries) -> list[str]:
    """Turkish bullet lines describing ``b`` (for the agent system prompt)."""
    lines: list[str] = []

    def paths(label: str, items: list[str]) -> None:
        if items:
            lines.append(f"- {label}: " + ", ".join(f"`{i}`" for i in items))

    paths("Dokunulmayacak yollar (okuma ve yazma yasak)", b.forbidden_paths)
    paths("Salt okunur yollar", b.readonly_paths)
    paths("Sormadan çalıştırılabilen komutlar", b.allowed_commands)
    paths("Yasak komutlar", b.denied_commands)
    lines.append(f"- Ağ erişimi: {'açık' if b.network else 'kapalı'}")
    lines.append(f"- Sandbox: {SANDBOX_LABELS.get(b.sandbox, b.sandbox.value)}")
    lines.append(f"- Uzak sunucu erişimi: {REMOTE_LABELS.get(b.remote_access, b.remote_access)}")
    return lines
