"""Tiny JSON Schema (draft-07 subset) validator for the committed app-server schema.

Covers what the generated schema uses: ``$ref``, ``type``, ``enum``, ``required``, ``properties``,
``additionalProperties``, ``items``, ``anyOf`` / ``oneOf`` / ``allOf``. Formats are ignored.
"""

from __future__ import annotations

from typing import Any

from aistudio.adapters.codex import schema_tools

_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "number": lambda v: isinstance(v, int | float) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
    "null": lambda v: v is None,
}


def validate(root: dict[str, Any], node: Any, value: Any, path: str = "$") -> list[str]:
    if node is True or node == {}:
        return []
    if node is False:
        return [f"{path}: no value allowed"]
    if not isinstance(node, dict):
        return []
    if "$ref" in node:
        target = schema_tools.resolve_ref(root, node["$ref"])
        if target is None:
            return [f"{path}: unresolvable $ref {node['$ref']}"]
        return validate(root, target, value, path)
    errors: list[str] = []
    for sub in node.get("allOf", []):
        errors += validate(root, sub, value, path)
    for key in ("anyOf", "oneOf"):
        if key in node:
            branch_errors = [validate(root, sub, value, path) for sub in node[key]]
            if all(branch_errors):
                best = min(branch_errors, key=len)
                errors.append(f"{path}: matches no {key} branch (closest: {best[:2]})")
    if "enum" in node and value not in node["enum"]:
        errors.append(f"{path}: {value!r} not in {node['enum']}")
    if "const" in node and value != node["const"]:
        errors.append(f"{path}: {value!r} != {node['const']!r}")
    kind = node.get("type")
    if kind is not None:
        kinds = kind if isinstance(kind, list) else [kind]
        if not any(_TYPES[k](value) for k in kinds if k in _TYPES):
            return [*errors, f"{path}: expected {kinds}, got {type(value).__name__}"]
    if isinstance(value, dict):
        props = node.get("properties", {})
        for req in node.get("required", []):
            if req not in value:
                errors.append(f"{path}: missing required {req!r}")
        extra = node.get("additionalProperties", True)
        for k, v in value.items():
            if k in props:
                errors += validate(root, props[k], v, f"{path}.{k}")
            elif extra is False:
                errors.append(f"{path}: unexpected property {k!r}")
            elif isinstance(extra, dict):
                errors += validate(root, extra, v, f"{path}.{k}")
    if isinstance(value, list) and "items" in node and isinstance(node["items"], dict | bool):
        for i, v in enumerate(value):
            errors += validate(root, node["items"], v, f"{path}[{i}]")
    return errors


def validate_def(root: dict[str, Any], name: str, value: Any) -> list[str]:
    node = schema_tools.find_def(root, name)
    if node is None:
        return [f"no definition {name}"]
    return validate(root, node, value, name)


def validate_message(root: dict[str, Any], union: str, msg: dict[str, Any]) -> list[str]:
    """Validate a whole JSON-RPC message against its method's variant in a method union."""
    variant = schema_tools.union_variants(root, union).get(str(msg.get("method")))
    if variant is None:
        return [f"{union}: method {msg.get('method')!r} not in committed schema"]
    return validate(root, variant, msg, f"{union}:{msg.get('method')}")
