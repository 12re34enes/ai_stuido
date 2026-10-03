"""Team orchestration (spec §25): a user-designed hierarchy of agents.

    Danışman (advisor) ··· reports/advice ···  Lider (lead)
                                                 ├── Geliştirici A ── Alt ajan A1, A2
                                                 ├── Geliştirici B
                                                 └── Geliştirici C
                                    Test ajanı (dependent on B) · Test ajanı (independent)

The lead receives the task and DELEGATES assignments to its direct subordinates through Studio
tools; any member with subordinates can delegate further down. Results flow back up (each
member's worktree is merged into its parent's). An optional advisor receives progress reports
and answers consultations. Testers either test one member's output after each of its assignments
(dependent) or test the parent's integrated work (independent).

Implemented by the engine (``team`` node kind). The UI builds and visualizes teams.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field

from aistudio.contracts.agents import Boundaries
from aistudio.contracts.common import Provider


class TeamRole(StrEnum):
    advisor = "advisor"  # Danışman: never writes; answers consultations, receives reports
    lead = "lead"  # Lider: exactly one; owns the task, delegates, integrates
    worker = "worker"  # Geliştirici/uzman: does assignments; may delegate to its own subordinates
    tester = "tester"  # Test ajanı: verifies a member's output (dependent) or the whole (independent)


class TestMode(StrEnum):
    dependent = "dependent"  # runs after each assignment of `tests_member_id`; failures loop back to it
    independent = "independent"  # runs on the parent's integrated worktree (see TeamSettings trigger)


class ReportMode(StrEnum):
    on_demand = "on_demand"  # only when a member calls consult_advisor
    each_assignment = "each_assignment"  # engine reports to the advisor after every finished assignment
    periodic = "periodic"  # engine reports every `report_interval_minutes`


class TeamPosition(BaseModel):
    x: float = 0
    y: float = 0


class TeamMember(BaseModel):
    id: str  # stable within the team: "lead", "dev-a", "dev-a-1", "qa-web"
    name: str  # Turkish display name: "Lider", "Arayüz geliştirici"
    role: TeamRole
    # Who delegates to this member (its manager). lead: None. advisor: the member it advises
    # (usually the lead). tester: the member whose subtree it belongs to (layout + scope).
    parent_id: str | None = None
    provider: Provider = "claude"
    model: str | None = None
    effort: str | None = None  # claude: low|medium|high|xhigh|max ; codex: reasoning effort
    profile_id: str | None = None  # optional agent profile to inherit model/effort/instructions
    instructions: str = ""  # role description shown to the member and to its manager
    writes: bool = True  # advisor is always read-only; testers default to False (may add tests if True)
    tests_member_id: str | None = None  # tester + dependent: the member it verifies
    test_mode: TestMode = TestMode.dependent
    test_command: str | None = None  # optional command the tester must run (e.g. "pnpm e2e")
    boundaries: Boundaries | None = None
    position: TeamPosition | None = None  # builder layout


class TeamSettings(BaseModel):
    report_mode: ReportMode = ReportMode.each_assignment
    report_interval_minutes: int = 15
    max_parallel_members: int = 4  # concurrent member sessions across the team
    max_depth: int = 4  # lead = depth 0
    max_assignments: int = 40  # safety cap per run
    test_max_rounds: int = 2  # dependent test failures sent back to the member at most this often
    independent_tests_trigger: Literal["after_each_merge", "at_end"] = "at_end"
    merge_strategy: Literal["merge", "squash"] = "merge"  # member branch -> parent branch


class TeamSpec(BaseModel):
    members: list[TeamMember] = Field(default_factory=list)
    settings: TeamSettings = Field(default_factory=TeamSettings)

    def member(self, member_id: str) -> TeamMember:
        for m in self.members:
            if m.id == member_id:
                return m
        raise KeyError(member_id)

    def lead(self) -> TeamMember:
        leads = [m for m in self.members if m.role == TeamRole.lead]
        if len(leads) != 1:
            raise ValueError("ekipte tam olarak bir lider olmalı")
        return leads[0]

    def subordinates(self, member_id: str) -> list[TeamMember]:
        """Members this one may delegate to (workers directly under it; not advisors/testers)."""
        return [m for m in self.members if m.parent_id == member_id and m.role == TeamRole.worker]

    def advisor_of(self, member_id: str) -> TeamMember | None:
        for m in self.members:
            if m.role == TeamRole.advisor and m.parent_id == member_id:
                return m
        return None

    def testers_of(self, member_id: str) -> list[TeamMember]:
        return [
            m
            for m in self.members
            if m.role == TeamRole.tester and m.test_mode == TestMode.dependent and m.tests_member_id == member_id
        ]


class Team(BaseModel):
    """A saved, versioned team template (``/api/engine/teams``)."""

    id: str
    workspace_id: str | None = None
    name: str
    description: str = ""
    version: int = 1
    builtin: bool = False
    spec: TeamSpec
    created_at: datetime | None = None
    updated_at: datetime | None = None


AssignmentStatus = Literal["pending", "blocked", "running", "testing", "completed", "failed", "cancelled"]


class AssignmentMerge(BaseModel):
    status: Literal["clean", "conflict", "skipped"]
    conflicts: list[str] = Field(default_factory=list)
    commit_sha: str | None = None


class Assignment(BaseModel):
    """One delegated piece of work: from a manager to a subordinate (or engine -> tester)."""

    id: str
    run_id: str
    node_id: str  # the team node in the flow
    from_member: str  # delegating member id ("engine" for tester runs)
    to_member: str
    title: str
    instructions: str
    depends_on: list[str] = Field(default_factory=list)  # assignment ids that must complete first
    status: AssignmentStatus = "pending"
    round: int = 1  # dependent-test fix rounds
    session_id: str | None = None
    worktree_id: str | None = None
    result_summary: str | None = None
    error: str | None = None
    merge: AssignmentMerge | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class TeamMemberState(BaseModel):
    """Live state of one member in a running team (``GET /api/engine/runs/{id}/team``)."""

    member_id: str
    status: Literal["idle", "working", "waiting", "testing", "consulting", "done", "error"] = "idle"
    session_id: str | None = None
    worktree_id: str | None = None
    current_assignment_id: str | None = None
    completed: int = 0
    failed: int = 0


class TeamRunView(BaseModel):
    run_id: str
    node_id: str
    spec: TeamSpec
    members: list[TeamMemberState] = Field(default_factory=list)
    assignments: list[Assignment] = Field(default_factory=list)
