"""Protocol drift checks: our models vs the committed (pruned) app-server schema, and every
fixture (recorded real traffic and fake scenarios) vs that schema."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from aistudio.adapters.codex import protocol as p
from aistudio.adapters.codex import schema_tools
from aistudio.adapters.codex.session import CodexSession

from .conftest import FIXTURES, SCENARIOS
from .schema_check import validate_def, validate_message

SCHEMA = schema_tools.load_committed()


def _model_classes() -> list[type[p.InModel] | type[p.OutModel]]:
    out: list[Any] = []
    for obj in vars(p).values():
        if isinstance(obj, type) and issubclass(obj, p.InModel | p.OutModel) and obj.schema_name:
            out.append(obj)
    return out


def _object_view(model: type[Any]) -> tuple[dict[str, Any], set[str]]:
    node = schema_tools.find_def(SCHEMA, model.schema_name)
    assert node is not None, f"{model.__name__}: no schema definition {model.schema_name}"
    while "$ref" in node:
        node = schema_tools.resolve_ref(SCHEMA, node["$ref"]) or {}
    variants = node.get("oneOf") or node.get("anyOf") or []
    if model.schema_variant:
        for v in variants:
            enum = v.get("properties", {}).get("type", {}).get("enum") or []
            if enum == [model.schema_variant]:
                return v.get("properties", {}), set(v.get("required", []))
        raise AssertionError(f"{model.__name__}: variant {model.schema_variant!r} not in {model.schema_name}")
    if "properties" in node or not variants:
        return node.get("properties", {}), set(node.get("required", []))
    props: dict[str, Any] = {}
    required: set[str] | None = None
    for v in variants:
        props.update(v.get("properties", {}))
        req = set(v.get("required", []))
        required = req if required is None else required & req
    return props, required or set()


def test_committed_schema_is_pinned_and_lists_used_methods() -> None:
    meta = SCHEMA["x-aistudio"]
    assert meta["codexVersion"] == p.CODEX_SCHEMA_VERSION
    assert meta["usedMethods"] == schema_tools.used_methods(), (
        "protocol tables changed: run scripts/verify/codex/update_schema.py"
    )


@pytest.mark.parametrize(
    ("table", "union"),
    [
        (p.CLIENT_REQUESTS, "ClientRequest"),
        (p.SERVER_REQUESTS, "ServerRequest"),
        (p.SERVER_NOTIFICATIONS, "ServerNotification"),
    ],
)
def test_method_names_and_params_types_match_schema(table: dict[str, p.MethodSpec], union: str) -> None:
    variants = schema_tools.union_variants(SCHEMA, union)
    for method, spec in table.items():
        assert method in variants, f"{union} has no method {method}"
        if spec.params is not None:
            assert schema_tools.params_def_name(variants[method]) == spec.params.schema_name, method
        if spec.result is not None:
            assert schema_tools.find_def(SCHEMA, spec.result.schema_name) is not None, method
    assert set(schema_tools.union_variants(SCHEMA, "ClientNotification")) >= set(p.CLIENT_NOTIFICATIONS)


@pytest.mark.parametrize("model", _model_classes(), ids=lambda m: m.__name__)
def test_model_fields_match_schema(model: type[Any]) -> None:
    props, required = _object_view(model)
    aliases: dict[str, bool] = {}
    for name, field in model.model_fields.items():
        alias = field.alias or name
        aliases[alias] = field.is_required()
        assert alias in props, f"{model.__name__}.{name}: {alias!r} not in schema {model.schema_name}"
        if field.is_required():
            assert alias in required, f"{model.__name__}.{alias} is required here but optional in the schema"
    if model.outgoing:
        missing = required - set(aliases)
        assert not missing, f"{model.__name__} lacks fields the server requires: {sorted(missing)}"


def test_validator_catches_protocol_errors() -> None:
    bad = {"id": 1, "method": "turn/steer", "params": {"threadId": "t", "input": [{"type": "text"}]}}
    errors = validate_message(SCHEMA, "ClientRequest", bad)
    assert any("expectedTurnId" in e for e in errors)
    assert validate_message(SCHEMA, "ClientRequest", {"id": 1, "method": "nope/x", "params": {}})
    assert validate_def(SCHEMA, "RateLimitWindow", {"usedPercent": "high"})
    assert validate_def(SCHEMA, "ThreadItem", {"type": "commandExecution", "id": "x"})


def test_every_server_request_and_notification_has_a_handler() -> None:
    for method in p.SERVER_REQUESTS:
        assert hasattr(CodexSession, "_r_" + method.replace("/", "_")), method
    for method in p.SERVER_NOTIFICATIONS:
        if method != "thread/started":
            assert hasattr(CodexSession, "_n_" + method.replace("/", "_")), method


def test_prune_is_stable() -> None:
    """Pruning the committed subset again (as if it were a full bundle) keeps every used definition."""
    again = schema_tools.prune_bundle(SCHEMA, codex_version=p.CODEX_SCHEMA_VERSION)
    assert schema_tools.compare_used(SCHEMA, again) == []


def test_prune_reports_missing_methods() -> None:
    broken = json.loads(json.dumps(SCHEMA))
    union = broken["definitions"]["ClientRequest"]
    union["oneOf"] = [v for v in union["oneOf"] if v["properties"]["method"]["enum"] != ["turn/steer"]]
    with pytest.raises(ValueError, match="turn/steer"):
        schema_tools.prune_bundle(broken, codex_version="9.9.9")


# --------------------------------------------------------------------------- recorded real traffic


def _recorded(name: str) -> list[dict[str, Any]]:
    path = FIXTURES / "recorded" / name
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


@pytest.mark.parametrize("name", ["lifecycle_unauthenticated.jsonl", "resume_fork_unauthenticated.jsonl"])
def test_recorded_real_traffic_matches_schema_and_models(name: str) -> None:
    sent_methods: dict[Any, str] = {}
    checked = 0
    for entry in _recorded(name):
        msg = entry["msg"]
        if entry["dir"] == "send":
            if "id" in msg:
                sent_methods[msg["id"]] = msg["method"]
                assert validate_message(SCHEMA, "ClientRequest", msg) == []
            else:
                assert validate_message(SCHEMA, "ClientNotification", msg) == []
            checked += 1
        elif entry["dir"] == "recv":
            assert "jsonrpc" not in msg  # codex omits the member
            if "method" in msg and msg["method"] in p.SERVER_NOTIFICATIONS:
                assert validate_message(SCHEMA, "ServerNotification", msg) == []
                spec = p.SERVER_NOTIFICATIONS[msg["method"]]
                assert spec.params is not None
                spec.params.model_validate(msg["params"])
                checked += 1
            elif "result" in msg:
                spec = p.CLIENT_REQUESTS[sent_methods[msg["id"]]]
                if spec.result is not None:
                    assert validate_def(SCHEMA, spec.result.schema_name, msg["result"]) == []
                    spec.result.model_validate(msg["result"])
                    checked += 1
    assert checked >= 10


# --------------------------------------------------------------------------- fake scenarios

_DUMMY = {"$THREAD": "thr", "$TURN": "turn", "$CWD": "/w", "$TOOL_TEXT": "x", "$TOOL_SUCCESS": True}
_APPROVAL_METHODS = {
    "command": "item/commandExecution/requestApproval",
    "fileChange": "item/fileChange/requestApproval",
    "permissions": "item/permissions/requestApproval",
}


def _subst(value: Any) -> Any:
    if isinstance(value, str):
        if value in _DUMMY:
            return _DUMMY[value]
        for k, v in _DUMMY.items():
            if isinstance(v, str):
                value = value.replace(k, v)
        return value
    if isinstance(value, list):
        return [_subst(v) for v in value]
    if isinstance(value, dict):
        return {k: _subst(v) for k, v in value.items()}
    return value


def _check_steps(steps: list[dict[str, Any]], errors: list[str]) -> None:
    for raw in steps:
        if raw.get("invalid"):
            continue
        step = _subst(raw)
        if "notify" in step:
            if step["notify"] not in p.SERVER_NOTIFICATIONS:
                continue  # outside the subset we model (ignored by the adapter)
            errors += validate_message(
                SCHEMA, "ServerNotification", {"method": step["notify"], "params": step["params"]}
            )
        elif "item" in step:
            errors += validate_def(SCHEMA, "ThreadItem", step["item"])
        elif "approval" in step or "approvalResolved" in step:
            method = _APPROVAL_METHODS[step.get("approval") or step["approvalResolved"]]
            errors += validate_message(SCHEMA, "ServerRequest", {"id": 0, "method": method, "params": step["params"]})
            _check_steps(step.get("accept", []), errors)
            _check_steps(step.get("decline", []), errors)
        elif "toolCall" in step:
            call = step["toolCall"]
            params = {
                "threadId": "thr",
                "turnId": "turn",
                "callId": call["callId"],
                "namespace": call.get("namespace"),
                "tool": call["tool"],
                "arguments": call.get("arguments", {}),
            }
            errors += validate_message(SCHEMA, "ServerRequest", {"id": 0, "method": "item/tool/call", "params": params})
            _check_steps(step.get("then", []), errors)
        elif "request" in step and step["request"] in p.SERVER_REQUESTS:
            errors += validate_message(
                SCHEMA, "ServerRequest", {"id": 0, "method": step["request"], "params": step["params"]}
            )
        elif "complete" in step and step["complete"].get("error"):
            errors += validate_def(SCHEMA, "TurnError", step["complete"]["error"])


@pytest.mark.parametrize("path", sorted(SCENARIOS.glob("*.json")), ids=lambda x: Path(x).stem)
def test_scenarios_speak_the_real_protocol(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    errors: list[str] = []
    for script in data.get("turnScripts", []):
        _check_steps(script, errors)
    _check_steps(data.get("afterInitialize", []), errors)
    for thread in data.get("threads", []):
        errors += validate_def(SCHEMA, "Thread", thread)
    for turns in data.get("turns", {}).values():
        for turn in turns:
            errors += validate_def(SCHEMA, "Turn", turn)
    if "rateLimits" in data:
        errors += validate_def(SCHEMA, "GetAccountRateLimitsResponse", data["rateLimits"])
    assert errors == []
