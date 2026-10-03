"""HTTP API of the agents module (mounted under ``/api/agents``)."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter
from pydantic import BaseModel

from aistudio.agents.manager import AgentManagerImpl
from aistudio.agents.profiles import AgentProfileOut, ProfileCreate, ProfileUpdate
from aistudio.agents.subagents import SubagentCounts, SubagentView
from aistudio.contracts.agents import AdapterHealth, NativeSessionInfo, SessionRecord, StartSessionRequest
from aistudio.contracts.common import Location


class TextBody(BaseModel):
    text: str


class SendResult(BaseModel):
    turn_id: str


class SessionView(SessionRecord):
    live: bool = False  # a CLI process is attached in this studiod
    subagent_count: int = 0  # CLI-native subagents seen in this session (all statuses)
    active_subagents: int = 0  # of which still running


class DiscoveredSession(NativeSessionInfo):
    imported_session_id: str | None = None  # already added to the studio


class ImportBody(BaseModel):
    workspace_id: str
    session: NativeSessionInfo


def _location(host_id: str | None) -> Location:
    return Location.remote(host_id) if host_id else Location.local()


def build_router(get_manager: Callable[[], AgentManagerImpl]) -> APIRouter:
    r = APIRouter(prefix="/agents", tags=["agents"])

    async def views(m: AgentManagerImpl, recs: list[SessionRecord]) -> list[SessionView]:
        counts = await m.subagents.counts(r.id for r in recs)
        out: list[SessionView] = []
        for rec in recs:
            c = counts.get(rec.id) or SubagentCounts()
            out.append(
                SessionView(
                    **rec.model_dump(),
                    live=m.is_live(rec.id),
                    subagent_count=c.total,
                    active_subagents=c.active,
                )
            )
        return out

    async def view(m: AgentManagerImpl, rec: SessionRecord) -> SessionView:
        return (await views(m, [rec]))[0]

    # ------------------------------------------------------------------ profiles
    @r.get("/profiles", response_model=list[AgentProfileOut])
    async def list_profiles(workspace_id: str | None = None, include_global: bool = True) -> list[AgentProfileOut]:
        return await get_manager().profiles.list(workspace_id=workspace_id, include_global=include_global)

    @r.post("/profiles", response_model=AgentProfileOut, status_code=201)
    async def create_profile(body: ProfileCreate) -> AgentProfileOut:
        return await get_manager().profiles.create(body)

    @r.get("/profiles/{profile_id}", response_model=AgentProfileOut)
    async def get_profile(profile_id: str) -> AgentProfileOut:
        return await get_manager().profiles.get(profile_id)

    @r.patch("/profiles/{profile_id}", response_model=AgentProfileOut)
    async def update_profile(profile_id: str, body: ProfileUpdate) -> AgentProfileOut:
        return await get_manager().profiles.update(profile_id, body)

    @r.delete("/profiles/{profile_id}", status_code=204)
    async def delete_profile(profile_id: str) -> None:
        await get_manager().profiles.delete(profile_id)

    # ------------------------------------------------------------------ sessions
    @r.get("/sessions", response_model=list[SessionView])
    async def list_sessions(
        workspace_id: str | None = None, run_id: str | None = None, active_only: bool = False
    ) -> list[SessionView]:
        m = get_manager()
        return await views(m, await m.list(workspace_id=workspace_id, run_id=run_id, active_only=active_only))

    @r.post("/sessions", response_model=SessionView, status_code=201)
    async def start_session(body: StartSessionRequest) -> SessionView:
        m = get_manager()
        return await view(m, await m.start_session(body))

    @r.get("/sessions/{session_id}", response_model=SessionView)
    async def get_session(session_id: str) -> SessionView:
        m = get_manager()
        return await view(m, await m.get(session_id))

    @r.get("/sessions/{session_id}/subagents", response_model=list[SubagentView])
    async def list_subagents(session_id: str) -> list[SubagentView]:
        """CLI-native subagents of the session as a flat, tree-ready list (parents first)."""
        return await get_manager().list_subagents(session_id)

    @r.post("/sessions/{session_id}/send", response_model=SendResult)
    async def send(session_id: str, body: TextBody) -> SendResult:
        return SendResult(turn_id=await get_manager().send(session_id, body.text))

    @r.post("/sessions/{session_id}/steer", status_code=204)
    async def steer(session_id: str, body: TextBody) -> None:
        await get_manager().steer(session_id, body.text)

    @r.post("/sessions/{session_id}/interrupt", status_code=204)
    async def interrupt(session_id: str) -> None:
        await get_manager().interrupt(session_id)

    @r.post("/sessions/{session_id}/close", response_model=SessionView)
    async def close(session_id: str) -> SessionView:
        m = get_manager()
        return await view(m, await m.close(session_id))

    # ------------------------------------------------------------------ health, discovery, import
    @r.get("/health", response_model=list[AdapterHealth])
    async def health(host_id: str | None = None) -> list[AdapterHealth]:
        return await get_manager().health(_location(host_id))

    @r.get("/discover", response_model=list[DiscoveredSession])
    async def discover(host_id: str | None = None, cwd: str | None = None) -> list[DiscoveredSession]:
        m = get_manager()
        found = await m.discover(_location(host_id), cwd=cwd or None)
        index = await m.imported_index(found)
        return [
            DiscoveredSession(**i.model_dump(), imported_session_id=index.get((i.provider, i.native_id))) for i in found
        ]

    @r.post("/import", response_model=SessionView, status_code=201)
    async def import_session(body: ImportBody) -> SessionView:
        m = get_manager()
        return await view(m, await m.import_native(body.workspace_id, body.session))

    return r
