"""Team node runtime (spec §25): one ``TeamRun`` per running ``team`` node.

How a team works
----------------
* The **lead** gets the rendered prompt plus a roster of its direct subordinates and works in its
  own worktree (created from the task's base, or continuing the upstream writer's worktree). Every
  member with subordinates delegates through the Studio tools (``team_delegate`` / ``team_wait``);
  members with an advisor in their chain also get ``team_consult`` / ``team_report``; lead and
  workers get ``team_finish``. Advisors and testers get no team tools (advisors: no mutating tools).
* **Assignments** are persisted (``engine_team_assignments``) and scheduled dependency-aware: at most
  ``max_parallel_members`` members work at once (members waiting on their own subordinates do not
  count), one assignment per member at a time, leaves/testers also take the engine's per-provider
  session slots, and ``LimitService`` availability is checked before a member works.
* Each member has **one long-lived session**, reused across its assignments (one turn per
  assignment). Its worktree is created from its manager's branch HEAD (the manager's worktree is
  committed first) and re-synced with it before later assignments.
* When an assignment's turn ends (``team_finish`` or simply the end of the turn, whose final text
  becomes the summary; a manager first waits for its own open assignments): commit the member
  worktree -> **dependent testers** run on it (structured findings; a failing verdict sends a fix
  turn back to the member, at most ``test_max_rounds`` times) -> **merge** into the manager's branch
  (``WorktreeManager.merge``; conflicts are reported, the manager decides) -> independent testers
  of the manager (``after_each_merge``) -> checkpoint -> the result goes to the manager (wakes its
  ``team_wait``; an idle manager gets it as a new turn).
* **Advisor**: read-only session in the advised member's worktree. ``each_assignment``: after each
  finished assignment below the advised member the engine sends a short report; a reply other than
  "Öneri yok." is forwarded to the advised member (``steer`` while it works, otherwise with its next
  turn). ``periodic``: progress reports every ``report_interval_minutes``. ``on_demand``: explicit
  ``team_report`` texts are kept for the next ``team_consult``.
* **Independent testers** run on their parent's integrated worktree after each merge or at the end
  (a non-lead parent: when its assignment ends; the lead: before the team node finishes, failures go
  back to the lead as a new turn, at most ``test_max_rounds`` times).
* Cancellation tears down every member session and open assignment; after a studiod restart the
  persisted state is reloaded, sessions are re-attached with ``AgentManager.handle()`` and in-flight
  turns are waited for (or re-sent with a resume note).

Events (all carry ``node_id``, ``node_run_id``, ``label``, ``run_id``, ``task_id``,
``workspace_id``; the event envelope also has workspace/task/run ids and, where noted, the
session id of the acting member):
    team.started            {team_id, team_name, attempt, resumed, members: [{id, name, role, parent_id,
                             provider, model, effort, writes, test_mode, tests_member_id}], settings}
    team.member             {member_id, member_name, role, status, session_id, assignment_id, provider,
                             model, effort, worktree_id}                                   (session: member)
    team.assignment.created / .started / .completed / .failed
                            {assignment (contract Assignment JSON, instructions clipped), assignment_id,
                             kind (work|test|check), from_member, to_member, from_name, to_name, title,
                             depends_on, status, round, parent_id, target_id, from_session_id,
                             to_session_id, session_id, worktree_id
                             + completed/failed: summary, error, merge, tests}     (session: to_member)
    team.report             {from_member, advisor, summary, kind (assignment|periodic|member),
                             from_session_id, advisor_session_id}                     (session: advisor)
    team.advice             {advisor, to_member, text, kind (reply|consult), question, advisor_session_id,
                             to_session_id, delivered (steer|queued|answer)}          (session: advisor)
    team.merge              {assignment_id, from_member, to_member, status (clean|conflict|skipped),
                             conflicts, commit_sha, message, from_session_id, to_session_id}
    team.test               {tester, member, status (passed|failed|error), summary, round,
                             mode (dependent|independent), assignment_id, test_assignment_id,
                             findings_count, blocking_count, tester_session_id}       (session: tester)
    team.message            {member_id, mode, delivered, text}           a user message sent to a member
    team.finished           {status (completed|failed|cancelled), summary, error, assignments:
                             {total, completed, failed, cancelled}, test_rounds, test_failures,
                             merge_conflicts}
    agent.handoff           {from, to, reason, summary, kind (delegate|result), from_member, to_member,
                             assignment_id, from_node_id, from_session_id, to_session_id, agent_label,
                             provider}                                             (session: the sender)
    node.session / node.worktree / node.provider_switched / run.limit_wait also carry ``member_id``.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import shlex
from collections.abc import Coroutine, Iterable
from dataclasses import dataclass, field
from typing import Any, Literal

from aistudio.contracts.agents import AgentRole, AgentSessionHandle
from aistudio.contracts.common import Provider, other_provider
from aistudio.contracts.flows import TeamNodeConfig
from aistudio.contracts.gitops import MergeResult
from aistudio.contracts.teams import AssignmentMerge, TeamMember, TeamRole, TeamSpec, TestMode
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, StudioError, ValidationFailed
from aistudio.core.events import ET, Severity
from aistudio.core.ids import new_id
from aistudio.core.text import truncate
from aistudio.engine.limits import check_provider
from aistudio.engine.nodes.agent import PROVIDER_LABEL, ensure_worktrees, read_only_location
from aistudio.engine.nodes.base import (
    ACTIVE_AGENT_STATES,
    RESUME_PREFIX,
    NodeContext,
    NodeFailure,
    NodeOutcome,
    ResolvedAgent,
)
from aistudio.engine.structured import SEVERITIES, parse_structured, retry_instructions
from aistudio.engine.team import prompts as P
from aistudio.engine.team.catalog import TeamCatalog
from aistudio.engine.team.models import (
    ENGINE_MEMBER,
    AssignmentKind,
    InboxItem,
    MemberMessageResult,
    MemberState,
    MemberStatus,
    TeamAssignment,
    TeamRunDetail,
    TeamState,
    TeamTestVerdict,
    TurnRecord,
)
from aistudio.engine.team.templates import DEFAULT_TEAM_ID
from aistudio.engine.team.validation import advisor_in_chain, first_error, member_depths, subtree, validate_team
from aistudio.engine.team.view import build_view

log = logging.getLogger(__name__)

TEAM_TOOL_NAMES: tuple[str, ...] = ("team_delegate", "team_wait", "team_consult", "team_report", "team_finish")
TERMINAL = frozenset({"completed", "failed", "cancelled"})
BLOCKING_SEVERITIES = ("critical", "high")
WAIT_DEFAULT_S = 900.0
WAIT_MAX_S = 3600.0
PERIODIC_UNIT_S = 60.0  # seconds per report_interval_minutes unit
GIT_IDENTITY = "-c user.name='AI Studio' -c user.email=studio@aistudio.local"


class TeamError(StudioError):
    """A team tool call that is not allowed (Turkish message, returned to the calling agent)."""

    code = "team_error"


class TeamTurnFailed(StudioError):
    code = "team_turn_failed"


@dataclass
class Member:
    spec: TeamMember
    state: MemberState
    depth: int = 0
    turn_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    signal: asyncio.Event = field(default_factory=asyncio.Event)
    running: bool = False  # a turn is in progress
    handle: AgentSessionHandle | None = None
    agent: ResolvedAgent | None = None
    last_text: str = ""

    @property
    def id(self) -> str:
        return self.spec.id

    @property
    def name(self) -> str:
        return self.spec.name

    @property
    def role(self) -> TeamRole:
        return self.spec.role


async def resolve_team(nctx: NodeContext, cfg: TeamNodeConfig) -> tuple[TeamSpec, str | None, int | None, str]:
    """(spec, team_id, version, name) for a team node: inline spec > saved/built-in template > default."""
    if cfg.team is not None:
        return cfg.team, cfg.team_id, None, "Özel ekip"
    team_id = cfg.team_id
    if not team_id:
        configured = await nctx.rt.setting("engine.default_team_id")
        team_id = configured if isinstance(configured, str) and configured else DEFAULT_TEAM_ID
    team = await TeamCatalog(nctx.rt).find(team_id)
    if team is None:
        raise NodeFailure(f"Ekip şablonu bulunamadı: {team_id}")
    return team.spec, team.id, team.version, team.name


class TeamRun:
    def __init__(
        self,
        nctx: NodeContext,
        cfg: TeamNodeConfig,
        *,
        spec: TeamSpec,
        state: TeamState,
        assignments: list[TeamAssignment],
        meta: dict[str, Any],
        resumed: bool,
    ) -> None:
        self.nctx = nctx
        self.ex = nctx.ex
        self.rt = nctx.rt
        self.cfg = cfg
        self.spec = spec
        self.state = state
        self.meta = meta
        self.resumed = resumed
        self.run_id = nctx.run_id
        self.node_id = nctx.node_id
        self.settings = spec.settings
        depths = member_depths(spec)
        self.members: dict[str, Member] = {}
        for m in spec.members:
            ms = state.members.get(m.id) or MemberState(member_id=m.id)
            state.members[m.id] = ms
            self.members[m.id] = Member(spec=m, state=ms, depth=depths.get(m.id, 0))
        self.lead = self.members[spec.lead().id]
        self.assignments: dict[str, TeamAssignment] = {a.id: a for a in assignments}
        self.names = {m.id: m.name for m in spec.members} | {ENGINE_MEMBER: "Studio"}
        self.repos = self.ex.target_repos(cfg.repo_ids)
        self.limit_info: dict[str, Any] = {}
        self._tasks: set[asyncio.Task[Any]] = set()
        self._runners: dict[str, asyncio.Task[None]] = {}
        self._sched = asyncio.Event()
        self._save_lock = asyncio.Lock()
        self._stopping = False
        self._finishing = False
        self.status: Literal["running", "completed", "failed", "cancelled"] = "running"

    # ------------------------------------------------------------------ construction
    @classmethod
    async def open(cls, nctx: NodeContext, cfg: TeamNodeConfig) -> TeamRun:
        store = nctx.rt.team_store
        row = await store.team_run_row(nctx.run_id, nctx.node_id)
        if row is None:
            spec, team_id, version, name = await resolve_team(nctx, cfg)
            report = validate_team(spec)
            if not report.ok:
                raise NodeFailure(f"Ekip geçersiz: {first_error(report)}")
            state = TeamState(attempt=nctx.attempt)
            await store.insert_team_run(
                run_id=nctx.run_id,
                node_id=nctx.node_id,
                team_id=team_id,
                team_version=version,
                team_name=name,
                spec=spec,
                state=state,
            )
            meta: dict[str, Any] = {"team_id": team_id, "team_version": version, "team_name": name}
            resumed = False
        else:
            spec = TeamSpec.model_validate(row["spec"] or {})
            state = TeamState.model_validate(row["state"] or {})
            resumed = nctx.resumed and row["status"] == "running" and state.attempt == nctx.attempt
            if not resumed:
                state.attempt = nctx.attempt
                state.at_end_rounds = 0
                for ms in state.members.values():
                    ms.finish_summary = None
                    ms.current_assignment_id = None
                    ms.status = "idle"
                    ms.phase = "idle"
            meta = {"team_id": row["team_id"], "team_version": row["team_version"], "team_name": row["team_name"]}
            await store.update_team_run(
                nctx.run_id, nctx.node_id, status="running", error=None, state=state.model_dump(mode="json")
            )
        assignments = await store.assignments(nctx.run_id, nctx.node_id)
        if not resumed:
            for a in assignments:
                if a.status not in TERMINAL:  # left over from an interrupted earlier attempt
                    a.status = "cancelled"
                    a.error = "Önceki deneme yarıda kaldı."
                    a.finished_at = utcnow()
                    await store.save_assignment(a)
        return cls(nctx, cfg, spec=spec, state=state, assignments=assignments, meta=meta, resumed=resumed)

    # ------------------------------------------------------------------ persistence & events
    async def save(self) -> None:
        async with self._save_lock:
            await self.rt.team_store.save_state(self.run_id, self.node_id, self.state)

    async def _save_assignment(self, a: TeamAssignment) -> None:
        await self.rt.team_store.save_assignment(a)

    def _ids(self) -> dict[str, Any]:
        return {"run_id": self.run_id, "task_id": self.ex.task.id, "workspace_id": self.ex.task.workspace_id}

    async def _emit(
        self, type: str, payload: dict[str, Any], *, session_id: str | None = None, severity: Severity = Severity.info
    ) -> None:
        await self.nctx.emit(type, {**self._ids(), **payload}, session_id=session_id, severity=severity)

    def _sid(self, member_id: str | None) -> str | None:
        m = self.members.get(member_id or "")
        return m.state.session_id if m is not None else None

    async def _emit_member(self, m: Member) -> None:
        await self._emit(
            ET.TEAM_MEMBER,
            {
                "member_id": m.id,
                "member_name": m.name,
                "role": m.role.value,
                "status": m.state.status,
                "session_id": m.state.session_id,
                "assignment_id": m.state.current_assignment_id,
                "provider": m.state.provider or m.spec.provider,
                "model": m.state.model or m.spec.model,
                "effort": m.state.effort or m.spec.effort,
                "worktree_id": next(iter(m.state.worktrees.values()), None),
            },
            session_id=m.state.session_id,
        )

    async def _set_status(self, m: Member, status: MemberStatus, *, force: bool = False) -> None:
        if m.state.status == status and not force:
            return
        m.state.status = status
        await self.save()
        await self._emit_member(m)
        if status == "waiting":
            self._wake_scheduler()

    def _assignment_payload(self, a: TeamAssignment) -> dict[str, Any]:
        contract = a.contract().model_dump(mode="json")
        contract["instructions"] = truncate(contract.get("instructions") or "", 2000)
        return {
            "assignment": contract,
            "assignment_id": a.id,
            "kind": a.kind,
            "from_member": a.from_member,
            "to_member": a.to_member,
            "from_name": self.names.get(a.from_member, a.from_member),
            "to_name": self.names.get(a.to_member, a.to_member),
            "title": a.title,
            "depends_on": list(a.depends_on),
            "status": a.status,
            "round": a.round,
            "parent_id": a.parent_id,
            "target_id": a.target_id,
            "from_session_id": self._sid(a.from_member),
            "to_session_id": self._sid(a.to_member),
            "session_id": a.session_id,
            "worktree_id": a.worktree_id,
        }

    async def _handoff(
        self, *, kind: Literal["delegate", "result"], src: str, dst: str, a: TeamAssignment, summary: str
    ) -> None:
        sender = self.members.get(src)
        await self._emit(
            ET.AGENT_HANDOFF,
            {
                "from": self.names.get(src, src),
                "to": self.names.get(dst, dst),
                "reason": truncate(a.title, 300),
                "summary": truncate(summary, 1000),
                "kind": kind,
                "from_member": src,
                "to_member": dst,
                "assignment_id": a.id,
                "from_node_id": self.node_id,
                "from_session_id": self._sid(src),
                "to_session_id": self._sid(dst),
                "agent_label": self.names.get(src, src),
                "provider": (sender.state.provider or sender.spec.provider) if sender else None,
            },
            session_id=self._sid(src),
        )

    def _spawn(self, coro: Coroutine[Any, Any, Any], name: str) -> asyncio.Task[Any]:
        task = asyncio.create_task(coro, name=f"team-{self.run_id}-{self.node_id}-{name}")
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def _task_done(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("team task %s failed", task.get_name(), exc_info=task.exception())

    def _wake_scheduler(self) -> None:
        self._sched.set()

    def _stop(self) -> None:
        """No new work; wake every waiter (team_wait returns with an error)."""
        self._stopping = True
        for m in self.members.values():
            m.signal.set()
        self._sched.set()

    # ------------------------------------------------------------------ queries
    def children(self, member_id: str) -> list[TeamAssignment]:
        return sorted(
            (a for a in self.assignments.values() if a.kind == "work" and a.from_member == member_id),
            key=lambda a: a.seq,
        )

    def open_children(self, member_id: str) -> list[TeamAssignment]:
        return [a for a in self.children(member_id) if a.status not in TERMINAL]

    def undelivered(self, member_id: str) -> list[TeamAssignment]:
        return [a for a in self.children(member_id) if a.status in TERMINAL and not a.delivered]

    def _is_manager(self, m: Member) -> bool:
        return m.role in (TeamRole.lead, TeamRole.worker) and bool(self.spec.subordinates(m.id))

    def _working_count(self) -> int:
        return sum(
            1
            for m in self.members.values()
            if m.role == TeamRole.worker and m.state.current_assignment_id and m.state.status != "waiting"
        )

    def team_tools_for(self, m: Member) -> list[str]:
        """Team tools bound to a member: delegation for managers, finish for lead/workers, consult/report
        when an advisor is in its chain. Advisors and testers get none."""
        names: list[str] = []
        if m.role in (TeamRole.lead, TeamRole.worker):
            if self.spec.subordinates(m.id):
                names += ["team_delegate", "team_wait"]
            names.append("team_finish")
            if advisor_in_chain(self.spec, m.id) is not None:
                names += ["team_consult", "team_report"]
        return names

    def tool_names_for(self, m: Member) -> list[str] | None:
        registry = self.rt.tools()
        if registry is None:
            return None
        return [s.name for s in registry.all_specs() if not s.opt_in] + self.team_tools_for(m)

    # ------------------------------------------------------------------ main
    async def run(self) -> NodeOutcome:
        hub = self.rt.teams
        hub.add(self)
        for m in self.members.values():
            if m.state.session_id:
                hub.register_session(m.state.session_id, self, m.id)
        try:
            minutes = await self.rt.int_setting("engine.team_timeout_minutes")
            try:
                async with asyncio.timeout(minutes * 60 if minutes > 0 else None):
                    return await self._run()
            except TimeoutError:
                message = f"Ekip süre sınırını aştı ({minutes} dakika)."
                await self._abort("failed", message)
                raise NodeFailure(message) from None
        except asyncio.CancelledError:
            with contextlib.suppress(Exception):
                await asyncio.shield(self._on_cancel())
            raise
        except NodeFailure as e:
            if self.status == "running":
                await self._abort("failed", e.message)
            raise
        except StudioError as e:
            await self._abort("failed", e.message)
            raise NodeFailure(e.message) from e
        except Exception as e:
            log.exception("team node %s of run %s failed", self.node_id, self.run_id)
            await self._abort("failed", f"Beklenmeyen ekip hatası: {e}")
            raise
        finally:
            self._stop()
            await self._cancel_tasks()
            hub.remove(self)

    async def _run(self) -> NodeOutcome:
        await self._prepare_lead()
        await self._emit(
            ET.TEAM_STARTED,
            {
                "team_id": self.meta.get("team_id"),
                "team_name": self.meta.get("team_name"),
                "attempt": self.state.attempt,
                "resumed": self.resumed,
                "members": [
                    {
                        "id": m.id,
                        "name": m.name,
                        "role": m.role.value,
                        "parent_id": m.parent_id,
                        "provider": m.provider,
                        "model": m.model,
                        "effort": m.effort,
                        "writes": m.writes and m.role != TeamRole.advisor,
                        "test_mode": m.test_mode.value if m.role == TeamRole.tester else None,
                        "tests_member_id": m.tests_member_id,
                    }
                    for m in self.spec.members
                ],
                "settings": self.settings.model_dump(mode="json"),
            },
            session_id=self.lead.state.session_id,
        )
        self._spawn(self._scheduler_loop(), "scheduler")
        if self.settings.report_mode.value == "periodic" and self._advisors():
            for adv in self._advisors():  # nothing to report until something happens
                self.state.reported_activity.setdefault(adv.id, self.state.activity)
            self._spawn(self._periodic_loop(), "periodic")
        if self.resumed:
            await self._resume_assignments()
        self._wake_scheduler()
        summary = await self._lead_flow()
        self._finishing = True
        await self._drain()
        return await self._complete(summary)

    async def _prepare_lead(self) -> None:
        if not self.repos:
            raise NodeFailure("Bu görev için çalışma alanında repo yok; ekip çalıştırılamaz.")
        lead = self.lead
        if not lead.state.worktrees:
            wts = await ensure_worktrees(self.nctx, self.repos)
            lead.state.worktrees = {w.repo_id: w.id for w in wts}
            await self.save()
        await self.nctx.add_worktrees(list(lead.state.worktrees.values()))
        if lead.state.session_id:
            await self.nctx.add_session(lead.state.session_id)

    async def _resume_assignments(self) -> None:
        for m in self.members.values():
            m.state.current_assignment_id = None
            if m.state.status not in ("done", "error"):
                m.state.status = "idle"
        for a in sorted(self.assignments.values(), key=lambda x: x.seq):
            if a.kind in ("test", "check") and a.status not in TERMINAL:
                a.status = "cancelled"
                a.error = "Studio yeniden başlatıldı; test yeniden çalıştırılacak."
                a.finished_at = utcnow()
                await self._save_assignment(a)
        for a in sorted(self.assignments.values(), key=lambda x: x.seq):
            if a.kind == "work" and a.status in ("running", "testing", "blocked"):
                self.members[a.to_member].state.current_assignment_id = a.id
                self._runners[a.id] = self._spawn(self._run_assignment(a, resume=True), f"assignment-{a.id}")
        await self.save()

    async def _lead_first_message(self) -> str:
        prompt = await self.nctx.render(self.cfg.prompt_template, role="writer")
        if not prompt.strip():
            prompt = self.ex.task.prompt
        fb = self.ex.state.feedback.get(self.node_id)
        if self.state.attempt > 1 and fb is not None and fb.text.strip() and fb.text.strip() not in prompt:
            prompt += f"\n\n## Düzeltilmesi gerekenler (tur {fb.round})\n{fb.text.strip()}"
        if self.state.attempt > 1 and self.lead.state.turns > 0:
            return (
                prompt + "\n\nGerekirse düzeltme işlerini ekibine dağıt; iş bitince `team_finish` ile ne değiştiğini "
                "özetle."
            )
        return P.lead_message(prompt, self.spec, self.lead.spec)

    async def _lead_flow(self) -> str:
        lead = self.lead
        message = await self._lead_first_message()
        resume = self.resumed
        max_rounds = max(0, self.settings.test_max_rounds)
        while True:
            summary = await self._work_loop(lead, message, None, purpose="lead", resume=resume)
            resume = False
            testers = self._end_testers(lead)
            if not testers:
                return summary
            round_no = self.state.at_end_rounds + 1
            verdicts = [
                await self._run_tester(t, subject=lead, assignment=None, round_no=round_no, summary=summary)
                for t in testers
            ]
            failed = [v for v in verdicts if v.status == "failed"]
            if not failed or self.state.at_end_rounds >= max_rounds:
                return summary
            self.state.at_end_rounds += 1
            await self.save()
            message = P.fix_message(failed, self.state.at_end_rounds, max_rounds)

    def _end_testers(self, m: Member) -> list[TeamMember]:
        """Testers that verify ``m``'s work when it ends: dependent ones and at_end independent ones."""
        out = list(self.spec.testers_of(m.id))
        if self.settings.independent_tests_trigger == "at_end":
            out += [
                t
                for t in self.spec.members
                if t.role == TeamRole.tester and t.test_mode == TestMode.independent and t.parent_id == m.id
            ]
        return out

    # ------------------------------------------------------------------ turns
    async def _work_loop(
        self,
        m: Member,
        message: str,
        assignment: TeamAssignment | None,
        *,
        purpose: str,
        resume: bool = False,
    ) -> str:
        """Turns until the member's work is done: a finished turn with no open/undelivered assignments of its
        own and no urgent message left. Returns its team_finish summary, else the last turn's text."""
        aid = assignment.id if assignment is not None else None
        if not resume:
            m.state.finish_summary = None
        first = True
        while True:
            if first and resume:
                text = await self._resume_turn(m, message, purpose=purpose, assignment_id=aid)
            else:
                text = await self._turn(m, message, purpose=purpose, assignment_id=aid)
            first = False
            m.last_text = text
            if self._work_done(m):
                break
            message = await self._next_delivery(m)
            purpose = "deliver"
        return (m.state.finish_summary or m.last_text or "").strip()

    def _work_done(self, m: Member) -> bool:
        return not (self.open_children(m.id) or self.undelivered(m.id) or any(i.urgent for i in m.state.inbox))

    async def _resume_turn(self, m: Member, message: str, *, purpose: str, assignment_id: str | None) -> str:
        rec = m.state.turn
        if rec is not None and rec.assignment_id == assignment_id and rec.sent:
            if rec.done:
                return rec.text or ""
            return await self._turn(m, rec.message, purpose=rec.purpose, assignment_id=assignment_id, reattach=True)
        return await self._turn(m, message, purpose=purpose, assignment_id=assignment_id)

    async def _turn(
        self,
        m: Member,
        message: str,
        *,
        purpose: str,
        assignment_id: str | None = None,
        status: MemberStatus = "working",
        reattach: bool = False,
    ) -> str:
        """One turn on the member's session (started on first use); returns the final text."""
        leaf = m.role != TeamRole.advisor and not self._is_manager(m)
        timeout: float | None = None
        if leaf:
            minutes = await self.rt.int_setting("engine.turn_timeout_minutes")
            timeout = float(minutes * 60) if minutes > 0 else None
        async with m.turn_lock:
            handle = await self._ensure_session(m)
            slot = self.ex.agent_slot(m.state.provider or m.spec.provider) if leaf else contextlib.nullcontext()
            async with slot:
                rec = m.state.turn
                if reattach and rec is not None:
                    if handle.state in ACTIVE_AGENT_STATES:
                        wait_id: str | None = None
                    else:
                        wait_id = await handle.send(RESUME_PREFIX + rec.message)
                        rec.turn_id = wait_id
                        rec.sent = True
                        await self.save()
                else:
                    items = list(m.state.inbox)
                    m.state.inbox.clear()
                    body = message.strip()
                    extra = P.inbox_text(items)
                    if extra:
                        body = f"{body}\n\n{extra}" if body else extra
                    rec = TurnRecord(key=new_id("tturn"), purpose=purpose, assignment_id=assignment_id, message=body)
                    m.state.turn = rec
                    m.state.turns += 1
                    await self.save()
                    wait_id = await handle.send(body)
                    rec.turn_id = wait_id
                    rec.sent = True
                    await self.save()
                m.running = True
                m.state.phase = "turn"
                await self._set_status(m, status, force=True)
                try:
                    result = await handle.wait_turn(wait_id, timeout=timeout)
                except TimeoutError:
                    with contextlib.suppress(Exception):
                        await handle.interrupt()
                    raise TeamTurnFailed("Ajan turu süre sınırını aştı.") from None
                finally:
                    m.running = False
                rec.done = True
                rec.text = result.text or ""
                m.state.phase = "idle"
                await self.save()
        if result.status == "error":
            raise TeamTurnFailed(f"Ajan hata verdi: {result.error or 'bilinmeyen hata'}")
        if result.status == "interrupted":
            raise TeamTurnFailed("Ajan turu kesildi.")
        if result.status == "max_turns":
            raise TeamTurnFailed("Ajan tur sınırına ulaştı; iş tamamlanmadı.")
        return result.text or ""

    async def _next_delivery(self, m: Member) -> str:
        """Wait (idle) until results of the member's own assignments or an urgent message arrive."""
        m.state.phase = "waiting"
        await self._set_status(m, "waiting")
        while True:
            m.signal.clear()
            results = self.undelivered(m.id)
            if results or any(i.urgent for i in m.state.inbox) or not self.open_children(m.id):
                break
            await m.signal.wait()
        for a in results:
            a.delivered = True
            await self._save_assignment(a)
        items = list(m.state.inbox)
        m.state.inbox.clear()
        m.state.phase = "turn"
        await self.save()
        return P.delivery_message(results, items, self.names)

    # ------------------------------------------------------------------ sessions
    async def _ensure_session(self, m: Member) -> AgentSessionHandle:
        mgr = self.rt.agents()
        if m.state.session_id:
            handle = await mgr.handle(m.state.session_id)
            m.handle = handle
            self.rt.teams.register_session(m.state.session_id, self, m.id)
            await self.nctx.add_session(m.state.session_id)
            return handle
        agent = await self._agent_for(m)
        cwd, extra_dirs, worktree_id = await self._location_for(m)
        tool_names = self.tool_names_for(m)
        if m.role == TeamRole.advisor:
            extra = P.advisor_system(self.spec, m.spec)
        elif m.role == TeamRole.tester:
            extra = P.tester_system(m.spec)
        else:
            extra = P.team_rules(self.spec, m.spec, self.team_tools_for(m))
        system = await self.nctx.system_append(agent.role, "\n\n".join(p for p in (agent.instructions, extra) if p))
        req = self.nctx.session_request(
            agent,
            cwd=cwd,
            system_append=system,
            extra_dirs=extra_dirs,
            worktree_id=worktree_id,
            tool_names=tool_names,
            label=m.name,
        )
        record = await mgr.start_session(req)
        m.agent = agent
        m.state.session_id = record.id
        m.state.provider = agent.provider
        m.state.model = agent.model
        m.state.effort = agent.effort
        self.rt.teams.register_session(record.id, self, m.id)
        await self.save()
        await self.nctx.add_session(record.id)
        await self.nctx.emit(
            "node.session",
            {"provider": agent.provider, "model": agent.model, "role": agent.role, "member_id": m.id},
            session_id=record.id,
        )
        await self._emit_member(m)
        handle = await mgr.handle(record.id)
        m.handle = handle
        return handle

    @staticmethod
    def _agent_role(m: TeamMember) -> AgentRole:
        if m.role == TeamRole.advisor:
            return "advisor"
        if m.role == TeamRole.tester:
            return "tester"
        return "writer" if m.writes else "planner"

    async def _agent_for(self, m: Member) -> ResolvedAgent:
        read_only = m.role == TeamRole.advisor or not m.spec.writes
        agent = await self.nctx.resolve_agent(
            profile_id=m.spec.profile_id,
            provider=m.spec.provider,
            model=m.spec.model,
            effort=m.spec.effort,
            role=self._agent_role(m.spec),
            explicit=set(m.spec.model_fields_set) | {"role"},
            node_boundaries=m.spec.boundaries,
            read_only=read_only,
        )
        if m is self.lead:
            provider, info = await self.nctx.ensure_provider(
                agent.provider, purpose=f"{self.nctx.node.label} · {m.name}"
            )
            self.limit_info = info
        else:
            provider = await self._member_provider(m, agent.provider, allow_switch=True)
        if provider != agent.provider:
            agent.switched_from = agent.provider
            m.state.switched_from = agent.provider
            agent.provider, agent.model, agent.effort = provider, None, None
        return agent

    async def _member_provider(self, m: Member, provider: Provider, *, allow_switch: bool) -> Provider:
        """Wait until ``provider`` is within limits/budget; may switch a member that has no session yet."""
        limits = self.rt.limits()
        if limits is None:
            return provider
        task = self.ex.task
        budget = task.budget or self.ex.graph.settings.budget
        policy = self.ex.graph.settings.limit_policy.on_exhausted
        announced = False
        poll = max(0.01, await self.rt.float_setting("engine.limit_poll_seconds"))
        while True:
            check = await check_provider(limits, provider, budget, task.id)
            if check.ok:
                return provider
            if not check.exhausted:
                raise TeamTurnFailed(check.reason or "Görev bütçesi aşıldı.")
            alt = other_provider(provider)
            if allow_switch and policy == "switch_provider" and m.state.session_id is None:
                alt_check = await check_provider(limits, alt, budget, task.id)
                if alt_check.ok:
                    await self.nctx.emit(
                        "node.provider_switched",
                        {"from": provider, "to": alt, "reason": check.reason, "purpose": m.name, "member_id": m.id},
                        severity=Severity.normal,
                    )
                    return alt
            if not announced:
                announced = True
                await self.nctx.emit(
                    "run.limit_wait",
                    {
                        "provider": provider,
                        "purpose": m.name,
                        "reason": check.reason,
                        "resets_at": check.resets_at.isoformat() if check.resets_at else None,
                        "member_id": m.id,
                    },
                    severity=Severity.critical,
                )
                aid = m.state.current_assignment_id
                if aid and aid in self.assignments and self.assignments[aid].status == "pending":
                    a = self.assignments[aid]
                    a.status = "blocked"
                    await self._save_assignment(a)
            delay = poll
            if check.resets_at is not None:
                delay = min(delay, max(0.01, (check.resets_at - utcnow()).total_seconds()))
            await asyncio.sleep(delay)

    async def _ensure_available(self, m: Member) -> None:
        if m.state.session_id and m.state.provider:
            await self._member_provider(m, m.state.provider, allow_switch=False)

    async def _location_for(self, m: Member) -> tuple[str, list[str], str | None]:
        if m.role in (TeamRole.lead, TeamRole.worker):
            source = m
        elif m.role == TeamRole.advisor:
            source = self.members[m.spec.parent_id or self.lead.id]
        elif m.spec.test_mode == TestMode.dependent and m.spec.tests_member_id:
            source = self.members[m.spec.tests_member_id]
        else:
            source = self.members[m.spec.parent_id or self.lead.id]
        if not source.state.worktrees and source is not m and source is not self.lead:
            source = self.lead
        wm = self.rt.worktrees()
        wts = [await wm.get(w) for w in source.state.worktrees.values()]
        if not wts:
            cwd, extra = read_only_location(self.nctx, self.repos)
            return cwd, extra, None
        own = source is m
        return wts[0].path, [w.path for w in wts[1:]], wts[0].id if own else None

    async def _close_sessions(self, *, interrupt: bool) -> None:
        mgr = self.rt.maybe_agents()
        if mgr is None:
            return
        for m in self.members.values():
            sid = m.state.session_id
            if not sid:
                continue
            try:
                handle = m.handle or await mgr.handle(sid)
            except Exception:
                continue
            if interrupt:
                with contextlib.suppress(Exception):
                    await handle.interrupt()
            with contextlib.suppress(Exception):
                await handle.close()
            m.handle = None

    # ------------------------------------------------------------------ worktrees & git
    def _commit_message(self, m: Member, title: str) -> str:
        task = self.ex.task
        return (
            f"{task.title}\n\n{m.name} ({PROVIDER_LABEL.get(m.state.provider or m.spec.provider, '')}): {title}\n"
            f"AI Studio görev: {task.id} · koşu: {self.run_id} · ekip düğümü: {self.node_id}"
        )

    async def _ensure_member_worktrees(self, m: Member, *, sync: bool = True) -> str | None:
        """Create the member's worktrees from its manager's branch HEAD, or re-sync existing ones."""
        manager = self.members[m.spec.parent_id or self.lead.id]
        wm = self.rt.worktrees()
        notes: list[str] = []
        created = False
        for repo in self.repos:
            mgr_wt_id = manager.state.worktrees.get(repo.id)
            if mgr_wt_id is None:
                continue
            mgr_wt = await wm.get(mgr_wt_id)
            await wm.commit_all(mgr_wt_id, self._commit_message(manager, "ara kayıt (iş devri öncesi)"))
            own = m.state.worktrees.get(repo.id)
            if own is None:
                wt = await wm.create(
                    repo.id,
                    base_ref=mgr_wt.branch,
                    task_id=self.ex.task.id,
                    run_id=self.run_id,
                    label=f"{self.node_id}-{m.id}",
                )
                m.state.worktrees[repo.id] = wt.id
                created = True
                await self.nctx.emit(
                    "node.worktree",
                    {"worktree_id": wt.id, "repo_id": repo.id, "branch": wt.branch, "member_id": m.id},
                )
            elif sync:
                note = await self._sync_worktree(own, mgr_wt.branch)
                if note:
                    notes.append(note)
        if created:
            self.ex.state.worktrees[f"{self.node_id}/{m.id}"] = dict(m.state.worktrees)
            await self.ex.persist_state()
            await self.save()
        return "\n".join(notes) or None

    async def _sync_worktree(self, worktree_id: str, branch: str) -> str | None:
        wm = self.rt.worktrees()
        q = shlex.quote(branch)
        try:
            await wm.commit_all(worktree_id, "AI Studio: eşitleme öncesi ara kayıt")
            code, _ = await wm.run_command(worktree_id, f"git merge --ff-only --quiet {q}", timeout=300)
            if code == 0:
                return None
            code, _ = await wm.run_command(worktree_id, f"git {GIT_IDENTITY} merge --no-edit --quiet {q}", timeout=300)
            if code == 0:
                return None
            await wm.run_command(worktree_id, "git merge --abort", timeout=60)
        except (StudioError, TimeoutError, OSError):
            log.warning("could not sync team worktree %s with %s", worktree_id, branch, exc_info=True)
        return (
            "Çalışma dizinin yöneticinin son durumuyla otomatik eşitlenemedi (çakışma). Önceki işin henüz "
            "birleştirilmemiş olabilir; değişikliklerin birleştirme sırasında yöneticiye bildirilecek."
        )

    async def _changed_files(self, m: Member) -> list[str]:
        wm = self.rt.worktrees()
        out: list[str] = []
        for wid in m.state.worktrees.values():
            with contextlib.suppress(StudioError):
                out += await wm.changed_files(wid)
        return out

    async def _merge(self, m: Member, manager: Member, a: TeamAssignment) -> tuple[AssignmentMerge, str | None]:
        wm = self.rt.worktrees()
        statuses: list[str] = []
        conflicts: list[str] = []
        sha: str | None = None
        notes: list[str] = []
        for repo_id, wid in m.state.worktrees.items():
            target_id = manager.state.worktrees.get(repo_id)
            if target_id is None:
                continue
            await wm.commit_all(wid, self._commit_message(m, a.title))
            if not await wm.changed_files(wid):
                statuses.append("skipped")
                continue
            target = await wm.get(target_id)
            res = await self._merge_once(wid, target_id, target.branch, f"{m.name} → {manager.name}: {a.title}")
            if res.merged:
                statuses.append("clean")
                sha = res.commit_sha or sha
            else:
                statuses.append("conflict")
                conflicts += res.conflicts
                if res.message and not res.conflicts:
                    notes.append(res.message)
        status: Literal["clean", "conflict", "skipped"] = (
            "conflict" if "conflict" in statuses else "clean" if "clean" in statuses else "skipped"
        )
        merge = AssignmentMerge(status=status, conflicts=sorted(set(conflicts)), commit_sha=sha)
        note = " ".join(notes) or None
        await self._emit(
            ET.TEAM_MERGE,
            {
                "assignment_id": a.id,
                "from_member": m.id,
                "to_member": manager.id,
                "status": status,
                "conflicts": merge.conflicts[:200],
                "commit_sha": sha,
                "message": note,
                "from_session_id": m.state.session_id,
                "to_session_id": manager.state.session_id,
            },
            session_id=m.state.session_id,
            severity=Severity.normal if status == "conflict" else Severity.info,
        )
        if status == "clean":
            with contextlib.suppress(Exception):
                await self.ex.checkpoint(
                    self.node_id, self.nctx.node_run_id, label=f"{m.name} → {manager.name} birleştirmesi sonrası"
                )
        return merge, note

    async def _merge_once(self, wid: str, target_id: str, branch: str, message: str) -> MergeResult:
        wm = self.rt.worktrees()
        manager_note = "AI Studio: birleştirme öncesi ara kayıt"
        for attempt in range(2):
            await wm.commit_all(target_id, manager_note)  # the manager's work first, so the merge can fast-forward
            try:
                return await wm.merge(wid, target_ref=branch, strategy=self.settings.merge_strategy, message=message)
            except Conflict as e:
                if attempt == 1:
                    return MergeResult(merged=False, message=e.message)
            except StudioError as e:
                return MergeResult(merged=False, message=e.message)
        return MergeResult(merged=False)  # pragma: no cover

    # ------------------------------------------------------------------ assignments
    async def _new_assignment(
        self,
        *,
        kind: AssignmentKind,
        from_member: str,
        to_member: str,
        title: str,
        instructions: str,
        depends_on: Iterable[str] = (),
        parent_id: str | None = None,
        target_id: str | None = None,
        status: Literal["pending", "running"] = "pending",
        round_no: int = 1,
    ) -> TeamAssignment:
        self.state.seq += 1
        now = utcnow()
        masker = self.rt.ctx.masker
        a = TeamAssignment(
            id=new_id("asg"),
            run_id=self.run_id,
            node_id=self.node_id,
            seq=self.state.seq,
            kind=kind,
            from_member=from_member,
            to_member=to_member,
            parent_id=parent_id,
            target_id=target_id,
            title=truncate(masker.mask(title.strip()), 300),
            instructions=truncate(masker.mask(instructions.strip()), 20000),
            depends_on=list(depends_on),
            status=status,
            round=round_no,
            created_at=now,
            started_at=now if status == "running" else None,
        )
        self.assignments[a.id] = a
        self.state.activity += 1
        await self.rt.team_store.insert_assignment(a)
        await self.save()
        await self._emit(ET.TEAM_ASSIGNMENT_CREATED, self._assignment_payload(a), session_id=self._sid(from_member))
        if kind == "work":
            await self._handoff(kind="delegate", src=from_member, dst=to_member, a=a, summary=a.instructions)
        return a

    async def _scheduler_loop(self) -> None:
        while not self._stopping:
            await self._sched.wait()
            self._sched.clear()
            try:
                await self._launch_ready()
            except Exception:
                log.exception("team scheduler failed for run %s", self.run_id)

    async def _launch_ready(self) -> None:
        pending = sorted(
            (a for a in self.assignments.values() if a.kind == "work" and a.status in ("pending", "blocked")),
            key=lambda a: a.seq,
        )
        for a in pending:
            if self._stopping or a.id in self._runners:
                continue
            deps = [self.assignments[d] for d in a.depends_on if d in self.assignments]
            broken = [d for d in deps if d.status in ("failed", "cancelled")]
            if broken:
                names = ", ".join(f"'{d.title}'" for d in broken)
                await self._finish_assignment(a, "failed", error=f"Bağımlı olduğu iş tamamlanamadı: {names}")
                continue
            if any(d.status != "completed" for d in deps):
                continue
            m = self.members[a.to_member]
            if m.state.current_assignment_id is not None:
                continue
            if self._working_count() >= max(1, self.settings.max_parallel_members):
                break
            m.state.current_assignment_id = a.id
            self._runners[a.id] = self._spawn(self._run_assignment(a), f"assignment-{a.id}")

    async def _run_assignment(self, a: TeamAssignment, *, resume: bool = False) -> None:
        m = self.members[a.to_member]
        manager = self.members[a.from_member]
        max_rounds = max(0, self.settings.test_max_rounds)
        message: str | None = None
        try:
            m.state.current_assignment_id = a.id
            while True:
                if a.phase == "work":
                    await self._ensure_available(m)
                    note = await self._ensure_member_worktrees(m, sync=a.round == 1 and not resume)
                    async with m.turn_lock:
                        await self._ensure_session(m)
                    if a.status != "running" or a.started_at is None:
                        a.started_at = a.started_at or utcnow()
                    a.status = "running"
                    a.session_id = m.state.session_id
                    a.worktree_id = next(iter(m.state.worktrees.values()), None)
                    await self._save_assignment(a)
                    await self._emit(
                        ET.TEAM_ASSIGNMENT_STARTED, self._assignment_payload(a), session_id=m.state.session_id
                    )
                    purpose = "assignment" if a.round == 1 else "fix"
                    if message is None:
                        if a.round == 1:
                            deps = [self.assignments[d] for d in a.depends_on if d in self.assignments]
                            message = P.assignment_message(
                                a,
                                from_name=self.names.get(a.from_member, a.from_member),
                                deps=deps,
                                spec=self.spec,
                                member=m.spec,
                                note=note,
                            )
                        else:
                            previous = [v for v in a.tests if v.round == a.round - 1 and v.status == "failed"]
                            message = P.fix_message(previous, a.round - 1, max_rounds)
                    summary = await self._work_loop(m, message, a, purpose=purpose, resume=resume)
                    resume = False
                    message = None
                    a.result_summary = self.rt.mask(summary) or ""
                    a.phase = "test"
                    await self._save_assignment(a)
                elif a.phase == "test":
                    testers = self._end_testers(m)
                    if testers:
                        a.status = "testing"
                        await self._save_assignment(a)
                        verdicts = [
                            await self._run_tester(
                                t, subject=m, assignment=a, round_no=a.round, summary=a.result_summary or ""
                            )
                            for t in testers
                        ]
                        failed = [v for v in verdicts if v.status == "failed"]
                        if failed and a.round - 1 < max_rounds:
                            a.round += 1
                            a.phase = "work"
                            message = P.fix_message(failed, a.round - 1, max_rounds)
                            await self._save_assignment(a)
                            continue
                    a.phase = "merge"
                    await self._save_assignment(a)
                elif a.phase == "merge":
                    merge, note = await self._merge(m, manager, a)
                    a.merge = merge
                    if note:
                        a.error = f"Birleştirme yapılamadı: {note}"
                    if merge.status == "clean":
                        await self._after_merge_checks(manager, a)
                    a.phase = "done"
                    await self._save_assignment(a)
                else:
                    break
            m.state.completed += 1
            await self._finish_assignment(a, "completed")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            if not isinstance(e, StudioError):
                log.exception("assignment %s failed", a.id)
            m.state.failed += 1
            reason = e.message if isinstance(e, StudioError) else f"Beklenmeyen hata: {e}"
            for child in self.open_children(m.id):
                if child.status in ("pending", "blocked") and child.id not in self._runners:
                    await self._finish_assignment(
                        child, "cancelled", error="Üst iş başarısız olduğu için iptal edildi."
                    )
            await self._finish_assignment(a, "failed", error=reason)
        finally:
            self._runners.pop(a.id, None)

    async def _finish_assignment(
        self,
        a: TeamAssignment,
        status: Literal["completed", "failed", "cancelled"],
        *,
        error: str | None = None,
        notify: bool = True,
    ) -> None:
        a.status = status
        if error:
            a.error = error
        a.finished_at = utcnow()
        self.state.activity += 1
        await self._save_assignment(a)
        m = self.members.get(a.to_member)
        if m is not None and m.state.current_assignment_id == a.id:
            m.state.current_assignment_id = None
            m.state.finish_summary = None
            await self._set_status(m, "idle", force=True)
        etype = ET.TEAM_ASSIGNMENT_COMPLETED if status == "completed" else ET.TEAM_ASSIGNMENT_FAILED
        payload = self._assignment_payload(a) | {
            "summary": truncate(a.result_summary or "", 2000),
            "error": a.error,
            "merge": a.merge.model_dump(mode="json") if a.merge else None,
            "tests": [v.model_dump(mode="json", exclude={"findings"}) for v in a.tests],
        }
        await self._emit(
            etype,
            payload,
            session_id=self._sid(a.to_member),
            severity=Severity.info if status != "failed" else Severity.normal,
        )
        if a.kind == "work":
            if notify:
                await self._handoff(
                    kind="result", src=a.to_member, dst=a.from_member, a=a, summary=a.result_summary or a.error or ""
                )
            manager = self.members.get(a.from_member)
            if manager is not None:
                manager.signal.set()
            if status != "cancelled":
                self._report_finished(a)
        self._wake_scheduler()

    # ------------------------------------------------------------------ testers
    async def _run_tester(
        self,
        tester: TeamMember,
        *,
        subject: Member,
        assignment: TeamAssignment | None,
        round_no: int,
        summary: str,
    ) -> TeamTestVerdict:
        mode: Literal["dependent", "independent"] = (
            "dependent" if tester.test_mode == TestMode.dependent else "independent"
        )
        t = self.members[tester.id]
        if assignment is not None:
            title = f"Test: {assignment.title}" + (f" (tur {round_no})" if round_no > 1 else "")
            task_title, instructions = assignment.title, assignment.instructions
        else:
            title = "Test: ekibin birleştirilmiş çalışması" + (f" (tur {round_no})" if round_no > 1 else "")
            task_title, instructions = self.ex.task.title, self.ex.task.prompt
        ta = await self._new_assignment(
            kind="test" if mode == "dependent" else "check",
            from_member=ENGINE_MEMBER,
            to_member=tester.id,
            title=title,
            instructions=f"{subject.name} üyesinin çalışmasını test et.",
            parent_id=assignment.id if assignment is not None else None,
            target_id=assignment.id if assignment is not None else None,
            status="running",
            round_no=round_no,
        )
        await self._emit(ET.TEAM_ASSIGNMENT_STARTED, self._assignment_payload(ta), session_id=t.state.session_id)
        await self._set_status(subject, "testing")
        verdict = TeamTestVerdict(
            tester=tester.id, member=subject.id, mode=mode, status="error", round=round_no, test_assignment_id=ta.id
        )
        try:
            await self._ensure_available(t)
            prompt = P.tester_prompt(
                tester,
                mode=mode,
                subject_name=subject.name,
                title=task_title,
                instructions=instructions,
                summary=summary,
                changed_files=await self._changed_files(subject),
            )
            text = await self._turn(t, prompt, purpose="test", assignment_id=ta.id, status="testing")
            ta.session_id = t.state.session_id
            parsed = parse_structured("findings", text)
            if parsed is None:
                text = await self._turn(
                    t, retry_instructions("findings"), purpose="test", assignment_id=ta.id, status="testing"
                )
                parsed = parse_structured("findings", text)
            if parsed is None:
                verdict.summary = "Test ajanının sonucu yapılandırılmış biçimde okunamadı."
            else:
                findings: list[dict[str, Any]] = parsed["findings"]
                blocking = [f for f in findings if f["severity"] in BLOCKING_SEVERITIES]
                failed = bool(blocking) or parsed.get("verdict") == "fail"
                counts = {s: sum(1 for f in findings if f["severity"] == s) for s in SEVERITIES}
                verdict.status = "failed" if failed else "passed"
                verdict.findings = findings
                verdict.summary = parsed.get("summary") or (
                    f"{len(findings)} bulgu ({counts['critical']} kritik, {counts['high']} yüksek)."
                    if findings
                    else "Bulgu yok."
                )
        except TeamTurnFailed as e:
            verdict.summary = e.message
        verdict.summary = self.rt.mask(verdict.summary) or ""
        if assignment is not None:
            assignment.tests.append(verdict)
            await self._save_assignment(assignment)
        ta.result_summary = verdict.summary
        ta.tests = [verdict]
        ta.session_id = t.state.session_id
        await self._finish_assignment(
            ta,
            "completed" if verdict.status == "passed" else "failed",
            error=None if verdict.status != "error" else verdict.summary,
        )
        await self._set_status(t, "idle")
        await self._emit(
            ET.TEAM_TEST,
            {
                "tester": tester.id,
                "member": subject.id,
                "status": verdict.status,
                "summary": truncate(verdict.summary, 1000),
                "round": round_no,
                "mode": mode,
                "assignment_id": assignment.id if assignment is not None else None,
                "test_assignment_id": ta.id,
                "findings_count": len(verdict.findings),
                "blocking_count": sum(1 for f in verdict.findings if f.get("severity") in BLOCKING_SEVERITIES),
                "tester_session_id": t.state.session_id,
            },
            session_id=t.state.session_id,
            severity=Severity.normal if verdict.status == "failed" else Severity.info,
        )
        if subject.state.status == "testing":
            await self._set_status(subject, "working" if subject.running else "idle")
        return verdict

    async def _after_merge_checks(self, manager: Member, a: TeamAssignment) -> None:
        if self.settings.independent_tests_trigger != "after_each_merge":
            return
        testers = [
            t
            for t in self.spec.members
            if t.role == TeamRole.tester and t.test_mode == TestMode.independent and t.parent_id == manager.id
        ]
        prev = manager.state.status
        for t in testers:
            await self._run_tester(t, subject=manager, assignment=a, round_no=a.round, summary=a.result_summary or "")
        if testers and manager.state.status != prev:
            await self._set_status(manager, prev)

    # ------------------------------------------------------------------ advisors
    def _advisors(self) -> list[Member]:
        return [m for m in self.members.values() if m.role == TeamRole.advisor]

    def _report_finished(self, a: TeamAssignment) -> None:
        if self.settings.report_mode.value != "each_assignment" or self._stopping:
            return
        for adv in self._advisors():
            advised = adv.spec.parent_id
            if advised is None or a.to_member == advised or a.to_member not in subtree(self.spec, advised):
                continue
            body = P.format_results([a], self.names)
            self._spawn(
                self._report(
                    adv,
                    kind="assignment",
                    about=f"{self.names.get(a.to_member, a.to_member)} — {a.title}",
                    body=body,
                    target=advised,
                    source=a.to_member,
                ),
                f"report-{adv.id}",
            )

    async def _report(
        self, adv: Member, *, kind: str, about: str, body: str, target: str, source: str, emit_report: bool = True
    ) -> str | None:
        if emit_report:
            await self._emit(
                ET.TEAM_REPORT,
                {
                    "from_member": source,
                    "advisor": adv.id,
                    "summary": truncate(body, 2000),
                    "kind": kind,
                    "from_session_id": self._sid(source),
                    "advisor_session_id": adv.state.session_id,
                },
                session_id=adv.state.session_id,
            )
        reports = list(adv.state.reports)
        adv.state.reports.clear()
        prompt = P.report_prompt(kind=kind, about=about, body=body, reports=reports)
        try:
            await self._ensure_available(adv)
            text = await self._turn(adv, prompt, purpose="report", status="working")
        except TeamTurnFailed as e:
            log.warning("advisor %s report failed: %s", adv.id, e.message)
            return None
        finally:
            if not adv.running:
                await self._set_status(adv, "idle")
        advice = (text or "").strip()
        if not advice or advice.rstrip(".").lower() == P.NO_ADVICE.rstrip(".").lower():
            return None
        await self._deliver_advice(adv, target, advice, kind="reply")
        return advice

    async def _deliver_advice(self, adv: Member, target_id: str, text: str, *, kind: str) -> None:
        target = self.members[target_id]
        delivered = "queued"
        if target.running and target.handle is not None:
            try:
                await target.handle.steer(f"## Danışmanın önerisi\n{text}")
                delivered = "steer"
            except Exception:
                delivered = "queued"
        if delivered == "queued":
            target.state.inbox.append(InboxItem(kind="advice", text=text, urgent=False, source=adv.id))
            await self.save()
        await self._emit(
            ET.TEAM_ADVICE,
            {
                "advisor": adv.id,
                "to_member": target_id,
                "text": truncate(self.rt.mask(text) or "", 4000),
                "kind": kind,
                "question": None,
                "advisor_session_id": adv.state.session_id,
                "to_session_id": target.state.session_id,
                "delivered": delivered,
            },
            session_id=adv.state.session_id,
        )

    async def _periodic_loop(self) -> None:
        interval = max(1, self.settings.report_interval_minutes) * PERIODIC_UNIT_S
        while not self._stopping:
            await asyncio.sleep(interval)
            await self.periodic_report()

    async def periodic_report(self) -> None:
        """One periodic progress report to every advisor whose subtree changed since the last one."""
        for adv in self._advisors():
            advised = adv.spec.parent_id
            if advised is None or self.state.reported_activity.get(adv.id) == self.state.activity:
                continue
            self.state.reported_activity[adv.id] = self.state.activity
            scope = subtree(self.spec, advised)
            items = [a for a in self.assignments.values() if a.kind == "work" and a.to_member in scope]
            lines = [
                f"- {a.title} — {self.names.get(a.to_member, a.to_member)}: {P.STATUS_TR.get(a.status, a.status)}"
                for a in sorted(items, key=lambda x: x.seq)
            ]
            body = "\n".join(lines) or "Henüz iş verilmedi."
            self.state.last_periodic = utcnow()
            await self.save()
            await self._report(
                adv, kind="periodic", about=self.names.get(advised, advised), body=body, target=advised, source=advised
            )

    # ------------------------------------------------------------------ tool API
    def _member(self, member_id: str) -> Member:
        m = self.members.get(member_id)
        if m is None:
            raise TeamError(f"Ekipte böyle bir üye yok: {member_id}")
        return m

    async def delegate(
        self, caller_id: str, member_id: str, title: str, instructions: str, depends_on: list[str]
    ) -> TeamAssignment:
        caller = self._member(caller_id)
        if self._finishing or self._stopping:
            raise TeamError("Ekip işini bitiriyor; yeni iş verilemez.")
        subs = self.spec.subordinates(caller_id)
        if not subs:
            raise TeamError("Altında üye olmadığı için iş veremezsin; işi kendin yap.")
        if member_id not in {s.id for s in subs}:
            names = ", ".join(f"{s.id} ({s.name})" for s in subs)
            raise TeamError(
                f"'{member_id}' üyesine iş veremezsin; yalnız doğrudan bağlı üyelerine iş verebilirsin: {names}."
            )
        if not title.strip() or not instructions.strip():
            raise TeamError("İşin başlığı ve talimatı boş olamaz.")
        target = self.members[member_id]
        if target.depth > self.settings.max_depth:
            raise TeamError(f"En fazla derinlik ({self.settings.max_depth}) aşılıyor; bu üyeye iş verilemez.")
        work = sum(1 for a in self.assignments.values() if a.kind == "work")
        if work >= self.settings.max_assignments:
            raise TeamError(
                f"Ekip en fazla iş sayısına ulaştı ({self.settings.max_assignments}); yeni iş verilemez. Mevcut "
                "sonuçlarla işi tamamla."
            )
        if caller is not self.lead and caller.state.current_assignment_id is None:
            raise TeamError("Şu anda üzerinde çalıştığın bir iş yok; iş veremezsin.")
        for dep in depends_on:
            d = self.assignments.get(dep)
            if d is None or d.kind != "work" or d.from_member != caller_id:
                raise TeamError(f"Bilinmeyen veya sana ait olmayan iş kimliği: {dep}")
        a = await self._new_assignment(
            kind="work",
            from_member=caller_id,
            to_member=member_id,
            title=title,
            instructions=instructions,
            depends_on=dict.fromkeys(depends_on),
            parent_id=caller.state.current_assignment_id,
        )
        caller.state.finish_summary = None
        self._wake_scheduler()
        return a

    async def wait(
        self, caller_id: str, ids: list[str] | None, timeout_s: float | None
    ) -> tuple[list[TeamAssignment], list[TeamAssignment]]:
        """(finished results, still open) for the caller's assignments; marks the results delivered."""
        caller = self._member(caller_id)
        if ids:
            for aid in ids:
                a = self.assignments.get(aid)
                if a is None or a.kind != "work" or a.from_member != caller_id:
                    raise TeamError(f"Bilinmeyen veya sana ait olmayan iş kimliği: {aid}")
            targets = list(dict.fromkeys(ids))
        else:
            targets = [a.id for a in self.children(caller_id) if a.status not in TERMINAL or not a.delivered]
        if not targets:
            return [], []
        timeout = WAIT_DEFAULT_S if timeout_s is None else max(0.0, min(float(timeout_s), WAIT_MAX_S))
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        previous: MemberStatus = caller.state.status
        await self._set_status(caller, "waiting")
        try:
            while True:
                caller.signal.clear()
                if all(self.assignments[t].status in TERMINAL for t in targets):
                    break
                if self._stopping:
                    raise TeamError("Ekip durduruldu; bekleme sona erdi.")
                remaining = deadline - loop.time()
                if remaining <= 0:
                    break
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(caller.signal.wait(), remaining)
        finally:
            if caller.state.status == "waiting":
                await self._set_status(caller, previous if previous != "waiting" else "working")
        done = [self.assignments[t] for t in targets if self.assignments[t].status in TERMINAL]
        still = [self.assignments[t] for t in targets if self.assignments[t].status not in TERMINAL]
        for a in done:
            if not a.delivered:
                a.delivered = True
                await self._save_assignment(a)
        return done, still

    async def consult(self, caller_id: str, question: str) -> str:
        caller = self._member(caller_id)
        adv_spec = advisor_in_chain(self.spec, caller_id)
        if adv_spec is None:
            raise TeamError("Zincirinde bir danışman yok; team_consult kullanılamaz.")
        if not question.strip():
            raise TeamError("Soru boş olamaz.")
        adv = self.members[adv_spec.id]
        previous: MemberStatus = caller.state.status
        await self._set_status(caller, "consulting")
        reports = list(adv.state.reports)
        adv.state.reports.clear()
        try:
            await self._ensure_available(adv)
            text = await self._turn(
                adv,
                P.consult_prompt(caller=caller.spec, question=question, reports=reports),
                purpose="consult",
                status="consulting",
            )
        except TeamTurnFailed as e:
            raise TeamError(f"Danışman yanıt veremedi: {e.message}") from e
        finally:
            await self._set_status(caller, previous if previous != "consulting" else "working")
            if not adv.running:
                await self._set_status(adv, "idle")
        answer = (text or "").strip() or "Danışman yanıt vermedi."
        await self._emit(
            ET.TEAM_ADVICE,
            {
                "advisor": adv.id,
                "to_member": caller_id,
                "text": truncate(self.rt.mask(answer) or "", 4000),
                "kind": "consult",
                "question": truncate(self.rt.mask(question) or "", 2000),
                "advisor_session_id": adv.state.session_id,
                "to_session_id": caller.state.session_id,
                "delivered": "answer",
            },
            session_id=adv.state.session_id,
        )
        return answer

    async def report(self, caller_id: str, summary: str) -> str:
        caller = self._member(caller_id)
        adv_spec = advisor_in_chain(self.spec, caller_id)
        if adv_spec is None:
            raise TeamError("Zincirinde bir danışman yok; team_report kullanılamaz.")
        text = summary.strip()
        if not text:
            raise TeamError("Rapor boş olamaz.")
        adv = self.members[adv_spec.id]
        masked = self.rt.mask(text) or ""
        await self._emit(
            ET.TEAM_REPORT,
            {
                "from_member": caller_id,
                "advisor": adv.id,
                "summary": truncate(masked, 2000),
                "kind": "member",
                "from_session_id": caller.state.session_id,
                "advisor_session_id": adv.state.session_id,
            },
            session_id=caller.state.session_id,
        )
        if self.settings.report_mode.value == "on_demand":
            adv.state.reports.append(f"{caller.name}: {masked}")
            await self.save()
            return "on_demand"
        self._spawn(
            self._report(
                adv,
                kind="member",
                about=caller.name,
                body=masked,
                target=caller_id,
                source=caller_id,
                emit_report=False,
            ),
            f"report-{adv.id}",
        )
        return "forwarded"

    async def finish(self, caller_id: str, summary: str) -> list[TeamAssignment]:
        caller = self._member(caller_id)
        if caller.role not in (TeamRole.lead, TeamRole.worker):
            raise TeamError("team_finish yalnız lider ve geliştiriciler içindir.")
        if caller is not self.lead and caller.state.current_assignment_id is None:
            raise TeamError("Şu anda üzerinde çalıştığın bir iş yok.")
        if not summary.strip():
            raise TeamError("Özet boş olamaz.")
        still = self.open_children(caller_id)
        if still:
            titles = ", ".join(f"'{a.title}' ({a.id})" for a in still)
            raise TeamError(f"Henüz bitmemiş işlerin var: {titles}. Önce team_wait ile sonuçlarını bekle.")
        unread = self.undelivered(caller_id)
        for a in unread:
            a.delivered = True
            await self._save_assignment(a)
        caller.state.finish_summary = self.rt.mask(summary.strip())
        await self.save()
        return unread

    async def message_member(self, member_id: str, text: str, mode: Literal["send", "steer"]) -> MemberMessageResult:
        m = self.members.get(member_id)
        if m is None:
            raise NotFound("Ekipte böyle bir üye yok.")
        body = text.strip()
        if not body:
            raise ValidationFailed("Mesaj boş olamaz.")
        delivered: Literal["steer", "queued", "turn", "direct"]
        if mode == "steer" and m.running and m.handle is not None:
            await m.handle.steer(body)
            delivered = "steer"
        elif m.running or m.state.phase == "waiting" or m.state.current_assignment_id or not m.state.session_id:
            m.state.inbox.append(InboxItem(kind="user", text=body, urgent=True, source="user"))
            await self.save()
            m.signal.set()
            delivered = "queued"
        else:
            self._spawn(self._free_turn(m, body), f"message-{m.id}")
            delivered = "turn"
        await self._emit(
            "team.message",
            {"member_id": member_id, "mode": mode, "delivered": delivered, "text": truncate(body, 1000)},
            session_id=m.state.session_id,
        )
        return MemberMessageResult(member_id=member_id, session_id=m.state.session_id, delivered=delivered)

    async def _free_turn(self, m: Member, text: str) -> None:
        try:
            await self._turn(m, f"## Kullanıcıdan mesaj\n{text}", purpose="message")
        except TeamTurnFailed as e:
            log.warning("message turn for %s failed: %s", m.id, e.message)
        finally:
            if m.state.current_assignment_id is None and not m.running:
                await self._set_status(m, "idle")

    # ------------------------------------------------------------------ finishing
    async def _drain(self) -> None:
        """Let background advisor reports finish briefly, then stop everything else."""
        reports = [t for t in self._tasks if "-report-" in t.get_name() and not t.done()]
        if reports:
            await asyncio.wait(reports, timeout=30)
        await self._cancel_tasks()
        for a in sorted(self.assignments.values(), key=lambda x: x.seq):
            if a.status not in TERMINAL:
                await self._finish_assignment(a, "cancelled", error="Ekip işini bitirdi.", notify=False)

    async def _cancel_tasks(self) -> None:
        tasks = [t for t in self._tasks if not t.done()]
        for t in tasks:
            t.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    def _stats(self) -> dict[str, Any]:
        work = [a for a in self.assignments.values() if a.kind == "work"]
        verdicts = [v for a in self.assignments.values() if a.kind != "work" for v in a.tests]
        return {
            "assignments": {
                "total": len(work),
                "completed": sum(1 for a in work if a.status == "completed"),
                "failed": sum(1 for a in work if a.status == "failed"),
                "cancelled": sum(1 for a in work if a.status == "cancelled"),
            },
            "test_rounds": sum(max(0, a.round - 1) for a in work) + self.state.at_end_rounds,
            "test_failures": sum(1 for v in verdicts if v.status == "failed"),
            "merge_conflicts": sum(1 for a in work if a.merge is not None and a.merge.status == "conflict"),
        }

    def _tree(self) -> list[dict[str, Any]]:
        return [
            {
                "id": a.id,
                "kind": a.kind,
                "from": a.from_member,
                "to": a.to_member,
                "title": a.title,
                "status": a.status,
                "parent_id": a.parent_id,
                "target_id": a.target_id,
                "round": a.round,
                "merge": a.merge.status if a.merge else None,
                "summary": truncate(a.result_summary or "", 300),
            }
            for a in sorted(self.assignments.values(), key=lambda x: x.seq)
        ]

    async def _complete(self, summary: str) -> NodeOutcome:
        lead = self.lead
        wm = self.rt.worktrees()
        by_repo: dict[str, list[str]] = {}
        commits: dict[str, str | None] = {}
        branches: dict[str, str] = {}
        for repo_id, wid in lead.state.worktrees.items():
            by_repo[repo_id] = await wm.changed_files(wid)
            commits[wid] = await wm.commit_all(wid, self._commit_message(lead, "ekip çalışması"))
            branches[wid] = (await wm.get(wid)).branch
        names = {r.id: r.name for r in self.repos}
        multi = len(by_repo) > 1
        flat = [f"{names.get(rid, rid)}/{p}" if multi else p for rid, paths in by_repo.items() for p in paths]
        summary = summary.strip() or "Ekip çalışmasını tamamladı."
        stats = self._stats()
        boundaries = (
            lead.agent.boundaries
            if lead.agent is not None
            else await self.nctx.merged_boundaries(None, lead.spec.boundaries)
        )
        data: dict[str, Any] = {
            "session_id": lead.state.session_id,
            # every member session: the boundary gate checks all of their commands
            "session_ids": [m.state.session_id for m in self.members.values() if m.state.session_id],
            "provider": lead.state.provider or lead.spec.provider,
            "model": lead.state.model,
            "role": "writer",
            "profile_id": lead.spec.profile_id,
            "boundaries": boundaries.model_dump(mode="json"),
            "worktree_ids": list(lead.state.worktrees.values()),
            "branches": branches,
            "changed_files": flat,
            "changed_files_by_repo": by_repo,
            "commits": commits,
            "team": {
                "team_id": self.meta.get("team_id"),
                "team_name": self.meta.get("team_name"),
                "members": len(self.spec.members),
                **stats,
                "tree": self._tree(),
            },
            **self.limit_info,
        }
        self.status = "completed"
        for m in self.members.values():
            m.state.current_assignment_id = None
            await self._set_status(m, "done")
        await self.save()
        await self.rt.team_store.update_team_run(
            self.run_id, self.node_id, status="completed", summary=self.rt.mask(summary), error=None
        )
        await self._emit(
            ET.TEAM_FINISHED,
            {"status": "completed", "summary": truncate(self.rt.mask(summary) or "", 2000), "error": None, **stats},
            session_id=lead.state.session_id,
            severity=Severity.normal,
        )
        await self._close_sessions(interrupt=False)
        return NodeOutcome(status="passed", output=summary, data=data)

    async def _abort(self, status: Literal["failed", "cancelled"], reason: str) -> None:
        if self.status != "running":
            return
        self.status = status
        self._stop()
        await self._cancel_tasks()
        for a in sorted(self.assignments.values(), key=lambda x: x.seq):
            if a.status not in TERMINAL:
                await self._finish_assignment(a, "cancelled", error=reason, notify=False)
        for m in self.members.values():
            m.state.current_assignment_id = None
            await self._set_status(m, "error" if status == "failed" and m is self.lead else "done")
        await self.save()
        await self._close_sessions(interrupt=True)
        await self.rt.team_store.update_team_run(self.run_id, self.node_id, status=status, error=reason)
        await self._emit(
            ET.TEAM_FINISHED,
            {"status": status, "summary": None, "error": reason, **self._stats()},
            session_id=self.lead.state.session_id,
            severity=Severity.high if status == "failed" else Severity.info,
        )

    async def _on_cancel(self) -> None:
        if self.nctx.cleanup_on_cancel:
            await self._abort("cancelled", "Ekip iptal edildi.")
        else:  # studiod shutdown: keep the durable state so the team resumes on restart
            self._stop()
            await self._cancel_tasks()

    # ------------------------------------------------------------------ view
    def view(self) -> TeamRunDetail:
        return build_view(
            run_id=self.run_id,
            node_id=self.node_id,
            spec=self.spec,
            state=self.state,
            assignments=self.assignments.values(),
            meta={**self.meta, "status": self.status},
            active=True,
        )
