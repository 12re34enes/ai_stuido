"""Workspace and repo management."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel

from aistudio.contracts.workspaces import Repo, RepoCommands, Workspace
from aistudio.core import proc
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, ValidationFailed
from aistudio.core.eventlog import EventLog
from aistudio.core.ids import new_id
from aistudio.core.text import slugify
from aistudio.storage.db import Database
from aistudio.storage.tables import repos as repos_t
from aistudio.storage.tables import workspaces as ws_t


class WorkspaceCreate(BaseModel):
    name: str
    color: str | None = None
    settings: dict[str, Any] | None = None


class WorkspaceUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    archived: bool | None = None
    settings: dict[str, Any] | None = None


class RepoCreate(BaseModel):
    path: str
    name: str | None = None
    host_id: str | None = None  # remote checkout on an SSH host (validated by the remote module)
    default_branch: str | None = None
    commands: RepoCommands | None = None


class RepoUpdate(BaseModel):
    name: str | None = None
    default_branch: str | None = None
    commands: RepoCommands | None = None


def detect_provider(remote_url: str | None) -> str | None:
    if not remote_url:
        return None
    if "github" in remote_url:
        return "github"
    if "gitlab" in remote_url:
        return "gitlab"
    return None


class WorkspaceServiceImpl:
    def __init__(self, db: Database, events: EventLog) -> None:
        self._db = db
        self._events = events

    # ------------------------------------------------------------------ workspaces
    async def list(self, *, include_archived: bool = False) -> list[Workspace]:
        stmt = sa.select(ws_t).order_by(ws_t.c.created_at)
        if not include_archived:
            stmt = stmt.where(ws_t.c.archived.is_(False))
        async with self._db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [Workspace(**r) for r in rows]

    async def get(self, workspace_id: str) -> Workspace:
        async with self._db.connect() as conn:
            row = (await conn.execute(sa.select(ws_t).where(ws_t.c.id == workspace_id))).mappings().first()
        if row is None:
            raise NotFound("Çalışma alanı bulunamadı.")
        return Workspace(**row)

    async def create(self, req: WorkspaceCreate) -> Workspace:
        name = req.name.strip()
        if not name:
            raise ValidationFailed("Çalışma alanı adı boş olamaz.")
        base = slugify(name, fallback="calisma-alani")
        slug = base
        async with self._db.connect() as conn:
            existing = set((await conn.execute(sa.select(ws_t.c.slug))).scalars().all())
        n = 2
        while slug in existing:
            slug = f"{base}-{n}"
            n += 1
        now = utcnow()
        ws = Workspace(
            id=new_id("ws"),
            name=name,
            slug=slug,
            color=req.color or "#C96442",
            settings=req.settings or {},
            created_at=now,
            updated_at=now,
        )
        async with self._db.begin() as conn:
            await conn.execute(ws_t.insert().values(**ws.model_dump()))
        await self._events.append(
            "workspace.created", {"name": ws.name, "slug": ws.slug}, workspace_id=ws.id, actor="user"
        )
        return ws

    async def update(self, workspace_id: str, req: WorkspaceUpdate) -> Workspace:
        current = await self.get(workspace_id)
        values = req.model_dump(exclude_none=True)
        if "settings" in values:
            values["settings"] = {**current.settings, **values["settings"]}
        if not values:
            return current
        values["updated_at"] = utcnow()
        async with self._db.begin() as conn:
            await conn.execute(ws_t.update().where(ws_t.c.id == workspace_id).values(**values))
        await self._events.append(
            "workspace.updated", {"fields": sorted(values)}, workspace_id=workspace_id, actor="user"
        )
        return await self.get(workspace_id)

    # ------------------------------------------------------------------ repos
    async def repos(self, workspace_id: str) -> list[Repo]:
        async with self._db.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        sa.select(repos_t).where(repos_t.c.workspace_id == workspace_id).order_by(repos_t.c.created_at)
                    )
                )
                .mappings()
                .all()
            )
        return [Repo(**r) for r in rows]

    async def get_repo(self, repo_id: str) -> Repo:
        async with self._db.connect() as conn:
            row = (await conn.execute(sa.select(repos_t).where(repos_t.c.id == repo_id))).mappings().first()
        if row is None:
            raise NotFound("Repo bulunamadı.")
        return Repo(**row)

    async def add_repo(self, workspace_id: str, req: RepoCreate) -> Repo:
        await self.get(workspace_id)
        path = req.path
        remote_url: str | None = None
        default_branch = req.default_branch
        if req.host_id is None:
            p = Path(path).expanduser()
            if not p.is_dir():
                raise ValidationFailed("Klasör bulunamadı.", details={"path": path})
            top = await proc.git("rev-parse", "--show-toplevel", cwd=str(p))
            if top.returncode != 0:
                raise ValidationFailed("Bu klasör bir git reposu değil.", details={"path": path})
            path = top.stdout.strip()
            remote = await proc.git("remote", "get-url", "origin", cwd=path)
            remote_url = remote.stdout.strip() if remote.returncode == 0 else None
            if default_branch is None:
                default_branch = await _detect_default_branch(path)
        async with self._db.connect() as conn:
            dup = (
                await conn.execute(
                    sa.select(repos_t.c.id).where(
                        repos_t.c.workspace_id == workspace_id,
                        repos_t.c.path == path,
                        repos_t.c.host_id.is_(None) if req.host_id is None else repos_t.c.host_id == req.host_id,
                    )
                )
            ).first()
        if dup:
            raise Conflict("Bu repo zaten çalışma alanında.")
        repo = Repo(
            id=new_id("repo"),
            workspace_id=workspace_id,
            name=req.name or Path(path).name,
            path=path,
            host_id=req.host_id,
            remote_url=remote_url,
            provider=detect_provider(remote_url),
            default_branch=default_branch or "main",
            commands=req.commands or RepoCommands(),
            created_at=utcnow(),
        )
        async with self._db.begin() as conn:
            await conn.execute(repos_t.insert().values(**repo.model_dump(mode="python")))
        await self._events.append(
            "repo.added",
            {"repo_id": repo.id, "name": repo.name, "path": repo.path},
            workspace_id=workspace_id,
            actor="user",
        )
        return repo

    async def update_repo(self, repo_id: str, req: RepoUpdate) -> Repo:
        repo = await self.get_repo(repo_id)
        values = req.model_dump(exclude_none=True)
        if not values:
            return repo
        async with self._db.begin() as conn:
            await conn.execute(repos_t.update().where(repos_t.c.id == repo_id).values(**values))
        return await self.get_repo(repo_id)

    async def remove_repo(self, repo_id: str) -> None:
        repo = await self.get_repo(repo_id)
        async with self._db.begin() as conn:
            await conn.execute(repos_t.delete().where(repos_t.c.id == repo_id))
        await self._events.append(
            "repo.removed", {"repo_id": repo_id, "name": repo.name}, workspace_id=repo.workspace_id, actor="user"
        )


async def _detect_default_branch(path: str) -> str:
    head = await proc.git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD", cwd=path)
    if head.returncode == 0:
        m = re.match(r"refs/remotes/origin/(.+)", head.stdout.strip())
        if m:
            return m.group(1)
    cur = await proc.git("rev-parse", "--abbrev-ref", "HEAD", cwd=path)
    name = cur.stdout.strip()
    return name if cur.returncode == 0 and name and name != "HEAD" else "main"
