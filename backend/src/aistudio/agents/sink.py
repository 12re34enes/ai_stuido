"""Adapter -> event log bridge for one session.

Every normalized payload is written to the event log under ``PAYLOAD_EVENT_TYPE`` (deltas are
published ephemerally), with the session's workspace/task/run/session ids and actor
``agent:<session_id>``. The session row follows along (state, native id, model, last usage),
CLI-native subagent payloads update the :class:`SubagentIndex` (they never touch the session's
state or ``last_usage``) and limit observations are forwarded to the ``LimitService``. Every
payload - subagent ones included - counts as activity for the stall watchdog. A failing sink
never breaks the adapter: errors are logged.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel

from aistudio.agents.live import LiveSession
from aistudio.agents.sessions import SessionRepo
from aistudio.agents.subagents import SubagentIndex, subagent_of
from aistudio.contracts.agents import (
    EPHEMERAL_PAYLOADS,
    PAYLOAD_EVENT_TYPE,
    AgentErrorEv,
    AgentEventPayload,
    AgentState,
    SessionEnded,
    SessionStarted,
    StatusChanged,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.contracts.limits import LimitService, LimitWindow
from aistudio.core.context import AppContext
from aistudio.core.events import Severity

log = logging.getLogger(__name__)

EndedCallback = Callable[[LiveSession], Awaitable[None]]


def payload_severity(payload: BaseModel, *, closing: bool = False) -> Severity:
    if isinstance(payload, AgentErrorEv):
        return Severity.high
    if isinstance(payload, SessionEnded):
        if payload.reason == "error" or (payload.reason == "killed" and not closing):
            return Severity.critical  # agent crashed (spec §15)
        return Severity.info
    if isinstance(payload, TurnCompleted) and payload.status == "error":
        return Severity.normal
    return Severity.info


class SessionSink:
    """:class:`aistudio.contracts.agents.AgentEventSink` for one live session."""

    def __init__(
        self,
        ctx: AppContext,
        repo: SessionRepo,
        live: LiveSession,
        on_ended: EndedCallback,
        subagents: SubagentIndex | None = None,
    ) -> None:
        self._ctx = ctx
        self._repo = repo
        self._live = live
        self._on_ended = on_ended
        self._subagents = subagents

    async def emit(self, payload: AgentEventPayload) -> None:
        try:
            await self._emit(payload)
        except Exception:
            log.exception("agent sink failed for session %s", self._live.id)

    async def limits(self, windows: list[LimitWindow]) -> None:
        if not windows:
            return
        svc = self._ctx.services.maybe(LimitService)  # type: ignore[type-abstract]
        if svc is None:
            return
        try:
            await svc.record(windows)
        except Exception:
            log.exception("limit recording failed for session %s", self._live.id)

    async def _emit(self, payload: AgentEventPayload) -> None:
        live = self._live
        etype = PAYLOAD_EVENT_TYPE.get(type(payload))
        if etype is None:
            log.warning("unknown agent payload %s from session %s", type(payload).__name__, live.id)
            return
        live.touch()
        data = payload.model_dump(mode="json")
        if isinstance(payload, EPHEMERAL_PAYLOADS):
            self._ctx.events.publish_ephemeral(etype, data, actor=live.actor, **live.ids())
            return
        await self._ctx.events.append(
            etype, data, severity=payload_severity(payload, closing=live.closing), actor=live.actor, **live.ids()
        )
        if self._subagents is not None:
            try:
                if subagent_of(payload) is not None:
                    await self._subagents.apply(live.id, payload)
                elif isinstance(payload, SessionEnded):
                    await self._subagents.end_session(live.id)
                    self._subagents.forget(live.id)
            except Exception:
                log.exception("subagent index update failed for session %s", live.id)
        changes = self._apply(payload)
        if "state" in changes and not isinstance(payload, StatusChanged):
            # State moved implicitly (turn started/completed, session ended): publish it too, so
            # status indicators never depend on the adapter also emitting StatusChanged.
            await self._ctx.events.append(
                PAYLOAD_EVENT_TYPE[StatusChanged],
                {"state": changes["state"].value, "detail": None, "implicit": True},
                actor=live.actor,
                **live.ids(),
            )
        if changes:
            await self._repo.update(live.id, **changes)
        if isinstance(payload, SessionEnded):
            await self._on_ended(live)

    def _set_state(self, state: AgentState, changes: dict[str, Any]) -> None:
        if self._live.state != state:
            self._live.state = state
            changes["state"] = state

    def _apply(self, payload: AgentEventPayload) -> dict[str, Any]:
        """Update the in-memory session and return the row changes for this payload."""
        live = self._live
        changes: dict[str, Any] = {}
        if isinstance(payload, SessionStarted):
            if payload.native_id and payload.native_id != live.native_id:
                live.native_id = payload.native_id
                changes["native_id"] = payload.native_id
            if payload.model:
                changes["model"] = payload.model
        elif isinstance(payload, StatusChanged):
            if not live.ended:
                self._set_state(payload.state, changes)
        elif isinstance(payload, TurnStarted):
            if live.state in (AgentState.idle, AgentState.starting, AgentState.interrupted):
                self._set_state(AgentState.thinking, changes)
        elif isinstance(payload, TurnCompleted):
            if not live.ended:
                self._set_state(AgentState.idle, changes)
            if payload.usage is not None:
                changes["last_usage"] = payload.usage
        elif isinstance(payload, Usage):
            if payload.subagent_id is None:  # subagent usage lives in the subagent index
                changes["last_usage"] = payload
        elif isinstance(payload, SessionEnded):
            live.ended = True
            graceful = payload.reason in ("completed", "closed") or live.closing
            self._set_state(AgentState.done if graceful else AgentState.error, changes)
        return changes
