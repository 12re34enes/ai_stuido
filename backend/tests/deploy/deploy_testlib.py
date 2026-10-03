"""Fakes for deploy tests: GitHostingService, RemoteService/Transport and an env wrapper."""

from __future__ import annotations

import asyncio
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from aistudio.contracts.approvals import Approval, ApprovalService, ApprovalStatus
from aistudio.contracts.common import Environment, PermissionLevel
from aistudio.contracts.git_hosting import CheckRun
from aistudio.contracts.remote import Host
from aistudio.contracts.tools import ToolRegistry
from aistudio.contracts.transport import CompletedProcess
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound
from aistudio.core.events import Event, EventFilter
from aistudio.deploy.models import DeployProfileCreate
from aistudio.deploy.service import DeployServiceImpl


class FakeGitHosting:
    def __init__(self) -> None:
        self.triggered: list[dict[str, Any]] = []
        self.states: list[CheckRun] = [
            CheckRun(name="deploy", status="queued"),
            CheckRun(name="deploy", status="in_progress"),
            CheckRun(name="deploy", status="completed", conclusion="success", url="https://ci.example/run/1"),
        ]
        self._iter: Iterator[CheckRun] | None = None

    async def trigger_pipeline(
        self, repo_id: str, *, ref: str, workflow: str | None = None, variables: dict[str, str] | None = None
    ) -> str:
        self.triggered.append({"repo_id": repo_id, "ref": ref, "workflow": workflow, "variables": variables})
        self._iter = iter(self.states)
        return "run-1"

    async def pipeline_status(self, repo_id: str, run_id: str) -> CheckRun:
        assert self._iter is not None
        try:
            return next(self._iter)
        except StopIteration:
            return self.states[-1]


class FakeTransport:
    kind = "ssh"

    def __init__(self, remote: FakeRemote, host_id: str) -> None:
        self.remote = remote
        self.host_id: str | None = host_id

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        assert self.host_id is not None
        self.remote.calls.append({"host": self.host_id, "argv": argv, "cwd": cwd, "input": input})
        self.remote.active += 1
        self.remote.max_active = max(self.remote.max_active, self.remote.active)
        try:
            await asyncio.sleep(self.remote.delay)
        finally:
            self.remote.active -= 1
        code = self.remote.exit_codes.get(self.host_id, 0)
        return CompletedProcess(argv=argv, returncode=code, stdout=f"ran on {self.host_id}\n", stderr="", duration_ms=1)


class FakeRemote:
    """RemoteService stand-in (get_host + transport)."""

    def __init__(self) -> None:
        self.hosts: dict[str, Host] = {}
        self.calls: list[dict[str, Any]] = []
        self.exit_codes: dict[str, int] = {}
        self.delay = 0.0
        self.active = 0
        self.max_active = 0

    def add(
        self,
        host_id: str,
        *,
        environment: Environment = Environment.test,
        level: PermissionLevel = PermissionLevel.full,
    ) -> Host:
        host = Host(
            id=host_id,
            name=host_id,
            hostname=f"{host_id}.example",
            username="deploy",
            environment=environment,
            permission_level=level,
            created_at=utcnow(),
        )
        self.hosts[host_id] = host
        return host

    async def get_host(self, host_id: str) -> Host:
        try:
            return self.hosts[host_id]
        except KeyError:
            raise NotFound("Host bulunamadı.") from None

    async def transport(self, host_id: str) -> FakeTransport:
        await self.get_host(host_id)
        return FakeTransport(self, host_id)


@dataclass
class DeployEnv:
    ctx: AppContext
    svc: DeployServiceImpl
    approvals: ApprovalService
    tools: ToolRegistry
    remote: FakeRemote
    hosting: FakeGitHosting
    created: list[str] = field(default_factory=list)

    async def profile(self, **kw: Any) -> Any:
        defaults: dict[str, Any] = {
            "workspace_id": "ws_test",
            "name": f"profile-{len(self.created)}",
            "kind": "command",
            "environment": Environment.test,
            "config": {"command": "echo deployed"},
        }
        defaults.update(kw)
        profile = await self.svc.create_profile(DeployProfileCreate(**defaults))
        self.created.append(profile.id)
        return profile

    async def next_pending(self, timeout: float = 5.0) -> Approval:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            pending = await self.approvals.list(status=ApprovalStatus.pending)
            if pending:
                return pending[-1]
            if loop.time() > deadline:
                raise AssertionError("no pending approval appeared")
            await asyncio.sleep(0.01)

    async def decide_next(self, approve: bool = True, note: str | None = None) -> Approval:
        pending = await self.next_pending()
        return await self.approvals.decide(pending.id, approve=approve, note=note, decided_by="user")

    def auto_decide(self, approve: bool = True, note: str | None = None) -> asyncio.Task[Approval]:
        return asyncio.create_task(self.decide_next(approve=approve, note=note))

    async def events(self, *types: str) -> list[Event]:
        return await self.ctx.events.query(EventFilter(types=list(types)), limit=1000)
