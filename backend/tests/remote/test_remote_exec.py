"""exec(): boundaries, permission levels, approvals (real ApprovalService) and audit events."""

from __future__ import annotations

import asyncio
import itertools

import pytest
from remote_testlib import FakeAgentManager, FakeMemory, FakeRunner, RemoteEnv, auto_decide

from aistudio.contracts.agents import AgentManager
from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.tools import ToolContext
from aistudio.core.errors import PermissionDenied, ValidationFailed
from aistudio.core.events import ET, Severity

READ_CMD = "tail -n 50 /var/log/syslog"
WRITE_CMD = "systemctl restart nginx"


async def _with_agent(renv: RemoteEnv, session: str, access: str) -> FakeAgentManager:
    mgr = renv.ctx.services.maybe(AgentManager)  # type: ignore[type-abstract]
    if mgr is None:
        mgr = FakeAgentManager()
        renv.ctx.services.register(AgentManager, mgr)  # type: ignore[type-abstract]
    assert isinstance(mgr, FakeAgentManager)
    mgr.access[session] = access
    return mgr


MATRIX = list(
    itertools.product(
        [Environment.test, Environment.production],
        [PermissionLevel.read, PermissionLevel.limited, PermissionLevel.full],
        [READ_CMD, WRITE_CMD],
        ["user", "none", "read", "full"],
    )
)


@pytest.mark.parametrize(("env", "level", "command", "actor"), MATRIX)
async def test_exec_matrix(
    renv: RemoteEnv, fake_runner: FakeRunner, env: Environment, level: PermissionLevel, command: str, actor: str
) -> None:
    host = await renv.add_host(environment=env, permission_level=level)
    actor_id = "user"
    if actor != "user":
        await _with_agent(renv, "ses_1", actor)
        actor_id = "agent:ses_1"
    write = command == WRITE_CMD
    expect_deny = actor == "none" or (actor == "read" and write)
    effective = level if actor in ("user", "full") else PermissionLevel.read
    expect_approval = not expect_deny and write and (env == Environment.production or effective != PermissionLevel.full)

    decider = auto_decide(renv) if expect_approval else None
    result = await renv.svc.exec(host.id, command, actor=actor_id, session_id="ses_1" if actor != "user" else None)
    if decider is not None:
        approval = await decider
        assert approval.kind == ApprovalKind.remote_command
        assert approval.production == (env == Environment.production)
        assert approval.severity == (Severity.critical if env == Environment.production else Severity.high)
        assert approval.payload["command"] == command
        assert approval.payload["environment"] == env.value
        assert approval.payload["classification"]["klass"] == "write"
        assert result.approved_by == "user"
    else:
        assert not await renv.approvals.list(status=ApprovalStatus.pending)

    if expect_deny:
        assert result.denied and result.denial_reason and fake_runner.commands == []
    else:
        assert not result.denied and fake_runner.commands == [command] and result.exit_code == 0

    events = await renv.events(ET.REMOTE_COMMAND)
    assert len(events) == 1
    payload = events[0].payload
    assert payload["host_id"] == host.id and payload["environment"] == env.value
    assert payload["command"] == command
    assert payload["denied"] is expect_deny
    assert payload["classification"]["klass"] == ("write" if write else "read")
    assert events[0].actor == actor_id


async def test_production_approvals_are_never_cached(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host(environment=Environment.production, permission_level=PermissionLevel.full)
    ids = []
    for _ in range(2):
        decider = auto_decide(renv)
        result = await renv.svc.exec(host.id, WRITE_CMD, actor="user")
        approval = await decider
        ids.append(approval.id)
        assert result.approved_by == "user" and not result.denied
    assert ids[0] != ids[1]
    assert fake_runner.commands == [WRITE_CMD, WRITE_CMD]
    approvals = await renv.approvals.list(status=None)
    assert {a.id for a in approvals} == set(ids)
    assert all(a.production and a.severity == Severity.critical for a in approvals)


async def test_rejection_denies_and_audits(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host(environment=Environment.production)
    decider = auto_decide(renv, approve=False, note="şimdi olmaz")
    result = await renv.svc.exec(host.id, "rm -rf /srv/app", actor="user", reason="temizlik")
    await decider
    assert result.denied and result.denial_reason == "Onay reddedildi: şimdi olmaz."
    assert fake_runner.commands == []
    (event,) = await renv.events(ET.REMOTE_COMMAND)
    assert event.payload["outcome"] == "rejected"
    assert event.payload["approval_status"] == "rejected"
    assert event.payload["approved_by"] is None
    assert event.payload["reason"] == "temizlik"
    assert event.severity == Severity.high


async def test_production_approval_cannot_come_from_remote_channel(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host(environment=Environment.production)
    task = asyncio.create_task(renv.svc.exec(host.id, WRITE_CMD, actor="user"))
    pending = await renv.next_pending()
    with pytest.raises(PermissionDenied):
        await renv.approvals.decide(pending.id, approve=True, channel="telegram", decided_by="channel:telegram")
    assert not task.done()
    await renv.approvals.decide(pending.id, approve=True, channel="app")
    result = await task
    assert not result.denied and fake_runner.commands == [WRITE_CMD]


async def test_approval_timeout_denies(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    renv.svc.approval_timeout = 0.2
    host = await renv.add_host(environment=Environment.production)
    result = await renv.svc.exec(host.id, WRITE_CMD, actor="user")
    assert result.denied and fake_runner.commands == []
    (approval,) = await renv.approvals.list(status=None)
    assert approval.status in (ApprovalStatus.expired, ApprovalStatus.cancelled)


async def test_cancelled_request_cancels_approval(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host(environment=Environment.production)
    task = asyncio.create_task(renv.svc.exec(host.id, WRITE_CMD, actor="user"))
    pending = await renv.next_pending()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    for _ in range(200):  # cleanup may finish just after the cancellation propagated
        if (await renv.approvals.get(pending.id)).status == ApprovalStatus.cancelled:
            break
        await asyncio.sleep(0.01)
    assert (await renv.approvals.get(pending.id)).status == ApprovalStatus.cancelled
    assert fake_runner.commands == []


async def test_limited_level_patterns(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host(
        permission_level=PermissionLevel.limited, limited_write_patterns=["systemctl restart app"]
    )
    ok = await renv.svc.exec(host.id, "systemctl restart app", actor="user")
    assert not ok.denied and ok.approved_by is None
    decider = auto_decide(renv, approve=False)
    other = await renv.svc.exec(host.id, "systemctl restart app; rm -rf /", actor="user")
    await decider
    assert other.denied
    assert fake_runner.commands == ["systemctl restart app"]


async def test_limited_patterns_do_not_apply_on_production(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host(
        environment=Environment.production,
        permission_level=PermissionLevel.limited,
        limited_write_patterns=["systemctl restart app"],
    )
    decider = auto_decide(renv)
    result = await renv.svc.exec(host.id, "systemctl restart app", actor="user")
    approval = await decider
    assert approval.production and result.approved_by == "user"


async def test_output_is_masked(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    secret = "s3cr3t-" + "x" * 12
    renv.ctx.secrets.set("db/test/password", secret)
    fake_runner.output = f"password is {secret}\n"
    host = await renv.add_host()
    result = await renv.svc.exec(host.id, "cat /etc/app.conf", actor="user")
    assert secret not in result.output and "[gizli]" in result.output
    (event,) = await renv.events(ET.REMOTE_COMMAND)
    assert secret not in str(event.payload)


async def test_timeout_is_reported(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    fake_runner.timed_out = True
    host = await renv.add_host()
    result = await renv.svc.exec(host.id, "tail -f /var/log/x", actor="user", timeout=5)
    assert result.exit_code is None and "zaman aşımı" in result.output


async def test_validation(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host()
    with pytest.raises(ValidationFailed):
        await renv.svc.exec(host.id, "   ", actor="user")
    with pytest.raises(ValidationFailed):
        await renv.svc.exec(host.id, "ls " + "a" * 30_000, actor="user")


async def test_audit_chain_stays_valid(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host()
    await renv.svc.exec(host.id, "uptime", actor="user")
    await _with_agent(renv, "ses_x", "none")
    await renv.svc.exec(host.id, "uptime", actor="agent:ses_x")
    ok, bad = await renv.ctx.events.verify_chain()
    assert ok and bad is None
    events = await renv.events(ET.REMOTE_COMMAND)
    assert [e.payload["denied"] for e in events] == [False, True]


# ----------------------------------------------------------------------------- boundaries


async def test_unknown_session_fails_closed(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host(permission_level=PermissionLevel.full)
    result = await renv.svc.exec(host.id, "uptime", actor="agent:ses_missing")
    assert result.denied and "remote_access: none" in (result.denial_reason or "")


async def test_workspace_boundaries_are_merged_most_restrictive(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    host = await renv.add_host(permission_level=PermissionLevel.full)
    await _with_agent(renv, "ses_m", "full")
    renv.ctx.services.register(MemoryService, FakeMemory("read"))  # type: ignore[type-abstract]
    read = await renv.svc.exec(host.id, "uptime", actor="agent:ses_m", workspace_id="ws_test")
    assert not read.denied
    write = await renv.svc.exec(host.id, WRITE_CMD, actor="agent:ses_m", workspace_id="ws_test")
    assert write.denied and "salt okuma" in (write.denial_reason or "")


# ----------------------------------------------------------------------------- studio tools


async def test_tools_are_registered_with_rules(renv: RemoteEnv) -> None:
    specs = {s.name: s for s in renv.tools.all_specs()}
    assert specs["remote_exec"].mutating is False
    assert specs["db_query"].mutating is False
    assert "PRODUCTION" in specs["remote_exec"].description
    assert "read-only transaction" in specs["db_query"].description
    assert specs["remote_exec"].input_schema["required"] == ["host", "command", "reason"]


async def test_remote_exec_tool_by_name(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    await renv.add_host(name="web-1", environment=Environment.test, permission_level=PermissionLevel.read)
    await _with_agent(renv, "ses_t", "read")
    host_tools = renv.tools.bind(
        ToolContext(workspace_id="ws_test", session_id="ses_t", provider="claude"), ["remote_exec", "db_query"]
    )
    ok = await host_tools.call("remote_exec", {"host": "WEB-1", "command": "uptime", "reason": "kontrol"})
    assert not ok.is_error and "exit code: 0" in ok.content and ok.data and ok.data["environment"] == "test"
    denied = await host_tools.call("remote_exec", {"host": "web-1", "command": "rm -rf /", "reason": "x"})
    assert denied.is_error and "DENIED" in denied.content
    missing = await host_tools.call("remote_exec", {"host": "nope", "command": "uptime", "reason": "x"})
    assert missing.is_error and "web-1" in missing.content
    events = await renv.events(ET.REMOTE_COMMAND)
    assert [e.payload["source"] for e in events] == ["tool", "tool"]
    assert all(e.actor == "agent:ses_t" and e.session_id == "ses_t" for e in events)


async def test_tool_hosts_are_scoped_to_workspace(renv: RemoteEnv, fake_runner: FakeRunner) -> None:
    await renv.add_host(name="other-ws", workspace_id="ws_other")
    await _with_agent(renv, "ses_s", "read")
    tools = renv.tools.bind(ToolContext(workspace_id="ws_test", session_id="ses_s", provider="codex"))
    result = await tools.call("remote_exec", {"host": "other-ws", "command": "uptime", "reason": "x"})
    assert result.is_error
