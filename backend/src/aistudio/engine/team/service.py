"""Team facade used by the engine API: templates, the live team view and member messages."""

from __future__ import annotations

from typing import TYPE_CHECKING

from aistudio.contracts.teams import TeamSpec
from aistudio.core.errors import Conflict, NotFound, ValidationFailed
from aistudio.engine.team.catalog import TeamCatalog
from aistudio.engine.team.models import (
    MemberMessageBody,
    MemberMessageResult,
    TeamRunDetail,
    TeamState,
)
from aistudio.engine.team.store import Row, TeamStore
from aistudio.engine.team.view import build_view

if TYPE_CHECKING:
    from aistudio.engine.service import FlowEngineImpl


class TeamService:
    def __init__(self, engine: FlowEngineImpl) -> None:
        self.engine = engine
        self.catalog = TeamCatalog(engine.rt)

    @property
    def store(self) -> TeamStore:
        return self.engine.rt.team_store

    async def _team_row(self, run_id: str, node_id: str | None) -> Row:
        await self.engine.store.run_row(run_id)  # NotFound for unknown runs
        rows = await self.store.team_run_rows(run_id)
        if node_id is not None:
            rows = [r for r in rows if r["node_id"] == node_id]
        if not rows:
            raise NotFound("Bu koşuda çalışan bir ekip yok." if node_id is None else "Bu ekip düğümü bulunamadı.")
        live = [r for r in rows if self.engine.rt.teams.get(run_id, r["node_id"]) is not None]
        return (live or rows)[-1]

    async def run_view(self, run_id: str, node_id: str | None = None) -> TeamRunDetail:
        row = await self._team_row(run_id, node_id)
        live = self.engine.rt.teams.get(run_id, row["node_id"])
        if live is not None:
            return live.view()
        return build_view(
            run_id=run_id,
            node_id=row["node_id"],
            spec=TeamSpec.model_validate(row["spec"] or {}),
            state=TeamState.model_validate(row["state"] or {}),
            assignments=await self.store.assignments(run_id, row["node_id"]),
            meta={
                "team_id": row["team_id"],
                "team_version": row["team_version"],
                "team_name": row["team_name"],
                "status": row["status"],
                "summary": row["summary"],
                "error": row["error"],
            },
            active=False,
        )

    async def message_member(self, run_id: str, member_id: str, body: MemberMessageBody) -> MemberMessageResult:
        if not body.text.strip():
            raise ValidationFailed("Mesaj boş olamaz.")
        row = await self._team_row(run_id, body.node_id)
        live = self.engine.rt.teams.get(run_id, row["node_id"])
        if live is not None:
            return await live.message_member(member_id, body.text, body.mode)
        state = TeamState.model_validate(row["state"] or {})
        member = state.members.get(member_id)
        if member is None:
            spec = TeamSpec.model_validate(row["spec"] or {})
            if member_id not in {m.id for m in spec.members}:
                raise NotFound("Ekipte böyle bir üye yok.")
        if member is None or not member.session_id:
            raise Conflict("Bu üyenin henüz bir oturumu yok.")
        run_row = await self.engine.store.run_row(run_id)
        handle = await self.engine.rt.agents().handle(member.session_id)
        if body.mode == "steer":
            await handle.steer(body.text.strip())
        else:
            await handle.send(body.text.strip())
        await self.engine.rt.emit(
            "team.message",
            {
                "run_id": run_id,
                "task_id": run_row["task_id"],
                "workspace_id": run_row["workspace_id"],
                "node_id": row["node_id"],
                "member_id": member_id,
                "mode": body.mode,
                "delivered": "direct",
                "text": body.text.strip()[:1000],
            },
            workspace_id=run_row["workspace_id"],
            task_id=run_row["task_id"],
            run_id=run_id,
            session_id=member.session_id,
        )
        return MemberMessageResult(member_id=member_id, session_id=member.session_id, delivered="direct")
