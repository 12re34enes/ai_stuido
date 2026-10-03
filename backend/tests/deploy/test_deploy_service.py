"""DeployService: kinds, approvals, health checks, rollback, events, tool."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest
import respx
from deploy_testlib import DeployEnv

from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.deploy import DeployService
from aistudio.contracts.git_hosting import CheckRun
from aistudio.contracts.tools import ToolContext
from aistudio.core.errors import Conflict, ValidationFailed
from aistudio.core.events import ET, Severity
from aistudio.deploy.models import DeployProfileUpdate

# ----------------------------------------------------------------------------- command kind


async def test_command_deploy_non_production_runs_without_approval(denv: DeployEnv, tmp_path: Path) -> None:
    profile = await denv.profile(
        config={"command": 'echo "deployed-$DEPLOY_ENV-$DEPLOY_REF" && pwd', "cwd": str(tmp_path)}
    )
    result = await denv.svc.deploy(profile.id, ref="v1.2.3", actor="user", summary="küçük düzeltme")
    assert result.status == "succeeded" and result.approved_by is None and result.health_ok is None
    assert "deployed-test-v1.2.3" in result.log and str(tmp_path) in result.log
    assert await denv.approvals.list(status=None) == []
    started, succeeded = await denv.events(ET.DEPLOY_STARTED), await denv.events(ET.DEPLOY_SUCCEEDED)
    assert len(started) == 1 and len(succeeded) == 1
    assert succeeded[0].severity == Severity.normal and succeeded[0].payload["ref"] == "v1.2.3"
    run = await denv.svc.get_run(result.id)
    assert run.status == "succeeded" and run.finished_at is not None and run.summary == "küçük düzeltme"


async def test_command_failure_offers_rollback(denv: DeployEnv) -> None:
    profile = await denv.profile(config={"command": "echo boom; exit 3"}, rollback={"command": "echo rolled-back"})
    failed = await denv.svc.deploy(profile.id, ref=None, actor="user")
    assert failed.status == "failed" and "çıkış kodu 3" in failed.log
    run = await denv.svc.get_run(failed.id)
    assert run.rollback_available and run.error and "Komut başarısız" in run.error
    (event,) = await denv.events(ET.DEPLOY_FAILED)
    assert event.severity == Severity.high and event.payload["rollback_available"] is True

    rolled = await denv.svc.rollback(failed.id, actor="user")
    assert rolled.status == "succeeded" and "rolled-back" in rolled.log
    rb_run = await denv.svc.get_run(rolled.id)
    assert rb_run.rollback_of == failed.id and not rb_run.rollback_available
    started = await denv.events(ET.DEPLOY_STARTED)
    assert started[-1].payload["rollback_of"] == failed.id


async def test_rollback_requires_config(denv: DeployEnv) -> None:
    profile = await denv.profile(config={"command": "exit 1"})
    failed = await denv.svc.deploy(profile.id, ref=None, actor="user")
    assert not (await denv.svc.get_run(failed.id)).rollback_available
    with pytest.raises(ValidationFailed):
        await denv.svc.rollback(failed.id, actor="user")


async def test_command_timeout(denv: DeployEnv) -> None:
    profile = await denv.profile(config={"command": "sleep 5", "timeout_s": 0.3})
    result = await denv.svc.deploy(profile.id, ref=None, actor="user")
    assert result.status == "failed" and "zaman aşımı" in result.log


# ----------------------------------------------------------------------------- production approvals


async def test_production_deploy_waits_for_locked_approval(denv: DeployEnv, tmp_path: Path) -> None:
    marker = tmp_path / "deployed"
    profile = await denv.profile(
        name="prod-web", environment=Environment.production, config={"command": f"touch {marker}"}
    )
    task = asyncio.create_task(denv.svc.deploy(profile.id, ref="main", actor="user", summary="Yeni sürüm"))
    pending = await denv.next_pending()
    assert pending.kind == ApprovalKind.deploy and pending.production
    assert pending.severity == Severity.critical
    assert pending.title == "Production deploy: prod-web"
    assert pending.payload["profile_name"] == "prod-web" and pending.payload["environment"] == "production"
    assert pending.payload["ref"] == "main" and pending.payload["summary"] == "Yeni sürüm"
    assert pending.payload["command"] == f"touch {marker}"
    run = (await denv.svc.list_runs(profile_id=profile.id))[0]
    while run.approval_id is None:  # the run row records the approval right after it is created
        await asyncio.sleep(0.01)
        run = await denv.svc.get_run(run.id)
    assert run.status == "pending_approval" and run.approval_id == pending.id
    await asyncio.sleep(0.05)
    assert not marker.exists()
    await denv.approvals.decide(pending.id, approve=True, decided_by="user")
    result = await task
    assert result.status == "succeeded" and result.approved_by == "user" and marker.exists()
    (ev,) = await denv.events(ET.DEPLOY_SUCCEEDED)
    assert ev.severity == Severity.high and ev.payload["approval_id"] == pending.id


async def test_production_rejection_runs_nothing(denv: DeployEnv, tmp_path: Path) -> None:
    marker = tmp_path / "deployed"
    profile = await denv.profile(environment=Environment.production, config={"command": f"touch {marker}"})
    decider = denv.auto_decide(approve=False, note="dondurma dönemi")
    result = await denv.svc.deploy(profile.id, ref="main", actor="user")
    await decider
    assert result.status == "rejected" and not marker.exists()
    assert "dondurma dönemi" in result.log
    assert await denv.events(ET.DEPLOY_STARTED) == []
    (ev,) = await denv.events("deploy.rejected")
    assert ev.severity == Severity.high


async def test_production_failure_is_critical(denv: DeployEnv) -> None:
    profile = await denv.profile(environment=Environment.production, config={"command": "exit 1"})
    decider = denv.auto_decide()
    result = await denv.svc.deploy(profile.id, ref=None, actor="user")
    await decider
    assert result.status == "failed"
    (ev,) = await denv.events(ET.DEPLOY_FAILED)
    assert ev.severity == Severity.critical


async def test_production_approvals_are_per_deploy(denv: DeployEnv) -> None:
    profile = await denv.profile(environment=Environment.production)
    ids = []
    for _ in range(2):
        decider = denv.auto_decide()
        await denv.svc.deploy(profile.id, ref=None, actor="user")
        ids.append((await decider).id)
    assert ids[0] != ids[1]


async def test_production_rollback_also_needs_approval(denv: DeployEnv) -> None:
    profile = await denv.profile(
        environment=Environment.production, config={"command": "exit 1"}, rollback={"command": "echo undo"}
    )
    decider = denv.auto_decide()
    failed = await denv.svc.deploy(profile.id, ref=None, actor="user")
    await decider
    task = asyncio.create_task(denv.svc.rollback(failed.id, actor="user"))
    pending = await denv.next_pending()
    assert pending.title.startswith("Production geri alma") and pending.payload["rollback_of"] == failed.id
    await denv.approvals.decide(pending.id, approve=True)
    assert (await task).status == "succeeded"


async def test_agent_requests_always_need_approval(denv: DeployEnv) -> None:
    profile = await denv.profile(environment=Environment.test)
    decider = denv.auto_decide()
    result = await denv.svc.deploy(profile.id, ref=None, actor="agent:ses_1")
    approval = await decider
    assert not approval.production and approval.severity == Severity.high
    assert result.status == "succeeded" and result.approved_by == "user"


async def test_approval_timeout_rejects(denv: DeployEnv) -> None:
    denv.svc.approval_timeout = 0.2
    profile = await denv.profile(environment=Environment.production)
    result = await denv.svc.deploy(profile.id, ref=None, actor="user")
    assert result.status == "rejected"
    (approval,) = await denv.approvals.list(status=None)
    assert approval.status in (ApprovalStatus.expired, ApprovalStatus.cancelled)


async def test_concurrent_deploys_of_one_profile_conflict(denv: DeployEnv) -> None:
    profile = await denv.profile(environment=Environment.production)
    run = await denv.svc.start(profile.id, ref=None, actor="user")
    await denv.next_pending()
    with pytest.raises(Conflict):
        await denv.svc.start(profile.id, ref=None, actor="user")
    cancelled = await denv.svc.cancel(run.id)
    assert cancelled.status == "cancelled"
    for _ in range(200):  # the approval is cancelled by the run (or its cleanup) right away
        if [a.status for a in await denv.approvals.list(status=None)] == [ApprovalStatus.cancelled]:
            break
        await asyncio.sleep(0.01)
    assert [a.status for a in await denv.approvals.list(status=None)] == [ApprovalStatus.cancelled]
    # the lock is released after cancellation
    decider = denv.auto_decide()
    assert (await denv.svc.deploy(profile.id, ref=None, actor="user")).status == "succeeded"
    await decider
    with pytest.raises(Conflict):
        await denv.svc.cancel(run.id)


# ----------------------------------------------------------------------------- ci kind


async def test_ci_deploy_polls_until_done(denv: DeployEnv) -> None:
    profile = await denv.profile(
        kind="ci",
        config={
            "repo_id": "repo_1",
            "workflow": "deploy.yml",
            "variables": {"ENV": "staging"},
            "poll_interval_s": 0.01,
        },
    )
    result = await denv.svc.deploy(profile.id, ref="release/1", actor="user")
    assert result.status == "succeeded"
    assert denv.hosting.triggered == [
        {"repo_id": "repo_1", "ref": "release/1", "workflow": "deploy.yml", "variables": {"ENV": "staging"}}
    ]
    run = await denv.svc.get_run(result.id)
    assert run.external_id == "run-1"
    assert "in_progress" in run.log and "completed/success" in run.log


async def test_ci_failure_and_default_ref(denv: DeployEnv) -> None:
    denv.hosting.states = [CheckRun(name="deploy", status="completed", conclusion="failure")]
    profile = await denv.profile(kind="ci", config={"repo_id": "repo_1", "poll_interval_s": 0.01})
    result = await denv.svc.deploy(profile.id, ref=None, actor="user")
    assert result.status == "failed" and "Pipeline başarısız: failure" in result.log
    assert denv.hosting.triggered[0]["ref"] == "main"


async def test_ci_timeout(denv: DeployEnv) -> None:
    denv.hosting.states = [CheckRun(name="deploy", status="in_progress")]
    profile = await denv.profile(kind="ci", config={"repo_id": "r", "poll_interval_s": 0.01, "timeout_s": 0.1})
    result = await denv.svc.deploy(profile.id, ref="x", actor="user")
    assert result.status == "failed" and "zaman aşımı" in result.log


# ----------------------------------------------------------------------------- ssh kind


async def test_ssh_sequential_logs_remote_commands_with_deploy_approval(denv: DeployEnv) -> None:
    denv.remote.add("web-1", level=PermissionLevel.read)
    denv.remote.add("web-2", level=PermissionLevel.read)
    profile = await denv.profile(
        kind="ssh",
        config={"host_ids": ["web-1", "web-2"], "script": "cd /srv/app\n./deploy.sh", "cwd": "/srv"},
    )
    decider = denv.auto_decide()
    result = await denv.svc.deploy(profile.id, ref="v2", actor="user")
    approval = await decider
    assert not approval.production  # read-level hosts: approval required, not production
    assert result.status == "succeeded"
    assert [c["host"] for c in denv.remote.calls] == ["web-1", "web-2"]
    first = denv.remote.calls[0]
    assert first["argv"] == ["sh", "-s"] and first["cwd"] == "/srv"
    script = first["input"].decode()
    assert "export DEPLOY_REF=v2\n" in script and script.endswith("cd /srv/app\n./deploy.sh\n")
    events = await denv.events(ET.REMOTE_COMMAND)
    assert [e.payload["host_id"] for e in events] == ["web-1", "web-2"]
    assert all(e.payload["approval_id"] == approval.id and e.payload["approved_by"] == "user" for e in events)
    assert all(e.payload["source"] == "deploy" and e.payload["deploy_id"] == result.id for e in events)
    # exactly one approval for the whole deploy: the script is not approved again per host
    assert len(await denv.approvals.list(status=None)) == 1


async def test_ssh_full_level_non_production_needs_no_approval(denv: DeployEnv) -> None:
    denv.remote.add("app-1", level=PermissionLevel.full)
    profile = await denv.profile(kind="ssh", config={"host_ids": ["app-1"], "script": "true"})
    result = await denv.svc.deploy(profile.id, ref=None, actor="user")
    assert result.status == "succeeded" and await denv.approvals.list(status=None) == []


async def test_ssh_production_host_makes_deploy_production(denv: DeployEnv) -> None:
    denv.remote.add("prod-1", environment=Environment.production, level=PermissionLevel.full)
    profile = await denv.profile(
        kind="ssh", environment=Environment.test, config={"host_ids": ["prod-1"], "script": "true"}
    )
    decider = denv.auto_decide()
    result = await denv.svc.deploy(profile.id, ref=None, actor="user")
    approval = await decider
    assert approval.production and approval.severity == Severity.critical
    assert result.environment == Environment.production


async def test_ssh_sequential_stops_at_first_failure(denv: DeployEnv) -> None:
    for h in ("a", "b", "c"):
        denv.remote.add(h)
    denv.remote.exit_codes["b"] = 2
    profile = await denv.profile(kind="ssh", config={"host_ids": ["a", "b", "c"], "script": "deploy"})
    result = await denv.svc.deploy(profile.id, ref=None, actor="user")
    assert result.status == "failed" and "Betik başarısız: b" in result.log
    assert [c["host"] for c in denv.remote.calls] == ["a", "b"]


async def test_ssh_rolling_batches_with_health_between(denv: DeployEnv, respx_mock: respx.MockRouter) -> None:
    for h in ("r1", "r2", "r3", "r4"):
        denv.remote.add(h)
    denv.remote.delay = 0.05
    route = respx_mock.get("http://health.local/ready").mock(return_value=httpx.Response(200))
    profile = await denv.profile(
        kind="ssh",
        config={"host_ids": ["r1", "r2", "r3", "r4"], "script": "deploy", "strategy": "rolling", "batch_size": 2},
        health_check={"url": "http://health.local/ready", "timeout_s": 2, "interval_s": 0.05},
    )
    result = await denv.svc.deploy(profile.id, ref=None, actor="user")
    assert result.status == "succeeded" and result.health_ok is True
    assert denv.remote.max_active == 2  # parallel within a batch
    assert route.call_count == 2  # once between batches, once at the end


async def test_ssh_unknown_host_rejected_at_profile_creation(denv: DeployEnv) -> None:
    with pytest.raises(ValidationFailed, match="Host bulunamadı"):
        await denv.profile(kind="ssh", config={"host_ids": ["ghost"], "script": "x"})
    with pytest.raises(ValidationFailed):
        await denv.profile(kind="ssh", config={"host_ids": [], "script": "x"})


# ----------------------------------------------------------------------------- health checks


async def test_health_check_url_success_and_failure(denv: DeployEnv, respx_mock: respx.MockRouter) -> None:
    respx_mock.get("http://ok.local/health").mock(return_value=httpx.Response(204))
    respx_mock.get("http://bad.local/health").mock(return_value=httpx.Response(503))
    good = await denv.profile(health_check={"url": "http://ok.local/health", "timeout_s": 1, "interval_s": 0.05})
    result = await denv.svc.deploy(good.id, ref=None, actor="user")
    assert result.status == "succeeded" and result.health_ok is True
    bad = await denv.profile(
        health_check={"url": "http://bad.local/health", "timeout_s": 0.3, "interval_s": 0.05},
        rollback={"command": "echo undo"},
    )
    result = await denv.svc.deploy(bad.id, ref=None, actor="user")
    assert result.status == "failed" and result.health_ok is False
    assert "HTTP 503" in result.log
    assert (await denv.svc.get_run(result.id)).rollback_available


async def test_health_check_expect_status_and_connection_errors(denv: DeployEnv, respx_mock: respx.MockRouter) -> None:
    respx_mock.get("http://teapot.local/").mock(return_value=httpx.Response(418))
    respx_mock.get("http://down.local/").mock(side_effect=httpx.ConnectError("refused"))
    teapot = await denv.profile(health_check={"url": "http://teapot.local/", "expect_status": [418], "timeout_s": 1})
    assert (await denv.svc.deploy(teapot.id, ref=None, actor="user")).health_ok is True
    down = await denv.profile(health_check={"url": "http://down.local/", "timeout_s": 0.2, "interval_s": 0.05})
    result = await denv.svc.deploy(down.id, ref=None, actor="user")
    assert result.health_ok is False and "ConnectError" in result.log


async def test_health_check_command_local_and_remote(denv: DeployEnv) -> None:
    ok = await denv.profile(health_check={"command": "test 1 -eq 1", "timeout_s": 1})
    assert (await denv.svc.deploy(ok.id, ref=None, actor="user")).health_ok is True
    bad = await denv.profile(health_check={"command": "exit 1", "timeout_s": 0.2, "interval_s": 0.05})
    assert (await denv.svc.deploy(bad.id, ref=None, actor="user")).health_ok is False
    denv.remote.add("mon")
    remote_hc = await denv.profile(health_check={"command": "curl -fsS localhost/health", "host_id": "mon"})
    result = await denv.svc.deploy(remote_hc.id, ref=None, actor="user")
    assert result.health_ok is True
    assert denv.remote.calls[-1]["argv"] == ["sh", "-c", "curl -fsS localhost/health"]
    (event,) = await denv.events(ET.REMOTE_COMMAND)
    assert event.payload["source"] == "deploy" and event.payload["host_id"] == "mon"


async def test_health_check_validation(denv: DeployEnv) -> None:
    with pytest.raises(ValidationFailed):
        await denv.profile(health_check={"url": "http://x", "command": "y"})
    assert (await denv.profile(health_check={})).health_check is None  # empty = no health check
    with pytest.raises(ValidationFailed):
        await denv.profile(health_check={"url": "ftp://x"})


# ----------------------------------------------------------------------------- profiles, history, tool


async def test_profile_crud_and_history(denv: DeployEnv) -> None:
    profile = await denv.profile(name="web")
    with pytest.raises(Conflict):
        await denv.profile(name="WEB")
    updated = await denv.svc.update_profile(profile.id, DeployProfileUpdate(environment=Environment.production))
    assert updated.environment == Environment.production
    with pytest.raises(ValidationFailed):
        await denv.svc.update_profile(profile.id, DeployProfileUpdate(config={"nope": 1}))
    other = await denv.profile(name="api")
    await denv.svc.deploy(other.id, ref=None, actor="user")
    await denv.svc.deploy(other.id, ref=None, actor="user")
    runs = await denv.svc.list_runs(profile_id=other.id)
    assert len(runs) == 2 and all(r.environment == Environment.test for r in runs)
    assert await denv.svc.list_runs(environment=Environment.production) == []
    await denv.svc.delete_profile(profile.id)
    assert [p.name for p in await denv.svc.list_profiles("ws_test")] == ["api"]


async def test_service_is_registered_and_tool_requests_go_through_approval(denv: DeployEnv) -> None:
    svc = denv.ctx.services.get(DeployService)  # type: ignore[type-abstract]
    assert svc is denv.svc
    spec = next(s for s in denv.tools.all_specs() if s.name == "deploy_request")
    assert spec.mutating is True and "approval" in spec.description
    await denv.profile(name="staging-web", environment=Environment.test)
    tools = denv.tools.bind(ToolContext(workspace_id="ws_test", session_id="ses_9", provider="codex", task_id="task_1"))
    decider = denv.auto_decide()
    result = await tools.call("deploy_request", {"profile": "staging-web", "ref": "main", "summary": "Yeni özellik"})
    approval = await decider
    assert approval.requested_by == "agent:ses_9" and approval.payload["summary"] == "Yeni özellik"
    assert not result.is_error and "status: succeeded" in result.content
    read_only = denv.tools.bind(
        ToolContext(workspace_id="ws_test", session_id="s", provider="claude"), allow_mutating=False
    )
    assert "deploy_request" not in {s.name for s in read_only.specs()}


async def test_restart_marks_interrupted_runs_failed(denv: DeployEnv) -> None:
    """A run left pending by a previous process (no live task) is failed and its approval cancelled."""
    from aistudio.contracts.approvals import ApprovalRequest
    from aistudio.core.clock import utcnow
    from aistudio.deploy.module import DeployModule
    from aistudio.deploy.tables import deploy_runs

    profile = await denv.profile(environment=Environment.production)
    approval = await denv.approvals.request(ApprovalRequest(kind=ApprovalKind.deploy, title="x", production=True))
    async with denv.ctx.db.begin() as conn:
        await conn.execute(
            deploy_runs.insert().values(
                id="dpl_orphan",
                profile_id=profile.id,
                workspace_id=profile.workspace_id,
                profile_name=profile.name,
                kind="command",
                environment="production",
                status="pending_approval",
                actor="user",
                approval_id=approval.id,
                rollback_available=False,
                log="",
                started_at=utcnow(),
            )
        )
    await DeployModule().start(denv.ctx)  # the startup sweep of a new process
    run = await denv.svc.get_run("dpl_orphan")
    assert run.status == "failed" and run.error and "yarıda kaldı" in run.error
    assert (await denv.approvals.get(approval.id)).status == ApprovalStatus.cancelled
