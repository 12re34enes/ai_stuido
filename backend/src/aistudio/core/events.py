"""Event model and the catalogue of event types.

Event types are dotted strings ``<domain>.<subject>[.<verb>]``. Each module documents the
payload of the types it emits next to the code that emits them; the constants below are the
cross-module ones that the UI, alerts and replay rely on. Modules may emit additional types
under their own domain prefix (e.g. ``remote.*``, ``deploy.*``).
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class Severity(StrEnum):
    """Also drives alert routing (see alerts module)."""

    info = "info"  # Bilgi
    normal = "normal"  # Normal
    high = "high"  # Yüksek
    critical = "critical"  # Kritik


class Event(BaseModel):
    """A persisted event. ``id`` is a global, gap-free (per database) sequence."""

    id: int
    ts: datetime
    type: str
    severity: Severity = Severity.info
    actor: str = "system"  # "system" | "user" | "agent:<session_id>" | "channel:<kind>"
    workspace_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    session_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    prev_hash: str = ""
    hash: str = ""
    ephemeral: bool = False


class EventFilter(BaseModel):
    """Subscription / query filter. ``None`` fields match anything.

    ``types`` entries ending in ``.*`` match a prefix (``"agent.*"``).
    """

    types: list[str] | None = None
    workspace_id: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    session_id: str | None = None
    include_ephemeral: bool = True

    def matches(self, ev: Event) -> bool:
        if ev.ephemeral and not self.include_ephemeral:
            return False
        for field in ("workspace_id", "task_id", "run_id", "session_id"):
            want = getattr(self, field)
            if want is not None and getattr(ev, field) != want:
                return False
        if self.types:
            return any(ev.type.startswith(t[:-1]) if t.endswith(".*") else ev.type == t for t in self.types)
        return True


class ET:
    """Cross-module event type names."""

    # Normalized agent stream (adapters -> eventlog). Payloads: see contracts/agents.py.
    AGENT_SESSION_STARTED = "agent.session.started"
    AGENT_SESSION_ENDED = "agent.session.ended"
    AGENT_STATUS = "agent.status"
    AGENT_TURN_STARTED = "agent.turn.started"
    AGENT_TURN_COMPLETED = "agent.turn.completed"
    AGENT_MESSAGE_DELTA = "agent.message.delta"  # ephemeral
    AGENT_MESSAGE = "agent.message"
    AGENT_THINKING_DELTA = "agent.thinking.delta"  # ephemeral
    AGENT_THINKING = "agent.thinking"
    AGENT_TOOL_CALL = "agent.tool.call"
    AGENT_TOOL_RESULT = "agent.tool.result"
    AGENT_FILE_CHANGED = "agent.file.changed"
    AGENT_PERMISSION_REQUEST = "agent.permission.request"
    AGENT_PERMISSION_DECIDED = "agent.permission.decided"
    AGENT_USAGE = "agent.usage"
    AGENT_ERROR = "agent.error"
    AGENT_STALLED = "agent.stalled"  # no output for N minutes (critical alert)
    AGENT_HANDOFF = "agent.handoff"

    LIMIT_UPDATED = "limit.updated"
    LIMIT_WARNING = "limit.warning"  # crossed 80%
    LIMIT_EXHAUSTED = "limit.exhausted"
    LIMIT_RESET = "limit.reset"

    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_DECIDED = "approval.decided"

    TASK_CREATED = "task.created"
    TASK_UPDATED = "task.updated"
    TASK_COMPLETED = "task.completed"
    TASK_FAILED = "task.failed"
    RUN_STARTED = "run.started"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"
    RUN_CANCELLED = "run.cancelled"
    NODE_STARTED = "node.started"
    NODE_COMPLETED = "node.completed"
    NODE_FAILED = "node.failed"
    GATE_PASSED = "gate.passed"
    GATE_FAILED = "gate.failed"
    GATE_LOOP_EXHAUSTED = "gate.loop_exhausted"
    BOUNDARY_VIOLATION = "boundary.violation"
    CHECKPOINT_CREATED = "checkpoint.created"
    CONFLICT_DETECTED = "conflict.detected"

    MEMORY_PROPOSED = "memory.proposed"
    MEMORY_APPLIED = "memory.applied"

    REMOTE_COMMAND = "remote.command"
    DB_QUERY = "db.query"

    PR_OPENED = "pr.opened"
    PR_REVIEW = "pr.review"
    PR_CI_FAILED = "pr.ci_failed"
    PR_CI_PASSED = "pr.ci_passed"

    DEPLOY_STARTED = "deploy.started"
    DEPLOY_SUCCEEDED = "deploy.succeeded"
    DEPLOY_FAILED = "deploy.failed"

    SCHEDULE_FIRED = "schedule.fired"
    SYSTEM_NOTICE = "system.notice"
