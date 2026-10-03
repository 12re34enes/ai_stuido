"""Static protocol conformance (checked by pyright): registrations use ``# type: ignore[type-abstract]``,
which would also hide a mismatch, so the assignments below make pyright verify the shapes."""

from __future__ import annotations

from pathlib import Path

from engine_fakes import (
    FakeAgentManager,
    FakeDeployService,
    FakeGitHosting,
    FakeHandle,
    FakeLimitService,
    FakeMemoryService,
    FakeStudioService,
    FakeWorktreeManager,
)

from aistudio.contracts.agents import AgentManager, AgentSessionHandle
from aistudio.contracts.deploy import DeployService
from aistudio.contracts.engine import FlowEngine
from aistudio.contracts.git_hosting import GitHostingService
from aistudio.contracts.gitops import WorktreeManager
from aistudio.contracts.limits import LimitService
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.studios import StudioService
from aistudio.contracts.tools import StudioTool
from aistudio.core.context import AppContext
from aistudio.engine.service import FlowEngineImpl
from aistudio.engine.tools import engine_tools


def _conformance(ctx: AppContext, base: Path, handle: FakeHandle) -> None:
    engine: FlowEngine = FlowEngineImpl(ctx)
    assert isinstance(engine, FlowEngineImpl)
    tools: list[StudioTool] = list(engine_tools(engine))
    assert tools
    worktrees: WorktreeManager = FakeWorktreeManager(base)
    agents: AgentManager = FakeAgentManager()
    live: AgentSessionHandle = handle
    memory: MemoryService = FakeMemoryService()
    limits: LimitService = FakeLimitService()
    hosting: GitHostingService = FakeGitHosting()
    deploy: DeployService = FakeDeployService()
    studios: StudioService = FakeStudioService()
    assert all(x is not None for x in (worktrees, agents, live, memory, limits, hosting, deploy, studios))


def test_engine_registers_flow_engine_and_tools(ctx: AppContext) -> None:
    impl = FlowEngineImpl(ctx)
    names = [t.spec.name for t in engine_tools(impl)]
    assert names == ["ask_user", "report_status", "handoff", "evidence_submit"]
    assert all(not t.spec.mutating for t in engine_tools(impl))
    assert callable(_conformance)
