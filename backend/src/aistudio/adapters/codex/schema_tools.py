"""Helpers for the committed (pruned) app-server JSON schema.

``codex app-server generate-json-schema --experimental --out DIR`` writes a ~850 KB bundle
(``codex_app_server_protocol.schemas.json``). We commit only the part we use: the method unions
filtered to the methods in ``protocol.py`` plus every definition reachable from them and from
the response types. ``scripts/verify/codex/update_schema.py`` regenerates it; the drift test and
the Mac verification script compare against it.
"""

from __future__ import annotations

import json
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

from aistudio.adapters.codex import protocol as p

SCHEMA_DIR = Path(__file__).parent / "schema"
SCHEMA_FILE = SCHEMA_DIR / "codex_app_server_protocol.subset.json"
BUNDLE_FILE_NAME = "codex_app_server_protocol.schemas.json"
ENVELOPE_DEFS = ("JSONRPCMessage", "JSONRPCRequest", "JSONRPCNotification", "JSONRPCResponse", "JSONRPCError")

_REF = re.compile(r"^#/definitions/(?:(v2)/)?([^/]+)$")


def load_committed() -> dict[str, Any]:
    return json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))


def find_def(bundle: dict[str, Any], name: str) -> dict[str, Any] | None:
    defs = bundle.get("definitions", {})
    v2 = defs.get("v2", {})
    found = v2.get(name) if isinstance(v2, dict) else None
    if found is None:
        found = defs.get(name)
    return found if isinstance(found, dict) else None


def resolve_ref(bundle: dict[str, Any], ref: str) -> dict[str, Any] | None:
    m = _REF.match(ref)
    if not m:
        return None
    ns, name = m.groups()
    defs = bundle.get("definitions", {})
    target = defs.get("v2", {}).get(name) if ns else defs.get(name)
    return target if isinstance(target, dict) else None


def union_variants(bundle: dict[str, Any], union: str) -> dict[str, dict[str, Any]]:
    """Method name -> variant object of a method union (ClientRequest, ServerNotification, ...)."""
    d = find_def(bundle, union) or {}
    out: dict[str, dict[str, Any]] = {}
    for variant in d.get("oneOf", []):
        enum = variant.get("properties", {}).get("method", {}).get("enum") or []
        if enum:
            out[enum[0]] = variant
    return out


def params_def_name(variant: dict[str, Any]) -> str | None:
    """Definition name referenced by a union variant's ``params`` (unwrapping ``X | null``)."""
    params = variant.get("properties", {}).get("params")
    if not isinstance(params, dict):
        return None
    candidates = [params, *params.get("anyOf", [])]
    for c in candidates:
        ref = c.get("$ref") if isinstance(c, dict) else None
        if ref:
            return ref.rsplit("/", 1)[-1]
    return None


def used_methods() -> dict[str, list[str]]:
    return {
        "client_requests": sorted(p.CLIENT_REQUESTS),
        "client_notifications": sorted(p.CLIENT_NOTIFICATIONS),
        "server_requests": sorted(p.SERVER_REQUESTS),
        "server_notifications": sorted(p.SERVER_NOTIFICATIONS),
    }


def _result_def_names() -> list[str]:
    names: set[str] = set()
    for table in (p.CLIENT_REQUESTS, p.SERVER_REQUESTS):
        for spec in table.values():
            for model in (spec.params, spec.result):
                if model is not None and model.schema_name:
                    names.add(model.schema_name)
    for spec in p.SERVER_NOTIFICATIONS.values():
        if spec.params is not None:
            names.add(spec.params.schema_name)
    return sorted(names)


def prune_bundle(bundle: dict[str, Any], *, codex_version: str) -> dict[str, Any]:
    """Reduce a full experimental schema bundle to what this adapter uses."""
    defs = bundle["definitions"]
    out_defs: dict[str, Any] = {"v2": {}}
    methods = used_methods()
    all_methods: dict[str, list[str]] = {}
    missing: list[str] = []

    for key, union in p.UNION_FOR_TABLE.items():
        variants = union_variants(bundle, union)
        all_methods[key] = sorted(variants)
        src = find_def(bundle, union)
        if src is None:
            raise ValueError(f"schema has no {union} union")
        pruned = deepcopy(src)
        keep = set(methods[key])
        missing += [f"{union}:{m}" for m in sorted(keep - set(variants))]
        pruned["oneOf"] = [
            v
            for v in src.get("oneOf", [])
            if (v.get("properties", {}).get("method", {}).get("enum") or [None])[0] in keep
        ]
        _put(out_defs, defs, union, pruned)

    for name in [*ENVELOPE_DEFS, *_result_def_names()]:
        src = find_def(bundle, name)
        if src is None:
            missing.append(name)
            continue
        _put(out_defs, defs, name, deepcopy(src))
    if missing:
        raise ValueError("schema is missing methods/definitions used by the adapter: " + ", ".join(missing))

    # transitive closure over $ref
    queue = [json.dumps(v) for v in [*out_defs["v2"].values(), *(v for k, v in out_defs.items() if k != "v2")]]
    seen: set[str] = set()
    while queue:
        text = queue.pop()
        for ref in re.findall(r'"\$ref": "([^"]+)"', text):
            if ref in seen:
                continue
            seen.add(ref)
            m = _REF.match(ref)
            if not m:
                continue
            ns, name = m.groups()
            target = (defs.get("v2", {}) if ns else defs).get(name)
            if target is None:
                continue
            bucket = out_defs["v2"] if ns else out_defs
            if name not in bucket:
                bucket[name] = deepcopy(target)
                queue.append(json.dumps(target))

    return {
        "$schema": bundle.get("$schema", "http://json-schema.org/draft-07/schema#"),
        "title": "CodexAppServerProtocolSubset",
        "x-aistudio": {
            "codexVersion": codex_version,
            "generatedWith": "codex app-server generate-json-schema --experimental",
            "prunedBy": "scripts/verify/codex/update_schema.py",
            "usedMethods": methods,
            "allMethods": all_methods,
        },
        "definitions": out_defs,
    }


def _put(out_defs: dict[str, Any], defs: dict[str, Any], name: str, value: dict[str, Any]) -> None:
    if name in defs.get("v2", {}):
        out_defs["v2"][name] = value
    else:
        out_defs[name] = value


def dumps(schema: dict[str, Any]) -> str:
    return json.dumps(schema, indent=1, sort_keys=True, ensure_ascii=False) + "\n"


def compare_used(committed: dict[str, Any], fresh: dict[str, Any]) -> list[str]:
    """Human-readable differences between two pruned schemas (empty = compatible)."""
    diffs: list[str] = []
    a, b = committed.get("definitions", {}), fresh.get("definitions", {})
    for ns_a, ns_b, prefix in ((a, b, ""), (a.get("v2", {}), b.get("v2", {}), "v2/")):
        for name in sorted(set(ns_a) | set(ns_b)):
            if name == "v2":
                continue
            if name not in ns_b:
                diffs.append(f"removed: {prefix}{name}")
            elif name not in ns_a:
                diffs.append(f"added: {prefix}{name}")
            elif json.dumps(ns_a[name], sort_keys=True) != json.dumps(ns_b[name], sort_keys=True):
                diffs.append(f"changed: {prefix}{name}")
    return diffs
