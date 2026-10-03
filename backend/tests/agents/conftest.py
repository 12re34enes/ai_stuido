"""Fixtures for agents tests: a context with the foundation modules, agents and limits set up and
fake adapters registered."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from agents_fakes import AgentsEnv, FakeAdapter, start_modules

from aistudio.agents.manager import AgentManagerImpl
from aistudio.agents.module import AgentsModule
from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.approvals.module import ApprovalsModule
from aistudio.contracts.agents import AdapterRegistry, AgentManager
from aistudio.contracts.approvals import ApprovalService
from aistudio.contracts.workspaces import RepoCommands
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.limits.module import LimitsModule
from aistudio.tools.module import ToolsModule
from aistudio.workspaces.module import WorkspacesModule
from aistudio.workspaces.service import RepoCreate, WorkspaceCreate, WorkspaceServiceImpl


@pytest.fixture
async def agents_env(ctx: AppContext, git_repo: Path) -> AsyncIterator[AgentsEnv]:
    modules: list[Module] = [WorkspacesModule(), ApprovalsModule(), ToolsModule(), AgentsModule(), LimitsModule()]
    await start_modules(ctx, modules)
    registry = ctx.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry, AdapterRegistryImpl)
    claude, codex = FakeAdapter("claude"), FakeAdapter("codex")
    registry.replace(claude)
    registry.replace(codex)
    manager = ctx.services.get(AgentManager)  # type: ignore[type-abstract]
    assert isinstance(manager, AgentManagerImpl)
    workspaces = ctx.services.get(WorkspaceServiceImpl)
    ws = await workspaces.create(WorkspaceCreate(name="Ajan Testi"))
    await workspaces.add_repo(
        ws.id, RepoCreate(path=str(git_repo), commands=RepoCommands(test="pytest -q", lint="ruff check ."))
    )
    env = AgentsEnv(
        ctx=ctx,
        modules=modules,
        manager=manager,
        approvals=ctx.services.get(ApprovalService),  # type: ignore[type-abstract]
        registry=registry,
        claude=claude,
        codex=codex,
        workspace_id=ws.id,
        cwd=git_repo,
    )
    yield env
    for m in reversed(modules):
        await m.stop()
