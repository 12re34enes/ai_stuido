"""Built-in studio templates shipped as package data (``aistudio/studios/builtin/*.yaml``)."""

from __future__ import annotations

from importlib import resources

import yaml

from aistudio.contracts.studios import Studio

# Display order of the eight built-in studios (spec §16).
BUILTIN_ORDER: tuple[str, ...] = (
    "architecture",
    "market-analysis",
    "design",
    "database",
    "code-review",
    "debugging",
    "documentation",
    "proposal",
)


def builtin_files() -> list[tuple[str, str]]:
    """``[(file name, YAML text)]`` of every built-in template."""
    root = resources.files("aistudio.studios").joinpath("builtin")
    out: list[tuple[str, str]] = []
    for entry in root.iterdir():
        if entry.name.endswith((".yaml", ".yml")) and entry.is_file():
            out.append((entry.name, entry.read_text(encoding="utf-8")))
    return sorted(out)


def parse_studio(text: str, *, source: str = "<yaml>") -> Studio:
    data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError(f"{source}: studio YAML must be a mapping")
    return Studio.model_validate(data)


def load_builtin_studios() -> dict[str, Studio]:
    """Parse and validate every built-in template (raises on a broken file: it is a packaging bug)."""
    studios: dict[str, Studio] = {}
    for name, text in builtin_files():
        studio = parse_studio(text, source=name).model_copy(update={"builtin": True, "version": 1})
        if studio.id in studios:
            raise ValueError(f"duplicate built-in studio id {studio.id!r} ({name})")
        studios[studio.id] = studio
    order = {sid: i for i, sid in enumerate(BUILTIN_ORDER)}
    return dict(sorted(studios.items(), key=lambda kv: (order.get(kv[0], len(order)), kv[0])))
