from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from deploy_testlib import DeployEnv, FakeGitHosting, FakeRemote

from aistudio.api.app import setup_modules
from aistudio.approvals.module import ApprovalsModule
from aistudio.contracts.approvals import ApprovalService
from aistudio.contracts.git_hosting import GitHostingService
from aistudio.contracts.remote import RemoteService
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.context import AppContext
from aistudio.deploy.module import DeployModule
from aistudio.tools.module import ToolsModule


@pytest.fixture
async def denv(ctx: AppContext) -> AsyncIterator[DeployEnv]:
    remote, hosting = FakeRemote(), FakeGitHosting()
    ctx.services.register(RemoteService, remote)  # type: ignore[type-abstract]
    ctx.services.register(GitHostingService, hosting)  # type: ignore[type-abstract]
    mods = [ApprovalsModule(), ToolsModule(), DeployModule()]
    await setup_modules(ctx, mods)
    await ctx.db.create_all()
    for m in mods:
        await m.start(ctx)
    deploy = mods[2]
    assert isinstance(deploy, DeployModule) and deploy.svc is not None
    env = DeployEnv(
        ctx=ctx,
        svc=deploy.svc,
        approvals=ctx.services.get(ApprovalService),  # type: ignore[type-abstract]
        tools=ctx.services.get(ToolRegistry),  # type: ignore[type-abstract]
        remote=remote,
        hosting=hosting,
    )
    env.svc.approval_timeout = 30
    yield env
    for m in reversed(mods):
        await m.stop()
