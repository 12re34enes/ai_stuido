"""Registry of the team nodes running in this process (tools resolve their caller through it)."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aistudio.engine.team.runtime import TeamRun


class TeamHub:
    def __init__(self) -> None:
        self._runs: dict[tuple[str, str], TeamRun] = {}
        self._sessions: dict[str, tuple[TeamRun, str]] = {}

    def add(self, team: TeamRun) -> None:
        self._runs[(team.run_id, team.node_id)] = team

    def remove(self, team: TeamRun) -> None:
        if self._runs.get((team.run_id, team.node_id)) is team:
            self._runs.pop((team.run_id, team.node_id), None)
        for sid, (owner, _member) in list(self._sessions.items()):
            if owner is team:
                self._sessions.pop(sid, None)

    def register_session(self, session_id: str, team: TeamRun, member_id: str) -> None:
        self._sessions[session_id] = (team, member_id)

    def resolve(self, session_id: str) -> tuple[TeamRun, str] | None:
        """The running team and member id a session belongs to."""
        return self._sessions.get(session_id)

    def get(self, run_id: str, node_id: str) -> TeamRun | None:
        return self._runs.get((run_id, node_id))

    def for_run(self, run_id: str) -> list[TeamRun]:
        return [t for (rid, _nid), t in self._runs.items() if rid == run_id]
