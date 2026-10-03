"""Studio templates: built-ins, user versions and instantiation (spec §16).

Version semantics:
    * Built-in studios ship as package YAML and are always version 1 (``builtin=True``).
    * ``save`` never overwrites: it stores a new row in ``studios_versions`` with the next
      version number (``builtin=False``). Saving a built-in id creates version 2, 3, ...; the
      original stays retrievable with ``get(id, version=1)``.
    * ``get(id)`` / ``list()`` return the latest version of each studio.

Events: ``studio.saved`` {studio_id, version, name}.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel

from aistudio.contracts.common import Environment
from aistudio.contracts.deploy import DeployService
from aistudio.contracts.flows import FlowGraph
from aistudio.contracts.remote import RemoteService
from aistudio.contracts.studios import Studio, StudioInput
from aistudio.contracts.workspaces import Repo, WorkspaceService
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound, StudioError, Unavailable, ValidationFailed
from aistudio.studios.binding import bind_inputs
from aistudio.studios.loader import load_builtin_studios
from aistudio.studios.tables import studios_versions as versions_t
from aistudio.studios.validation import GraphValidation, validate_graph, validate_studio

ENV_LABELS = {Environment.local: "yerel", Environment.test: "test", Environment.production: "production"}


class StudioVersionInfo(BaseModel):
    studio_id: str
    version: int
    name: str
    builtin: bool
    note: str | None = None
    created_at: datetime | None = None


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip()) or value == []


class StudioServiceImpl:
    def __init__(self, ctx: AppContext) -> None:
        self._ctx = ctx
        self._builtin: dict[str, Studio] | None = None
        self._builtin_lock = asyncio.Lock()
        self._save_lock = asyncio.Lock()

    # ------------------------------------------------------------------ built-ins
    async def builtins(self) -> dict[str, Studio]:
        if self._builtin is None:
            async with self._builtin_lock:
                if self._builtin is None:
                    self._builtin = await asyncio.to_thread(load_builtin_studios)
        return self._builtin

    # ------------------------------------------------------------------ queries
    async def _latest_rows(self) -> dict[str, Studio]:
        latest = (
            sa.select(versions_t.c.studio_id, sa.func.max(versions_t.c.version).label("v"))
            .group_by(versions_t.c.studio_id)
            .subquery()
        )
        stmt = sa.select(versions_t.c.data).join(
            latest, sa.and_(versions_t.c.studio_id == latest.c.studio_id, versions_t.c.version == latest.c.v)
        )
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).scalars().all()
        studios = [Studio.model_validate(r) for r in rows]
        return {s.id: s for s in studios}

    async def list(self) -> list[Studio]:
        builtins = await self.builtins()
        stored = await self._latest_rows()
        out = [stored.get(sid, b).model_copy(deep=True) for sid, b in builtins.items()]
        custom = [s for sid, s in stored.items() if sid not in builtins]
        custom.sort(key=lambda s: (s.name.casefold(), s.id))
        return out + custom

    async def get(self, studio_id: str, version: int | None = None) -> Studio:
        builtins = await self.builtins()
        stmt = sa.select(versions_t.c.data).where(versions_t.c.studio_id == studio_id)
        if version is None:
            stmt = stmt.order_by(versions_t.c.version.desc()).limit(1)
        else:
            stmt = stmt.where(versions_t.c.version == version)
        async with self._ctx.db.connect() as conn:
            row = (await conn.execute(stmt)).scalar()
        if row is not None:
            return Studio.model_validate(row)
        if studio_id in builtins and version in (None, 1):
            return builtins[studio_id].model_copy(deep=True)
        if version is not None and (studio_id in builtins or await self._exists(studio_id)):
            raise NotFound("Stüdyonun bu sürümü bulunamadı.", details={"studio_id": studio_id, "version": version})
        raise NotFound("Stüdyo bulunamadı.", details={"studio_id": studio_id})

    async def _exists(self, studio_id: str) -> bool:
        async with self._ctx.db.connect() as conn:
            row = (await conn.execute(sa.select(versions_t.c.id).where(versions_t.c.studio_id == studio_id))).first()
        return row is not None

    async def versions(self, studio_id: str) -> list[StudioVersionInfo]:
        stmt = (
            sa.select(versions_t.c.version, versions_t.c.data, versions_t.c.note, versions_t.c.created_at)
            .where(versions_t.c.studio_id == studio_id)
            .order_by(versions_t.c.version.desc())
        )
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).all()
        out = [
            StudioVersionInfo(
                studio_id=studio_id,
                version=v,
                name=str(data.get("name", studio_id)),
                builtin=False,
                note=note,
                created_at=created,
            )
            for v, data, note, created in rows
        ]
        builtins = await self.builtins()
        if studio_id in builtins:
            b = builtins[studio_id]
            out.append(StudioVersionInfo(studio_id=studio_id, version=1, name=b.name, builtin=True))
        if not out:
            raise NotFound("Stüdyo bulunamadı.", details={"studio_id": studio_id})
        return out

    # ------------------------------------------------------------------ changes
    def validate(self, studio: Studio) -> GraphValidation:
        return validate_studio(studio)

    def validate_graph(self, graph: FlowGraph, inputs: list[StudioInput] | None = None) -> GraphValidation:
        return validate_graph(graph, inputs=inputs)

    async def save(self, studio: Studio, *, note: str | None = None, actor: str = "user") -> Studio:
        report = validate_studio(studio)
        if not report.ok:
            raise ValidationFailed(
                "Stüdyo kaydedilemedi: şablonda hatalar var.",
                details={"errors": [e.model_dump() for e in report.errors]},
            )
        builtins = await self.builtins()
        async with self._save_lock:
            async with self._ctx.db.connect() as conn:
                current = (
                    await conn.execute(
                        sa.select(sa.func.max(versions_t.c.version)).where(versions_t.c.studio_id == studio.id)
                    )
                ).scalar()
            floor = 1 if studio.id in builtins else 0
            version = max(int(current or 0), floor) + 1
            now = utcnow()
            stored = studio.model_copy(update={"version": version, "builtin": False, "updated_at": now}, deep=True)
            async with self._ctx.db.begin() as conn:
                await conn.execute(
                    versions_t.insert().values(
                        studio_id=stored.id,
                        version=version,
                        data=stored.model_dump(mode="json"),
                        note=(note or "").strip() or None,
                        created_at=now,
                    )
                )
        await self._ctx.events.append(
            "studio.saved",
            {"studio_id": stored.id, "version": version, "name": stored.name},
            actor=actor,
        )
        return stored

    # ------------------------------------------------------------------ instantiate
    async def instantiate(self, studio_id: str, *, workspace_id: str, inputs: dict[str, Any]) -> FlowGraph:
        studio = await self.get(studio_id)
        workspaces = self._ctx.services.maybe(WorkspaceService)  # type: ignore[type-abstract]
        if workspaces is not None:
            await workspaces.get(workspace_id)  # NotFound for an unknown workspace
        values = await self.resolve_inputs(studio, workspace_id=workspace_id, inputs=inputs)
        return bind_inputs(studio.graph, values)

    async def resolve_inputs(self, studio: Studio, *, workspace_id: str, inputs: dict[str, Any]) -> dict[str, Any]:
        """Validate required inputs, apply defaults and check referenced resources.

        Every declared input ends up in the result (optional empty ones as ``""``) so templates
        can use them without ``is defined`` guards. Undeclared keys are passed through.
        """
        declared = {i.name for i in studio.inputs}
        values: dict[str, Any] = {k: v for k, v in inputs.items() if k not in declared}
        errors: dict[str, str] = {}
        repos: list[Repo] | None = None
        for spec in studio.inputs:
            raw = inputs.get(spec.name)
            if isinstance(raw, str):
                raw = raw.strip()
            if _blank(raw):
                raw = spec.default.strip() if isinstance(spec.default, str) else spec.default
            if _blank(raw):
                if spec.required:
                    errors[spec.name] = f"“{spec.label}” alanı zorunlu."
                else:
                    values[spec.name] = ""
                continue
            try:
                if spec.type == "select" and spec.options and raw not in spec.options:
                    raise ValidationFailed(f"Geçersiz seçim. Seçenekler: {', '.join(spec.options)}.")
                if spec.type == "repo":
                    if repos is None:
                        repos = await self._repos(workspace_id)
                    raw = self._resolve_repo(repos, str(raw)) if repos is not None else raw
                elif spec.type == "deploy_profile":
                    await self._check_deploy_profile(spec, str(raw), workspace_id)
                elif spec.type == "host":
                    await self._check_host(spec, str(raw))
            except StudioError as e:
                errors[spec.name] = e.message
                continue
            values[spec.name] = raw
        if errors:
            raise ValidationFailed("Stüdyo girdileri eksik veya geçersiz.", details={"errors": errors})
        return values

    async def _repos(self, workspace_id: str) -> list[Repo] | None:
        workspaces = self._ctx.services.maybe(WorkspaceService)  # type: ignore[type-abstract]
        return None if workspaces is None else await workspaces.repos(workspace_id)

    @staticmethod
    def _resolve_repo(repos: list[Repo], value: str) -> str:
        for r in repos:
            if value in (r.id, r.name):
                return r.id
        if not repos:
            raise ValidationFailed("Bu çalışma alanında henüz repo yok; önce bir repo ekleyin.")
        raise ValidationFailed("Bu çalışma alanında böyle bir repo yok.")

    def _environment_error(self, spec: StudioInput, actual: Environment) -> ValidationFailed:
        assert spec.environment is not None
        return ValidationFailed(
            f"Bu alan yalnız {ENV_LABELS[spec.environment]} ortamındaki hedefleri kabul eder; "
            f"seçilen hedef {ENV_LABELS[actual]} ortamında."
        )

    async def _check_deploy_profile(self, spec: StudioInput, profile_id: str, workspace_id: str) -> None:
        deploy = self._ctx.services.maybe(DeployService)  # type: ignore[type-abstract]
        if deploy is None:
            if spec.environment is not None:  # fail closed: the environment cannot be verified
                raise Unavailable("Deploy servisi hazır değil; profilin ortamı doğrulanamadı.")
            return
        profile = await deploy.get_profile(profile_id)
        if profile.workspace_id != workspace_id:
            raise ValidationFailed("Seçilen deploy profili bu çalışma alanına ait değil.")
        if spec.environment is not None and profile.environment != spec.environment:
            raise self._environment_error(spec, profile.environment)

    async def _check_host(self, spec: StudioInput, host_id: str) -> None:
        remote = self._ctx.services.maybe(RemoteService)  # type: ignore[type-abstract]
        if remote is None:
            if spec.environment is not None:
                raise Unavailable("Uzak bağlantı servisi hazır değil; sunucunun ortamı doğrulanamadı.")
            return
        host = await remote.get_host(host_id)
        if spec.environment is not None and host.environment != spec.environment:
            raise self._environment_error(spec, host.environment)
