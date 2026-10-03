"""Agent profiles: persistence, CRUD and the built-in defaults."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel, Field

from aistudio.agents.roles import PROVIDER_NAMES, ROLE_LABELS
from aistudio.agents.tables import agents_profiles
from aistudio.contracts.agents import AgentProfile, AgentRole, Boundaries, SandboxLevel
from aistudio.contracts.common import PROVIDERS, Provider
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, ValidationFailed
from aistudio.core.eventlog import EventLog
from aistudio.core.ids import new_id
from aistudio.storage.db import Database

PROVIDER_COLORS: dict[str, str] = {"claude": "#C96442", "codex": "#10A37F"}

# (role, read_only) for the seeded defaults: Claude/Codex x yazar, inceleyen, danışman, planlayıcı.
_DEFAULT_ROLES: tuple[tuple[AgentRole, bool], ...] = (
    ("writer", False),
    ("reviewer", True),
    ("advisor", True),
    ("planner", True),
)


class AgentProfileOut(AgentProfile):
    builtin: bool = False
    created_at: datetime
    updated_at: datetime


class ProfileCreate(BaseModel):
    workspace_id: str | None = None
    name: str
    provider: Provider
    model: str | None = None
    effort: str | None = None
    role: AgentRole = "writer"
    instructions: str = ""
    boundaries: Boundaries = Field(default_factory=Boundaries)
    color: str | None = None


class ProfileUpdate(BaseModel):
    """Only fields present in the request are changed (``null`` clears model/effort/color)."""

    name: str | None = None
    provider: Provider | None = None
    model: str | None = None
    effort: str | None = None
    role: AgentRole | None = None
    instructions: str | None = None
    boundaries: Boundaries | None = None
    color: str | None = None


def default_profile_id(provider: Provider, role: AgentRole) -> str:
    return f"prf_{provider}_{role}"


def default_profiles() -> list[ProfileCreate]:
    out: list[ProfileCreate] = []
    for provider in PROVIDERS:
        for role, read_only in _DEFAULT_ROLES:
            out.append(
                ProfileCreate(
                    name=f"{PROVIDER_NAMES[provider]} {ROLE_LABELS[role]}",
                    provider=provider,
                    role=role,
                    boundaries=Boundaries(sandbox=SandboxLevel.read_only) if read_only else Boundaries(),
                    color=PROVIDER_COLORS[provider],
                )
            )
    return out


def _row_values(p: AgentProfileOut) -> dict[str, Any]:
    data = p.model_dump(mode="python")
    data["boundaries"] = p.boundaries.model_dump(mode="json")
    return data


class ProfileStore:
    def __init__(self, db: Database, events: EventLog) -> None:
        self._db = db
        self._events = events

    async def get(self, profile_id: str) -> AgentProfileOut:
        async with self._db.connect() as conn:
            row = (
                (await conn.execute(sa.select(agents_profiles).where(agents_profiles.c.id == profile_id)))
                .mappings()
                .first()
            )
        if row is None:
            raise NotFound("Ajan profili bulunamadı.", details={"profile_id": profile_id})
        return AgentProfileOut(**row)

    async def list(self, *, workspace_id: str | None = None, include_global: bool = True) -> list[AgentProfileOut]:
        t = agents_profiles
        stmt = sa.select(t).order_by(t.c.builtin.desc(), t.c.provider, t.c.created_at, t.c.id)
        conds = []
        if workspace_id is not None:
            conds.append(t.c.workspace_id == workspace_id)
        if include_global:
            conds.append(t.c.workspace_id.is_(None))
        if conds:
            stmt = stmt.where(sa.or_(*conds))
        async with self._db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [AgentProfileOut(**r) for r in rows]

    async def create(
        self, req: ProfileCreate, *, profile_id: str | None = None, builtin: bool = False, actor: str = "user"
    ) -> AgentProfileOut:
        name = req.name.strip()
        if not name:
            raise ValidationFailed("Profil adı boş olamaz.")
        now = utcnow()
        profile = AgentProfileOut(
            id=profile_id or new_id("prf"),
            **req.model_dump(exclude={"name"}),
            name=name,
            builtin=builtin,
            created_at=now,
            updated_at=now,
        )
        async with self._db.begin() as conn:
            await conn.execute(agents_profiles.insert().values(**_row_values(profile)))
        await self._events.append(
            "agent.profile.created",
            {"profile_id": profile.id, "name": profile.name, "provider": profile.provider, "role": profile.role},
            actor=actor,
            workspace_id=profile.workspace_id,
        )
        return profile

    async def update(self, profile_id: str, req: ProfileUpdate) -> AgentProfileOut:
        current = await self.get(profile_id)
        changes = req.model_dump(exclude_unset=True)
        for required in ("name", "provider", "role", "instructions", "boundaries"):
            if required in changes and changes[required] is None:
                changes.pop(required)
        if "name" in changes:
            changes["name"] = str(changes["name"]).strip()
            if not changes["name"]:
                raise ValidationFailed("Profil adı boş olamaz.")
        if not changes:
            return current
        updated = current.model_copy(update={**changes, "updated_at": utcnow()})
        if "boundaries" in changes:
            updated.boundaries = Boundaries.model_validate(changes["boundaries"])
        values = _row_values(updated)
        values.pop("id")
        values.pop("created_at")
        async with self._db.begin() as conn:
            await conn.execute(agents_profiles.update().where(agents_profiles.c.id == profile_id).values(**values))
        await self._events.append(
            "agent.profile.updated",
            {"profile_id": profile_id, "fields": sorted(changes)},
            actor="user",
            workspace_id=updated.workspace_id,
        )
        return await self.get(profile_id)

    async def delete(self, profile_id: str) -> None:
        profile = await self.get(profile_id)
        if profile.builtin:
            raise Conflict("Hazır profiller silinemez; düzenleyebilirsiniz.")
        async with self._db.begin() as conn:
            await conn.execute(agents_profiles.delete().where(agents_profiles.c.id == profile_id))
        await self._events.append(
            "agent.profile.deleted",
            {"profile_id": profile_id, "name": profile.name},
            actor="user",
            workspace_id=profile.workspace_id,
        )

    async def seed_defaults(self) -> int:
        """Insert missing built-in profiles (idempotent). Returns how many were created."""
        async with self._db.connect() as conn:
            existing = set((await conn.execute(sa.select(agents_profiles.c.id))).scalars().all())
        created = 0
        for req in default_profiles():
            pid = default_profile_id(req.provider, req.role)
            if pid in existing:
                continue
            await self.create(req, profile_id=pid, builtin=True, actor="system")
            created += 1
        return created
