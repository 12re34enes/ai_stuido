"""Helpers for engine tests: an AppContext with the real approval/workspace/tool services, fakes for
everything else, and the engine module set up on top (fixtures live in ``conftest.py``)."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from engine_fakes import (
    FakeAgentManager,
    FakeDeployService,
    FakeGitHosting,
    FakeLimitService,
    FakeMemoryService,
    FakeStudioService,
    FakeWorktreeManager,
)

from aistudio.approvals.service import ApprovalServiceImpl
from aistudio.contracts.agents import AgentManager
from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalService, ApprovalStatus
from aistudio.contracts.deploy import DeployService
from aistudio.contracts.engine import Run, Task, TaskCreate
from aistudio.contracts.flows import FlowGraph, FlowMode
from aistudio.contracts.git_hosting import GitHostingService
from aistudio.contracts.gitops import WorktreeManager
from aistudio.contracts.limits import LimitService
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.studios import StudioService
from aistudio.contracts.tools import ToolRegistry
from aistudio.contracts.workspaces import Repo, RepoCommands, Workspace, WorkspaceService
from aistudio.core.context import AppContext
from aistudio.core.events import Event, EventFilter
from aistudio.engine.module import EngineModule
from aistudio.engine.service import FlowEngineImpl
from aistudio.tools.registry import ToolRegistryImpl
from aistudio.workspaces.service import RepoCreate, WorkspaceCreate, WorkspaceServiceImpl

FINDINGS_PASS = '```json\n{"verdict": "pass", "summary": "Temiz.", "findings": []}\n```'


def findings_json(*items: tuple[str, str], verdict: str = "fail") -> str:
    body = ", ".join(
        f'{{"severity": "{sev}", "file": "app.py", "line": {i + 1}, "message": "{msg}"}}'
        for i, (sev, msg) in enumerate(items)
    )
    return (
        f'İnceleme tamam.\n\n```json\n{{"verdict": "{verdict}", "summary": "Bulgular var.", "findings": [{body}]}}\n```'
    )


@dataclass
class EngineEnv:
    ctx: AppContext
    module: EngineModule
    engine: FlowEngineImpl
    approvals: ApprovalServiceImpl
    workspaces: WorkspaceServiceImpl
    tools: ToolRegistryImpl
    agents: FakeAgentManager
    worktrees: FakeWorktreeManager
    memory: FakeMemoryService
    limits: FakeLimitService
    hosting: FakeGitHosting
    deploy: FakeDeployService
    studios: FakeStudioService
    workspace: Workspace
    repo: Repo
    decided: list[str] = field(default_factory=list)

    async def create(
        self,
        mode: FlowMode = FlowMode.single,
        *,
        graph: FlowGraph | None = None,
        prompt: str = "README'ye kurulum bölümü ekle",
        start: bool = True,
        **kw: Any,
    ) -> Task:
        return await self.engine.create_task(
            TaskCreate(
                workspace_id=self.workspace.id,
                title=kw.pop("title", "Kurulum belgesi"),
                prompt=prompt,
                mode=mode,
                graph=graph,
                start=start,
                **kw,
            )
        )

    async def run_of(self, task_id: str, timeout: float = 5.0) -> str:
        async def check() -> str | None:
            return (await self.engine.get_task(task_id)).current_run_id

        return await wait_for(check, timeout)

    async def wait_run(
        self, run_id: str, statuses: tuple[str, ...] = ("completed", "failed", "cancelled"), timeout: float = 10.0
    ) -> Run:
        async def check() -> Run | None:
            run = await self.engine.get_run(run_id)
            return run if run.status in statuses else None

        return await wait_for(check, timeout)

    async def wait_node(self, run_id: str, node_id: str, statuses: tuple[str, ...], timeout: float = 5.0) -> None:
        async def check() -> bool | None:
            run = await self.engine.get_run(run_id)
            latest = [n for n in run.nodes if n.node_id == node_id]
            return True if latest and latest[-1].status in statuses else None

        await wait_for(check, timeout)

    async def next_approval(
        self, kind: ApprovalKind | None = None, timeout: float = 5.0, *, run_id: str | None = None
    ) -> Approval:
        async def check() -> Approval | None:
            for a in reversed(await self.approvals.list(status=ApprovalStatus.pending)):
                matching = (kind is None or a.kind == kind) and (run_id is None or a.run_id == run_id)
                if matching and a.id not in self.decided:
                    return a
            return None

        return await wait_for(check, timeout)

    async def decide(
        self,
        kind: ApprovalKind | None = None,
        *,
        approve: bool = True,
        payload: dict[str, Any] | None = None,
        note: str | None = None,
        run_id: str | None = None,
    ) -> Approval:
        a = await self.next_approval(kind, run_id=run_id)
        self.decided.append(a.id)
        return await self.approvals.decide(a.id, approve=approve, note=note, decision_payload=payload)

    async def events(self, run_id: str | None = None, types: list[str] | None = None) -> list[Event]:
        return await self.ctx.events.query(EventFilter(run_id=run_id, types=types), limit=5000)


async def wait_for(check: Callable[[], Any], timeout: float = 5.0, interval: float = 0.01) -> Any:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while True:
        value = await check()
        if value is not None and value is not False:
            return value
        if loop.time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(interval)


async def build_env(
    ctx: AppContext, git_repo: Path, tmp_path: Path, *, register: bool = True, fakes: EngineEnv | None = None
) -> EngineEnv:
    """Set up services + engine on ``ctx``. With ``fakes`` the given fake instances are reused (restart tests)."""
    approvals = ApprovalServiceImpl(ctx.db, ctx.events, ctx.store)
    workspaces = WorkspaceServiceImpl(ctx.db, ctx.events)
    tools = ToolRegistryImpl(ctx.events)
    worktrees = fakes.worktrees if fakes else FakeWorktreeManager(tmp_path / "worktrees")
    agents = fakes.agents if fakes else FakeAgentManager(worktrees)
    memory = fakes.memory if fakes else FakeMemoryService()
    limits = fakes.limits if fakes else FakeLimitService()
    hosting = fakes.hosting if fakes else FakeGitHosting()
    deploy = fakes.deploy if fakes else FakeDeployService()
    studios = fakes.studios if fakes else FakeStudioService()
    services = ctx.services
    services.register(ApprovalService, approvals)  # type: ignore[type-abstract]
    services.register(WorkspaceService, workspaces)  # type: ignore[type-abstract]
    services.register(ToolRegistry, tools)  # type: ignore[type-abstract]
    if register:
        services.register(AgentManager, agents)  # type: ignore[type-abstract]
        services.register(WorktreeManager, worktrees)  # type: ignore[type-abstract]
        services.register(MemoryService, memory)  # type: ignore[type-abstract]
        services.register(LimitService, limits)  # type: ignore[type-abstract]
        services.register(GitHostingService, hosting)  # type: ignore[type-abstract]
        services.register(DeployService, deploy)  # type: ignore[type-abstract]
        services.register(StudioService, studios)  # type: ignore[type-abstract]
    module = EngineModule()
    await module.setup(ctx)
    await ctx.db.create_all()
    await ctx.store.set("engine.limit_poll_seconds", 0.02)
    assert module.engine is not None
    if fakes is not None:
        workspace, repo = fakes.workspace, fakes.repo
    else:
        workspace = await workspaces.create(WorkspaceCreate(name="Deneme Alanı"))
        repo = await workspaces.add_repo(
            workspace.id, RepoCreate(path=str(git_repo), commands=RepoCommands(lint="ruff check", test="pytest -q"))
        )
    await module.engine.startup(run_scheduler=False)
    return EngineEnv(
        ctx=ctx,
        module=module,
        engine=module.engine,
        approvals=approvals,
        workspaces=workspaces,
        tools=tools,
        agents=agents,
        worktrees=worktrees,
        memory=memory,
        limits=limits,
        hosting=hosting,
        deploy=deploy,
        studios=studios,
        workspace=workspace,
        repo=repo,
    )


def writes(env: EngineEnv, *paths: str, reply: str = "Değişiklikleri yaptım.") -> Callable[..., str]:
    """Responder that touches files in the session's worktree."""

    def respond(session: Any, _message: str) -> str:
        wid = session.req.worktree_id
        if wid:
            env.worktrees.touch(wid, *paths)
        return reply

    return respond


def make_settings(home: Path) -> Any:
    from aistudio.core.config import Paths, Settings

    return Settings(paths=Paths(home), dev=True, dev_token="t", allowed_origins=("tauri://localhost",))
