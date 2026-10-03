"""Engine-local team models: API bodies, persisted runtime state and API views.

The cross-module shapes (``TeamSpec``, ``Team``, ``Assignment``, ``TeamMemberState``,
``TeamRunView``) live in ``aistudio.contracts.teams``. The views here extend them with fields the
engine also knows (assignment kind, test verdicts, live provider...); every contract field keeps
its name, so a client written against the contract can read them unchanged.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from aistudio.contracts.common import Provider
from aistudio.contracts.teams import Assignment, TeamMemberState, TeamSpec

MemberStatus = Literal["idle", "working", "waiting", "testing", "consulting", "done", "error"]
AssignmentKind = Literal["work", "test", "check"]  # check = independent tester run
AssignmentPhase = Literal["work", "test", "merge", "done"]
ENGINE_MEMBER = "engine"  # from_member of tester assignments

# --------------------------------------------------------------------------- templates API


class TeamCreate(BaseModel):
    workspace_id: str | None = None
    name: str
    description: str = ""
    spec: TeamSpec


class TeamUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    spec: TeamSpec | None = None


class TeamVersionInfo(BaseModel):
    version: int
    name: str
    created_by: str
    created_at: datetime | None = None


class TeamIssue(BaseModel):
    code: str
    message: str  # Turkish
    member_id: str | None = None


class TeamValidationReport(BaseModel):
    ok: bool
    errors: list[TeamIssue] = Field(default_factory=list)
    warnings: list[TeamIssue] = Field(default_factory=list)


class MemberMessageBody(BaseModel):
    text: str
    mode: Literal["send", "steer"] = "send"
    node_id: str | None = None  # which team node (runs with several team nodes)


class MemberMessageResult(BaseModel):
    member_id: str
    session_id: str | None = None
    # steer: injected into the running turn; queued: delivered with the member's next turn;
    # turn: started a new turn now; direct: the team is not running, sent straight to the session
    delivered: Literal["steer", "queued", "turn", "direct"]


# --------------------------------------------------------------------------- persisted runtime state


class TurnRecord(BaseModel):
    """The member's latest turn (re-attached or re-sent after a restart)."""

    key: str
    purpose: str  # lead | assignment | deliver | fix | consult | report | test | message
    assignment_id: str | None = None
    message: str = ""
    turn_id: str | None = None
    sent: bool = False
    done: bool = False
    text: str | None = None


class InboxItem(BaseModel):
    """A message waiting for the member's next turn (advice, test failure, user message)."""

    kind: Literal["advice", "test", "user", "note"]
    text: str
    urgent: bool = False  # urgent items start a new turn by themselves; advice rides along
    source: str | None = None


class MemberState(BaseModel):
    member_id: str
    status: MemberStatus = "idle"
    session_id: str | None = None
    provider: Provider | None = None
    model: str | None = None
    effort: str | None = None
    switched_from: Provider | None = None
    worktrees: dict[str, str] = Field(default_factory=dict)  # repo id -> worktree id
    current_assignment_id: str | None = None
    completed: int = 0
    failed: int = 0
    turn: TurnRecord | None = None
    phase: Literal["idle", "turn", "waiting"] = "idle"
    finish_summary: str | None = None
    inbox: list[InboxItem] = Field(default_factory=list)
    reports: list[str] = Field(default_factory=list)  # explicit reports kept for the next consultation
    turns: int = 0


class TeamState(BaseModel):
    """``engine_team_runs.state``."""

    attempt: int = 1
    members: dict[str, MemberState] = Field(default_factory=dict)
    seq: int = 0
    at_end_rounds: int = 0
    last_periodic: datetime | None = None
    activity: int = 0  # bumped on every assignment state change (periodic reports skip idle periods)
    reported_activity: dict[str, int] = Field(default_factory=dict)  # advisor id -> activity at last report


# --------------------------------------------------------------------------- views


class TeamTestVerdict(BaseModel):
    tester: str
    member: str
    mode: Literal["dependent", "independent"]
    status: Literal["passed", "failed", "error"]
    summary: str = ""
    round: int = 1
    findings: list[dict[str, Any]] = Field(default_factory=list)
    test_assignment_id: str | None = None


class TeamAssignment(Assignment):
    """An assignment as the engine stores it (contract fields + engine-only details)."""

    seq: int = 0
    kind: AssignmentKind = "work"
    parent_id: str | None = None  # assignment of from_member it was delegated in (tree)
    target_id: str | None = None  # test/check: the assignment under test
    phase: AssignmentPhase = "work"
    tests: list[TeamTestVerdict] = Field(default_factory=list)
    delivered: bool = False  # result handed to the manager (team_wait or a turn message)

    def contract(self) -> Assignment:
        return Assignment.model_validate(self.model_dump(include=set(Assignment.model_fields)))


class TeamMemberView(TeamMemberState):
    name: str = ""
    role: str = ""
    parent_id: str | None = None
    provider: Provider | None = None
    model: str | None = None
    effort: str | None = None
    switched_from: Provider | None = None


class TeamRunDetail(BaseModel):
    """``GET /api/engine/runs/{run_id}/team``: every ``TeamRunView`` field plus run details."""

    run_id: str
    node_id: str
    spec: TeamSpec
    members: list[TeamMemberView] = Field(default_factory=list)
    assignments: list[TeamAssignment] = Field(default_factory=list)
    team_id: str | None = None
    team_version: int | None = None
    team_name: str = ""
    status: Literal["running", "completed", "failed", "cancelled"] = "running"
    summary: str | None = None
    error: str | None = None
    attempt: int = 1
    active: bool = False  # the team is running in this studiod process right now
