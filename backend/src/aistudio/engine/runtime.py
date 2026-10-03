"""Shared engine runtime: service lookup, settings, concurrency limits and event helpers."""

from __future__ import annotations

import asyncio
from typing import Any

from aistudio.contracts.agents import AgentManager
from aistudio.contracts.approvals import ApprovalService
from aistudio.contracts.common import Provider
from aistudio.contracts.deploy import DeployService
from aistudio.contracts.git_hosting import GitHostingService
from aistudio.contracts.gitops import WorktreeManager
from aistudio.contracts.limits import Budget, LimitPolicy, LimitService
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.studios import StudioService
from aistudio.contracts.tools import ToolRegistry
from aistudio.contracts.workspaces import WorkspaceService
from aistudio.core.context import AppContext
from aistudio.core.errors import Unavailable
from aistudio.core.events import Event, Severity
from aistudio.engine.store import EngineStore

SETTINGS_DEFAULTS: dict[str, Any] = {
    "engine.max_concurrent_runs": 3,
    "engine.max_sessions_per_provider": {"claude": 4, "codex": 4},
    "engine.default_provider": "claude",
    "engine.limit_poll_seconds": 60,
    "engine.command_timeout_seconds": 1800,
    "engine.scheduler_interval_seconds": 30,
    "engine.turn_timeout_minutes": 0,  # 0 = unlimited
}


class EngineRuntime:
    """Everything node implementations need, without importing other feature modules."""

    def __init__(self, ctx: AppContext, store: EngineStore) -> None:
        self.ctx = ctx
        self.store = store
        self._provider_slots: dict[str, asyncio.Semaphore] = {}

    # ------------------------------------------------------------------ settings
    async def setting(self, key: str) -> Any:
        value = await self.ctx.store.get(key)
        return SETTINGS_DEFAULTS.get(key) if value is None else value

    async def int_setting(self, key: str) -> int:
        value = await self.setting(key)
        try:
            return int(value)
        except (TypeError, ValueError):
            return int(SETTINGS_DEFAULTS[key])

    async def float_setting(self, key: str) -> float:
        value = await self.setting(key)
        try:
            return float(value)
        except (TypeError, ValueError):
            return float(SETTINGS_DEFAULTS[key])

    async def default_budget(self) -> Budget:
        """Settings → Limitler: the budget for tasks whose task and flow set none."""
        try:
            return Budget.model_validate(await self.ctx.store.get("limits.default_budget") or {})
        except ValueError:
            return Budget()

    async def default_limit_policy(self) -> LimitPolicy:
        """Settings → Limitler: the exhaustion policy of mode templates (flows carry their own)."""
        try:
            value = await self.ctx.store.get("limits.on_exhausted")
            return LimitPolicy(on_exhausted=value) if value else LimitPolicy()
        except ValueError:
            return LimitPolicy()

    async def provider_slot(self, provider: Provider) -> asyncio.Semaphore:
        sem = self._provider_slots.get(provider)
        if sem is None:
            limits = await self.setting("engine.max_sessions_per_provider")
            size = 4
            if isinstance(limits, dict):
                try:
                    size = max(1, int(limits.get(provider, 4)))  # type: ignore[arg-type]
                except (TypeError, ValueError):
                    size = 4
            sem = asyncio.Semaphore(size)
            self._provider_slots[provider] = sem
        return sem

    # ------------------------------------------------------------------ services
    def approvals(self) -> ApprovalService:
        svc = self.ctx.services.maybe(ApprovalService)  # type: ignore[type-abstract]
        if svc is None:
            raise Unavailable("Onay servisi hazır değil.")
        return svc

    def agents(self) -> AgentManager:
        svc = self.ctx.services.maybe(AgentManager)  # type: ignore[type-abstract]
        if svc is None:
            raise Unavailable("Ajan yöneticisi hazır değil; ajan çalıştıran düğüm başlatılamadı.")
        return svc

    def maybe_agents(self) -> AgentManager | None:
        return self.ctx.services.maybe(AgentManager)  # type: ignore[type-abstract]

    def worktrees(self) -> WorktreeManager:
        svc = self.ctx.services.maybe(WorktreeManager)  # type: ignore[type-abstract]
        if svc is None:
            raise Unavailable("Worktree yöneticisi hazır değil; kod yazan düğüm çalıştırılamadı.")
        return svc

    def maybe_worktrees(self) -> WorktreeManager | None:
        return self.ctx.services.maybe(WorktreeManager)  # type: ignore[type-abstract]

    def workspaces(self) -> WorkspaceService:
        svc = self.ctx.services.maybe(WorkspaceService)  # type: ignore[type-abstract]
        if svc is None:
            raise Unavailable("Çalışma alanı servisi hazır değil.")
        return svc

    def memory(self) -> MemoryService | None:
        return self.ctx.services.maybe(MemoryService)  # type: ignore[type-abstract]

    def limits(self) -> LimitService | None:
        return self.ctx.services.maybe(LimitService)  # type: ignore[type-abstract]

    def git_hosting(self) -> GitHostingService | None:
        return self.ctx.services.maybe(GitHostingService)  # type: ignore[type-abstract]

    def deploy(self) -> DeployService | None:
        return self.ctx.services.maybe(DeployService)  # type: ignore[type-abstract]

    def studios(self) -> StudioService | None:
        return self.ctx.services.maybe(StudioService)  # type: ignore[type-abstract]

    def tools(self) -> ToolRegistry | None:
        return self.ctx.services.maybe(ToolRegistry)  # type: ignore[type-abstract]

    # ------------------------------------------------------------------ events
    async def emit(
        self,
        type: str,
        payload: dict[str, Any],
        *,
        severity: Severity = Severity.info,
        workspace_id: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        session_id: str | None = None,
        actor: str = "system",
    ) -> Event:
        return await self.ctx.events.append(
            type,
            payload,
            severity=severity,
            actor=actor,
            workspace_id=workspace_id,
            task_id=task_id,
            run_id=run_id,
            session_id=session_id,
        )

    def mask(self, text: str | None) -> str | None:
        return None if text is None else self.ctx.masker.mask(text)
