"""In-memory state of a session whose CLI process is (or was) running in this studiod."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import TypedDict

from aistudio.agents.policy import PolicyContext
from aistudio.agents.sessions import TERMINAL_STATES
from aistudio.contracts.agents import AgentRole, AgentSessionHandle, AgentState, SessionSpec
from aistudio.contracts.common import Location, Provider
from aistudio.core.clock import utcnow


class EventIds(TypedDict):
    workspace_id: str | None
    task_id: str | None
    run_id: str | None
    session_id: str | None


@dataclass(eq=False)
class LiveSession:
    id: str
    workspace_id: str
    provider: Provider
    role: AgentRole
    label: str
    location: Location
    cwd: str
    spec: SessionSpec
    policy: PolicyContext
    task_id: str | None = None
    run_id: str | None = None
    node_id: str | None = None
    production: bool = False  # remote session on a production host
    handle: AgentSessionHandle | None = None
    state: AgentState = AgentState.starting
    native_id: str | None = None
    last_activity: float = field(default_factory=time.monotonic)
    last_activity_at: datetime = field(default_factory=utcnow)
    stalled: bool = False
    ended: bool = False
    closing: bool = False

    @property
    def actor(self) -> str:
        return f"agent:{self.id}"

    def ids(self) -> EventIds:
        return {
            "workspace_id": self.workspace_id,
            "task_id": self.task_id,
            "run_id": self.run_id,
            "session_id": self.id,
        }

    def touch(self) -> None:
        self.last_activity = time.monotonic()
        self.last_activity_at = utcnow()
        self.stalled = False

    def is_alive(self) -> bool:
        if self.handle is None or self.ended:
            return False
        try:
            return self.handle.state not in TERMINAL_STATES
        except Exception:
            return False
