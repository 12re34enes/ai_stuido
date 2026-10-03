"""Permission matrix: environment x level x class x actor boundary (pure)."""

from __future__ import annotations

import itertools

import pytest

from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.remote.classify import classify_redis, classify_shell, classify_sql
from aistudio.remote.policy import (
    RemoteAccess,
    actor_kind,
    agent_session_id,
    compile_pattern,
    decide,
    matches_limited,
    validate_patterns,
)

ENVS = list(Environment)
LEVELS = list(PermissionLevel)
CLASSES = ["read", "write", "unknown"]
ACTORS: list[RemoteAccess | None] = [None, "none", "read", "limited", "full"]
_ORDER = ["read", "limited", "full"]


def oracle(env: Environment, level: PermissionLevel, klass: str, access: RemoteAccess | None, match: bool) -> str:
    """Independent statement of the rules from the spec."""
    write = klass != "read"
    if access == "none":
        return "deny"
    if access == "read" and write:
        return "deny"
    effective = level.value
    if access is not None:
        effective = min(level.value, access, key=_ORDER.index)
    if not write:
        return "allow"
    if env == Environment.production:
        return "approve"
    if effective == "read":
        return "approve"
    if effective == "limited":
        return "allow" if match else "approve"
    return "allow"


@pytest.mark.parametrize(
    ("env", "level", "klass", "access", "match"),
    list(itertools.product(ENVS, LEVELS, CLASSES, ACTORS, [False, True])),
)
def test_permission_matrix(
    env: Environment, level: PermissionLevel, klass: str, access: RemoteAccess | None, match: bool
) -> None:
    d = decide(environment=env, level=level, klass=klass, agent_access=access, limited_match=match)  # type: ignore[arg-type]
    assert d.action == oracle(env, level, klass, access, match)
    assert d.reason  # Turkish explanation always present
    if d.action == "allow" and klass == "read":
        assert d.readonly_session == (env == Environment.production or d.effective_level == PermissionLevel.read)
    if klass != "read":
        assert not d.readonly_session


def test_production_writes_always_need_approval_even_with_full_level() -> None:
    for klass in ("write", "unknown"):
        for access in (None, "limited", "full"):
            d = decide(
                environment=Environment.production,
                level=PermissionLevel.full,
                klass=klass,  # type: ignore[arg-type]
                agent_access=access,  # type: ignore[arg-type]
                limited_match=True,
            )
            assert d.action == "approve"
            assert "Production" in d.reason


def test_unknown_reason_mentions_write() -> None:
    d = decide(
        environment=Environment.test,
        level=PermissionLevel.read,
        klass="unknown",
        agent_access=None,
        limited_match=False,
    )
    assert d.action == "approve" and "Bilinmeyen komut yazma sayılır" in d.reason


def test_agent_capped_at_its_access() -> None:
    d = decide(
        environment=Environment.test,
        level=PermissionLevel.full,
        klass="write",
        agent_access="limited",
        limited_match=False,
    )
    assert d.action == "approve" and d.effective_level == PermissionLevel.limited


def test_actor_helpers() -> None:
    assert actor_kind("agent:ses_1") == "agent" and agent_session_id("agent:ses_1") == "ses_1"
    assert actor_kind("user") == "user" and agent_session_id("user") is None
    assert actor_kind("system") == "system"
    assert agent_session_id("agent:") is None


# ----------------------------------------------------------------------------- limited-write patterns


@pytest.mark.parametrize(
    ("command", "patterns", "expected"),
    [
        ("systemctl restart myapp", ["systemctl restart myapp"], True),
        ("systemctl  restart   myapp", ["systemctl restart myapp"], True),
        ("systemctl restart myapp", ["systemctl restart *"], True),
        ("systemctl restart other", ["systemctl restart myapp"], False),
        ("systemctl restart myapp; rm -rf /", ["systemctl restart *"], False),
        ("systemctl restart myapp && rm -rf /", ["systemctl restart *", "rm *"], True),
        ("systemctl restart $(rm -rf /)", ["systemctl restart *"], False),
        ("systemctl restart `id`", ["systemctl restart *"], False),
        ("echo hi > /etc/x", ["echo *"], False),
        ("echo hi > /tmp/x", ["echo * > /tmp/*"], True),
        ("uptime", ["nothing"], True),  # no write segment at all
        ("systemctl restart myapp", ["re:systemctl (restart|reload) myapp"], True),
        ("systemctl stop myapp", ["re:systemctl (restart|reload) myapp"], False),
        ("time systemctl restart myapp", ["*"], False),  # fallback parse: never auto-allowed
        ("systemctl restart myapp", [], False),
    ],
)
def test_limited_shell_patterns(command: str, patterns: list[str], expected: bool) -> None:
    assert matches_limited(classify_shell(command), patterns, "shell") is expected


def test_limited_sql_patterns() -> None:
    patterns = ["INSERT INTO audit_log *"]
    assert matches_limited(classify_sql("insert into audit_log (a) values (1)", "postgres"), patterns, "sql")
    assert not matches_limited(classify_sql("INSERT INTO users VALUES (1)", "postgres"), patterns, "sql")
    both = classify_sql("INSERT INTO audit_log VALUES (1); DELETE FROM users", "postgres")
    assert not matches_limited(both, patterns, "sql")
    assert not matches_limited(classify_sql("INSERT INTO", "postgres"), ["*"], "sql")


def test_limited_redis_patterns() -> None:
    assert matches_limited(classify_redis("DEL cache:1"), ["del cache:*"], "redis")
    assert not matches_limited(classify_redis("DEL user:1"), ["DEL cache:*"], "redis")


def test_glob_cannot_cross_metacharacters() -> None:
    rx = compile_pattern("echo *", "shell")
    assert rx.fullmatch("echo hello world")
    for bad in ("echo a; rm x", "echo a | sh", "echo $(id)", "echo a > f", "echo `id`", "echo a & rm"):
        assert not rx.fullmatch(bad)


def test_validate_patterns() -> None:
    assert validate_patterns([" a ", "", "re:^x$"], "shell") == ["a", "re:^x$"]
    with pytest.raises(ValueError, match="Geçersiz kalıp"):
        validate_patterns(["re:("], "shell")
