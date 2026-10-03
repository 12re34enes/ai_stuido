"""In-memory fakes of the services the engine consumes (agents, worktrees, memory, limits, hosting, deploy,
studios). They satisfy the contract Protocols structurally so they can be registered in a test context."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from aistudio.contracts.agents import (
    AdapterHealth,
    AgentProfile,
    AgentState,
    Boundaries,
    NativeSessionInfo,
    SessionRecord,
    StartSessionRequest,
    TurnResult,
)
from aistudio.contracts.common import Environment, Location, Provider
from aistudio.contracts.deploy import DeployProfile, DeployResult
from aistudio.contracts.flows import FlowGraph
from aistudio.contracts.git_hosting import CheckRun, PullRequestRef, PullRequestStatus
from aistudio.contracts.gitops import (
    Checkpoint,
    DiffResult,
    FileDiff,
    FileOverlap,
    MergePreview,
    MergeResult,
    Worktree,
)
from aistudio.contracts.limits import Budget, BudgetCheck, LimitWindow, UsageTotals
from aistudio.contracts.memory import MemoryDoc, MemoryLayer, MemoryProposal
from aistudio.contracts.studios import Studio
from aistudio.core.clock import utcnow
from aistudio.core.errors import NotFound
from aistudio.core.ids import new_id

# --------------------------------------------------------------------------- agents


@dataclass
class FakeSession:
    record: SessionRecord
    req: StartSessionRequest
    messages: list[str] = field(default_factory=list)
    results: list[TurnResult] = field(default_factory=list)
    interrupted: bool = False
    closed: int = 0

    @property
    def id(self) -> str:
        return self.record.id

    @property
    def node_id(self) -> str | None:
        return self.req.node_id

    @property
    def provider(self) -> Provider:
        return self.req.spec.provider

    @property
    def role(self) -> str:
        return self.req.spec.role

    @property
    def last_message(self) -> str:
        return self.messages[-1] if self.messages else ""

    @property
    def turn_index(self) -> int:
        return len(self.messages) - 1


Reply = str | TurnResult
Responder = Callable[[FakeSession, str], Reply | Awaitable[Reply]]


@dataclass
class _Rule:
    responder: Responder
    node_id: str | None = None
    role: str | None = None
    provider: str | None = None
    label_contains: str | None = None

    def matches(self, s: FakeSession) -> bool:
        return (
            (self.node_id is None or s.node_id == self.node_id)
            and (self.role is None or s.role == self.role)
            and (self.provider is None or s.provider == self.provider)
            and (self.label_contains is None or self.label_contains in (s.req.label or ""))
        )


class FakeHandle:
    def __init__(self, mgr: FakeAgentManager, session: FakeSession) -> None:
        self._mgr = mgr
        self._s = session
        self._current: asyncio.Task[TurnResult] | None = None
        self._turns: dict[str, asyncio.Task[TurnResult]] = {}
        self._state = AgentState.idle

    @property
    def native_id(self) -> str | None:
        return self._s.record.native_id

    @property
    def state(self) -> AgentState:
        return self._state

    async def send(self, text: str) -> str:
        turn_id = new_id("turn")
        self._s.messages.append(text)
        self._state = AgentState.thinking
        task = asyncio.create_task(self._mgr._respond(self._s, text, turn_id, self))
        self._turns[turn_id] = task
        self._current = task
        return turn_id

    async def steer(self, text: str) -> None:
        self._s.messages.append(f"[steer] {text}")

    async def interrupt(self) -> None:
        self._s.interrupted = True
        self._mgr.interrupted.append(self._s.id)
        if self._current is not None and not self._current.done():
            self._current.cancel()
        self._state = AgentState.interrupted

    async def wait_turn(self, turn_id: str | None = None, timeout: float | None = None) -> TurnResult:
        task = self._turns.get(turn_id) if turn_id else self._current
        if task is None:
            if self._s.results:
                return self._s.results[-1]
            raise RuntimeError("no turn to wait for")
        try:
            return await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
        except asyncio.CancelledError:
            if task.cancelled():
                return TurnResult(turn_id=turn_id or "", status="interrupted")
            raise

    async def close(self) -> None:
        self._s.closed += 1
        self._state = AgentState.done

    def set_state(self, state: AgentState) -> None:
        self._state = state


class FakeAgentManager:
    """Scripted agent sessions. Register responders with ``on(...)``; the first matching rule answers."""

    def __init__(self, worktrees: FakeWorktreeManager | None = None) -> None:
        self.worktrees = worktrees
        self.sessions: dict[str, FakeSession] = {}
        self.handles: dict[str, FakeHandle] = {}
        self.profiles: dict[str, AgentProfile] = {}
        self.rules: list[_Rule] = []
        self.default_reply = "Tamamlandı."
        self.interrupted: list[str] = []
        self.concurrent = 0
        self.max_concurrent = 0
        self.handle_calls: list[str] = []

    def on(
        self,
        responder: Responder | str,
        *,
        node_id: str | None = None,
        role: str | None = None,
        provider: str | None = None,
        label_contains: str | None = None,
    ) -> None:
        resp: Responder = (lambda _s, _m, text=responder: text) if isinstance(responder, str) else responder
        self.rules.insert(0, _Rule(resp, node_id=node_id, role=role, provider=provider, label_contains=label_contains))

    def by_node(self, node_id: str) -> list[FakeSession]:
        return [s for s in self.sessions.values() if s.node_id == node_id]

    async def _respond(self, s: FakeSession, text: str, turn_id: str, handle: FakeHandle) -> TurnResult:
        self.concurrent += 1
        self.max_concurrent = max(self.max_concurrent, self.concurrent)
        try:
            rule = next((r for r in self.rules if r.matches(s)), None)
            reply: Any = self.default_reply if rule is None else rule.responder(s, text)
            if inspect.isawaitable(reply):
                reply = await reply
            result = (
                reply.model_copy(update={"turn_id": turn_id})
                if isinstance(reply, TurnResult)
                else TurnResult(turn_id=turn_id, status="success", text=str(reply))
            )
            s.results.append(result)
            handle.set_state(AgentState.idle)
            return result
        finally:
            self.concurrent -= 1

    # -- AgentManager protocol
    async def start_session(self, req: StartSessionRequest) -> SessionRecord:
        now = utcnow()
        record = SessionRecord(
            id=new_id("sess"),
            workspace_id=req.workspace_id,
            provider=req.spec.provider,
            profile_id=req.profile_id,
            native_id=new_id("native"),
            cwd=req.spec.cwd,
            worktree_id=req.worktree_id,
            task_id=req.task_id,
            run_id=req.run_id,
            node_id=req.node_id,
            label=req.label,
            role=req.spec.role,
            model=req.spec.model,
            state=AgentState.starting,
            created_at=now,
            updated_at=now,
        )
        session = FakeSession(record=record, req=req)
        self.sessions[record.id] = session
        handle = FakeHandle(self, session)
        self.handles[record.id] = handle
        if req.initial_prompt is not None:
            await handle.send(req.initial_prompt)
        return record

    async def handle(self, session_id: str) -> FakeHandle:
        self.handle_calls.append(session_id)
        if session_id not in self.handles:
            raise NotFound("Oturum bulunamadı.")
        return self.handles[session_id]

    async def get(self, session_id: str) -> SessionRecord:
        return self.sessions[session_id].record

    async def list(
        self, *, workspace_id: str | None = None, run_id: str | None = None, active_only: bool = False
    ) -> list[SessionRecord]:
        out = []
        for s in self.sessions.values():
            if run_id is not None and s.record.run_id != run_id:
                continue
            if active_only and self.handles[s.id].state not in (AgentState.thinking, AgentState.running_tool):
                continue
            out.append(s.record)
        return out

    async def health(self) -> list[AdapterHealth]:
        return []

    async def discover(self, location: Location, *, cwd: str | None = None) -> list[NativeSessionInfo]:
        return []

    async def import_native(self, workspace_id: str, info: NativeSessionInfo) -> SessionRecord:
        raise NotImplementedError

    async def resolve_profile(self, profile_id: str) -> AgentProfile:
        if profile_id not in self.profiles:
            raise NotFound("Profil bulunamadı.")
        return self.profiles[profile_id]

    def add_profile(self, profile_id: str, provider: Provider, **kw: Any) -> AgentProfile:
        profile = AgentProfile(id=profile_id, name=kw.pop("name", profile_id), provider=provider, **kw)
        self.profiles[profile_id] = profile
        return profile


# --------------------------------------------------------------------------- worktrees


CommandScript = Callable[[str, str, int], tuple[int, str]]


class FakeWorktreeManager:
    def __init__(self, base: Path) -> None:
        self.base = base
        self.worktrees: dict[str, Worktree] = {}
        self.changes: dict[str, set[str]] = {}
        self.committed: dict[str, set[str]] = {}
        self.commits: list[tuple[str, str]] = []
        self.conflicts: dict[str, list[str]] = {}
        self.merges: list[dict[str, Any]] = []
        self.pushes: list[dict[str, Any]] = []
        self.removed: list[str] = []
        self.commands: list[tuple[str, str]] = []
        self.command_script: CommandScript | None = None
        self.checkpoints: dict[str, Checkpoint] = {}
        self.restored: list[str] = []
        self._counter = 0

    def touch(self, worktree_id: str, *paths: str) -> None:
        self.changes.setdefault(worktree_id, set()).update(paths)

    def revert(self, worktree_id: str, *paths: str) -> None:
        for p in paths:
            self.changes.get(worktree_id, set()).discard(p)

    async def create(
        self,
        repo_id: str,
        *,
        base_ref: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        label: str = "agent",
        location: Location | None = None,
    ) -> Worktree:
        self._counter += 1
        wid = new_id("wt")
        path = self.base / wid
        path.mkdir(parents=True, exist_ok=True)
        wt = Worktree(
            id=wid,
            repo_id=repo_id,
            workspace_id="ws",
            path=str(path),
            branch=f"aistudio/{task_id or 'task'}/{label}-{self._counter}",
            base_ref=base_ref or "main",
            base_sha="base000",
            run_id=run_id,
            task_id=task_id,
            label=label,
            created_at=utcnow(),
        )
        self.worktrees[wid] = wt
        self.changes[wid] = set()
        return wt

    async def get(self, worktree_id: str) -> Worktree:
        if worktree_id not in self.worktrees:
            raise NotFound("Worktree bulunamadı.")
        return self.worktrees[worktree_id]

    async def list(self, *, run_id: str | None = None, active_only: bool = True) -> list[Worktree]:
        return [
            w
            for w in self.worktrees.values()
            if (run_id is None or w.run_id == run_id) and (not active_only or w.status == "active")
        ]

    async def changed_files(self, worktree_id: str) -> list[str]:
        return sorted(self.changes.get(worktree_id, set()))

    async def diff(self, worktree_id: str, *, include_patch: bool = True) -> DiffResult:
        files = [
            FileDiff(path=p, status="modified", additions=2, deletions=1, patch=f"--- a/{p}\n+++ b/{p}\n+yeni\n-eski")
            if include_patch
            else FileDiff(path=p, status="modified", additions=2, deletions=1)
            for p in sorted(self.changes.get(worktree_id, set()))
        ]
        return DiffResult(
            base="base000",
            head="head",
            files=files,
            additions=2 * len(files),
            deletions=len(files),
        )

    async def commit_all(self, worktree_id: str, message: str) -> str | None:
        current = set(self.changes.get(worktree_id, set()))
        if current == self.committed.get(worktree_id, set()):
            return None
        self.committed[worktree_id] = current
        sha = f"c{len(self.commits) + 1:04d}"
        self.commits.append((worktree_id, message))
        return sha

    async def merge_preview(self, worktree_id: str, target_ref: str | None = None) -> MergePreview:
        conflicts = self.conflicts.get(worktree_id, [])
        return MergePreview(
            clean=not conflicts,
            conflicts=list(conflicts),
            target_ref=target_ref or "main",
            target_sha="t000",
            diff=await self.diff(worktree_id),
        )

    async def merge(
        self,
        worktree_id: str,
        *,
        target_ref: str | None = None,
        strategy: Literal["merge", "squash", "cherry_pick"] = "merge",
        message: str | None = None,
    ) -> MergeResult:
        if self.conflicts.get(worktree_id):
            return MergeResult(merged=False, conflicts=self.conflicts[worktree_id], message="conflict")
        self.merges.append({"worktree_id": worktree_id, "target_ref": target_ref, "strategy": strategy})
        self.worktrees[worktree_id] = self.worktrees[worktree_id].model_copy(update={"status": "merged"})
        return MergeResult(merged=True, commit_sha=f"m{len(self.merges):04d}")

    async def push(self, worktree_id: str, *, remote: str = "origin", remote_branch: str | None = None) -> None:
        self.pushes.append({"worktree_id": worktree_id, "remote": remote, "remote_branch": remote_branch})

    async def remove(self, worktree_id: str, *, force: bool = False) -> None:
        self.removed.append(worktree_id)
        self.worktrees[worktree_id] = self.worktrees[worktree_id].model_copy(update={"status": "removed"})

    async def run_command(self, worktree_id: str, command: str, *, timeout: float = 1800) -> tuple[int, str]:
        self.commands.append((worktree_id, command))
        if self.command_script is None:
            return 0, f"$ {command}\nok"
        calls = sum(1 for _w, c in self.commands if c == command)
        return self.command_script(worktree_id, command, calls)

    async def checkpoint(
        self,
        *,
        run_id: str | None,
        node_id: str | None,
        label: str,
        worktree_ids: list[str],
        workspace_id: str | None = None,
    ) -> Checkpoint:
        cid = new_id("gck")
        ck = Checkpoint(
            id=cid,
            run_id=run_id,
            node_id=node_id,
            label=label,
            refs={w: f"sha-{len(self.checkpoints)}" for w in worktree_ids},
            created_at=utcnow(),
        )
        self.checkpoints[cid] = ck
        return ck

    async def restore(self, checkpoint_id: str) -> Checkpoint:
        self.restored.append(checkpoint_id)
        return self.checkpoints[checkpoint_id]

    async def overlaps(self) -> list[FileOverlap]:
        return []


# --------------------------------------------------------------------------- memory


class FakeMemoryService:
    def __init__(self) -> None:
        self.bounds = Boundaries()
        self.docs: dict[str, MemoryDoc] = {
            "facts.md": MemoryDoc(path="facts.md", layer="facts", title="Gerçekler", content="Proje Python 3.13."),
        }
        self.proposals: list[MemoryProposal] = []
        self.restored: list[str] = []
        self.head_value: str | None = "mem0001"

    async def ensure(self, workspace_id: str) -> None:
        return None

    async def context_for_agent(self, workspace_id: str, *, role: str) -> str:
        return f"Hafıza bağlamı ({role})"

    async def list_docs(self, workspace_id: str) -> list[MemoryDoc]:
        return list(self.docs.values())

    async def read(self, workspace_id: str, path: str) -> MemoryDoc:
        if path not in self.docs:
            raise NotFound("Belge yok.")
        return self.docs[path]

    async def write(self, workspace_id: str, path: str, content: str, *, message: str, actor: str = "user") -> str:
        layer: MemoryLayer = "decisions" if path.startswith("decisions/") else "facts"
        self.docs[path] = MemoryDoc(path=path, layer=layer, title=path, content=content)
        return "sha"

    async def propose(
        self,
        workspace_id: str,
        *,
        path: str,
        new_content: str,
        rationale: str | None = None,
        source_session_id: str | None = None,
    ) -> MemoryProposal:
        proposal = MemoryProposal(
            id=new_id("memp"),
            workspace_id=workspace_id,
            layer="decisions",
            path=path,
            old_content=None,
            new_content=new_content,
            diff=new_content,
            rationale=rationale,
            source_session_id=source_session_id,
            approval_id=new_id("apr"),
            created_at=utcnow(),
        )
        self.proposals.append(proposal)
        return proposal

    async def boundaries(self, workspace_id: str) -> Boundaries:
        return self.bounds

    async def head(self, workspace_id: str) -> str | None:
        return self.head_value

    async def restore(self, workspace_id: str, commit: str) -> None:
        self.restored.append(commit)


# --------------------------------------------------------------------------- limits


class FakeLimitService:
    def __init__(self) -> None:
        self.available: dict[str, BudgetCheck] = {}
        self.budget: dict[str, BudgetCheck] = {}
        self.windows: dict[str, list[LimitWindow]] = {}
        self.usage: dict[str, UsageTotals] = {}
        self.checks: list[str] = []

    def exhaust(self, provider: Provider, resets_at: datetime | None = None, reason: str | None = None) -> None:
        self.available[provider] = BudgetCheck(
            ok=False, reason=reason or f"{provider} limiti doldu.", resets_at=resets_at
        )

    def restore(self, provider: Provider) -> None:
        self.available.pop(provider, None)

    async def record(self, windows: list[LimitWindow]) -> None:
        return None

    async def current(self, provider: Provider | None = None) -> list[LimitWindow]:
        if provider is None:
            return [w for ws in self.windows.values() for w in ws]
        return list(self.windows.get(provider, []))

    async def is_available(self, provider: Provider) -> BudgetCheck:
        self.checks.append(provider)
        return self.available.get(provider, BudgetCheck(ok=True))

    async def check_budget(self, provider: Provider, budget: Budget, *, task_id: str) -> BudgetCheck:
        return self.budget.get(provider, BudgetCheck(ok=True))

    async def task_usage(self, task_id: str) -> UsageTotals:
        return self.usage.get(task_id, UsageTotals())

    async def refresh(self) -> None:
        return None


# --------------------------------------------------------------------------- hosting, deploy, studios


class FakeGitHosting:
    def __init__(self) -> None:
        self.prs: list[dict[str, Any]] = []
        self.watched: list[tuple[str, int, str | None, bool]] = []

    async def open_pull_request(
        self, repo_id: str, *, head: str, base: str, title: str, body: str, draft: bool = False
    ) -> PullRequestRef:
        number = len(self.prs) + 1
        self.prs.append({"repo_id": repo_id, "head": head, "base": base, "title": title, "body": body, "draft": draft})
        return PullRequestRef(
            repo_id=repo_id,
            number=number,
            url=f"https://git.example/pr/{number}",
            title=title,
            head=head,
            base=base,
            draft=draft,
        )

    async def pr_status(self, repo_id: str, number: int) -> PullRequestStatus:
        raise NotImplementedError

    async def watch(self, repo_id: str, number: int, *, task_id: str | None, autofix: bool = True) -> None:
        self.watched.append((repo_id, number, task_id, autofix))

    async def unwatch(self, repo_id: str, number: int) -> None:
        return None

    async def job_log(self, repo_id: str, job_id: str) -> str:
        return ""

    async def reply_to_comment(self, repo_id: str, number: int, comment_id: str, body: str) -> None:
        return None

    async def trigger_pipeline(
        self, repo_id: str, *, ref: str, workflow: str | None = None, variables: dict[str, str] | None = None
    ) -> str:
        return "1"

    async def pipeline_status(self, repo_id: str, run_id: str) -> CheckRun:
        return CheckRun(name="ci", status="completed", conclusion="success")


class FakeDeployService:
    def __init__(self) -> None:
        self.profiles: dict[str, DeployProfile] = {}
        self.deploys: list[dict[str, Any]] = []
        self.fail = False

    def add_profile(self, profile_id: str, environment: Environment) -> DeployProfile:
        p = DeployProfile(
            id=profile_id,
            workspace_id="ws",
            name=f"{environment.value} profili",
            kind="command",
            environment=environment,
            created_at=utcnow(),
        )
        self.profiles[profile_id] = p
        return p

    async def get_profile(self, profile_id: str) -> DeployProfile:
        if profile_id not in self.profiles:
            raise NotFound("Deploy profili bulunamadı.")
        return self.profiles[profile_id]

    async def deploy(
        self,
        profile_id: str,
        *,
        ref: str | None,
        actor: str,
        task_id: str | None = None,
        run_id: str | None = None,
        summary: str | None = None,
    ) -> DeployResult:
        profile = await self.get_profile(profile_id)
        self.deploys.append({"profile_id": profile_id, "ref": ref, "actor": actor, "task_id": task_id})
        now = utcnow()
        return DeployResult(
            id=new_id("dep"),
            profile_id=profile_id,
            environment=profile.environment,
            status="failed" if self.fail else "succeeded",
            ref=ref,
            log="deploy log",
            started_at=now,
            finished_at=now,
        )

    async def rollback(self, deploy_id: str, *, actor: str) -> DeployResult:
        raise NotImplementedError


class FakeStudioService:
    def __init__(self) -> None:
        self.graphs: dict[str, FlowGraph] = {}
        self.instantiated: list[tuple[str, dict[str, Any]]] = []

    async def list(self) -> list[Studio]:
        return []

    async def get(self, studio_id: str, version: int | None = None) -> Studio:
        raise NotFound("Stüdyo bulunamadı.")

    async def save(self, studio: Studio) -> Studio:
        return studio

    async def instantiate(self, studio_id: str, *, workspace_id: str, inputs: dict[str, Any]) -> FlowGraph:
        self.instantiated.append((studio_id, inputs))
        if studio_id not in self.graphs:
            raise NotFound("Stüdyo bulunamadı.")
        return self.graphs[studio_id]
