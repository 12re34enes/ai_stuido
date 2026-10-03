"""Instantiate-time input binding.

Prompt templates, ``*_template`` fields, condition ``expression`` and human ``instructions`` are
rendered by the engine at runtime (they need node outputs). Every *other* string field of a node
config (``command``, ``profile_id``, ``repo_ids``, ``review_focus``...) is not a template, so a
studio refers to inputs there with a plain ``{{ input.<name> }}`` placeholder that is substituted
here, once, with the resolved input value. User input is never re-rendered as Jinja.

Empty values: a list item bound to an empty value is dropped (a list that loses all its items
becomes ``None``, i.e. "default"); an optional field whose whole value is one empty binding
becomes ``None``.
"""

from __future__ import annotations

import re
from typing import Any

from aistudio.contracts.flows import FlowGraph, FlowNode
from aistudio.studios.validation import BINDING, is_template_field

_EXACT = re.compile(r"^\s*\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\s*$")


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _bind_str(text: str, values: dict[str, Any]) -> str:
    return BINDING.sub(lambda m: _stringify(values.get(m.group(1))), text)


_UNCHANGED = object()


def _bind_field(value: Any, values: dict[str, Any], *, required: bool) -> Any:
    if isinstance(value, str):
        if not BINDING.search(value):
            return _UNCHANGED
        bound = _bind_str(value, values)
        if not bound.strip() and _EXACT.match(value) and not required:
            return None
        return bound
    if isinstance(value, list) and any(isinstance(v, str) and BINDING.search(v) for v in value):
        out: list[Any] = []
        for item in value:
            if isinstance(item, str) and BINDING.search(item):
                bound = _bind_str(item, values).strip()
                if bound:
                    out.append(bound)
            else:
                out.append(item)
        return out if out or required else None
    return _UNCHANGED


def bind_node(node: FlowNode, values: dict[str, Any]) -> FlowNode:
    cfg = node.config
    updates: dict[str, Any] = {}
    for name, info in type(cfg).model_fields.items():
        if name == "kind" or is_template_field(name):
            continue
        new = _bind_field(getattr(cfg, name), values, required=info.is_required())
        if new is not _UNCHANGED:
            updates[name] = new
    if not updates:
        return node.model_copy(deep=True)
    new_cfg = type(cfg).model_validate({**cfg.model_dump(), **updates})
    return node.model_copy(update={"config": new_cfg}, deep=True)


def bind_inputs(graph: FlowGraph, values: dict[str, Any]) -> FlowGraph:
    """A copy of ``graph`` with non-template fields bound and ``inputs`` set to ``values``."""
    return graph.model_copy(
        update={"nodes": [bind_node(n, values) for n in graph.nodes], "inputs": dict(values)}, deep=True
    )
