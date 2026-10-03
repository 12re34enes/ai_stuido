from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from remote_testlib import FakeRunner, RemoteEnv, SshServer, start_ssh_server

from aistudio.api.app import setup_modules
from aistudio.approvals.module import ApprovalsModule
from aistudio.contracts.approvals import ApprovalService
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.context import AppContext
from aistudio.deploy.module import DeployModule
from aistudio.remote.models import HostRecord
from aistudio.remote.module import RemoteModule
from aistudio.tools.module import ToolsModule


@pytest.fixture(autouse=True)
def user_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Never touch the developer's ~/.ssh or ssh-agent."""
    home = tmp_path / "userhome"
    (home / ".ssh").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.delenv("SSH_AUTH_SOCK", raising=False)
    return home


@pytest.fixture
async def renv(ctx: AppContext) -> AsyncIterator[RemoteEnv]:
    mods = [ApprovalsModule(), ToolsModule(), RemoteModule(), DeployModule()]
    await setup_modules(ctx, mods)
    await ctx.db.create_all()
    for m in mods:
        await m.start(ctx)
    remote = mods[2]
    assert isinstance(remote, RemoteModule) and remote.svc is not None
    env = RemoteEnv(
        ctx=ctx,
        svc=remote.svc,
        approvals=ctx.services.get(ApprovalService),  # type: ignore[type-abstract]
        tools=ctx.services.get(ToolRegistry),  # type: ignore[type-abstract]
    )
    env.svc.approval_timeout = 30
    yield env
    for m in reversed(mods):
        await m.stop()


@pytest.fixture
def fake_runner(renv: RemoteEnv) -> FakeRunner:
    runner = FakeRunner()

    async def factory(host: HostRecord) -> FakeRunner:
        return runner

    renv.svc.runner_factory = factory
    return runner


@pytest.fixture
async def ssh_server(tmp_path: Path, renv: RemoteEnv) -> AsyncIterator[SshServer]:
    server = await start_ssh_server(tmp_path / "sshd")
    yield server
    await renv.svc.pool.close()  # close client connections first so the server shuts down at once
    await server.close()
