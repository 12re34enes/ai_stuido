"""A flow's deploy-gate approval stands in for the service's own approval — but only when it
really is the same decision (same task/run/profile, production-grade, recent, unused)."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path

import sqlalchemy as sa
from deploy_testlib import DeployEnv

from aistudio.contracts.approvals import ApprovalKind, ApprovalRequest, ApprovalStatus
from aistudio.contracts.common import Environment
from aistudio.core.clock import utcnow
from aistudio.storage.tables import approvals as approvals_t


async def gate_approval(
    denv: DeployEnv,
    profile_id: str,
    *,
    production: bool = True,
    task_id: str = "task_1",
    run_id: str = "run_1",
    approve: bool = True,
) -> str:
    a = await denv.approvals.request(
        ApprovalRequest(
            kind=ApprovalKind.deploy,
            title="Deploy onayı",
            production=production,
            task_id=task_id,
            run_id=run_id,
            payload={"profiles": [{"profile_id": profile_id}]},
        )
    )
    await denv.approvals.decide(a.id, approve=approve, decided_by="user")
    return a.id


async def test_gate_approval_is_used_once_without_asking_again(denv: DeployEnv, tmp_path: Path) -> None:
    marker = tmp_path / "deployed"
    profile = await denv.profile(environment=Environment.production, config={"command": f"touch {marker}"})
    apr = await gate_approval(denv, profile.id)
    result = await denv.svc.deploy(
        profile.id, ref="main", actor="engine", task_id="task_1", run_id="run_1", approval_id=apr
    )
    assert result.status == "succeeded" and marker.exists()
    assert await denv.approvals.list(status=ApprovalStatus.pending) == []
    run = (await denv.svc.list_runs(profile_id=profile.id))[0]
    assert run.approval_id == apr

    # Reusing the same approval for a second deploy must ask again.
    second = asyncio.create_task(
        denv.svc.deploy(profile.id, ref="main", actor="engine", task_id="task_1", run_id="run_1", approval_id=apr)
    )
    fresh = await denv.next_pending()
    assert fresh.id != apr and fresh.production
    await denv.approvals.decide(fresh.id, approve=False, decided_by="user")
    assert (await second).status == "rejected"


async def test_mismatched_gate_approvals_are_ignored(denv: DeployEnv, tmp_path: Path) -> None:
    profile = await denv.profile(environment=Environment.production, config={"command": "true"})
    other = await denv.profile(environment=Environment.production, config={"command": "true"})
    cases = [
        await gate_approval(denv, other.id),  # different profile
        await gate_approval(denv, profile.id, production=False),  # not production-grade
        await gate_approval(denv, profile.id, run_id="run_other"),  # different run
        await gate_approval(denv, profile.id, approve=False),  # rejected
    ]
    for apr in cases:
        task = asyncio.create_task(
            denv.svc.deploy(profile.id, ref="main", actor="engine", task_id="task_1", run_id="run_1", approval_id=apr)
        )
        fresh = await denv.next_pending()
        assert fresh.id not in cases
        await denv.approvals.decide(fresh.id, approve=False, decided_by="user")
        assert (await task).status == "rejected"


async def test_stale_gate_approval_is_ignored(denv: DeployEnv) -> None:
    profile = await denv.profile(environment=Environment.production, config={"command": "true"})
    apr = await gate_approval(denv, profile.id)
    async with denv.ctx.db.begin() as conn:
        await conn.execute(
            sa.update(approvals_t).where(approvals_t.c.id == apr).values(decided_at=utcnow() - timedelta(hours=2))
        )
    task = asyncio.create_task(
        denv.svc.deploy(profile.id, ref="main", actor="engine", task_id="task_1", run_id="run_1", approval_id=apr)
    )
    fresh = await denv.next_pending()
    assert fresh.id != apr
    await denv.approvals.decide(fresh.id, approve=False, decided_by="user")
    assert (await task).status == "rejected"
