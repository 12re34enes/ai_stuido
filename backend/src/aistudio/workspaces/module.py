from __future__ import annotations

from fastapi import APIRouter

from aistudio.contracts.workspaces import Repo, Workspace, WorkspaceService
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.workspaces.service import (
    RepoCreate,
    RepoUpdate,
    WorkspaceCreate,
    WorkspaceServiceImpl,
    WorkspaceUpdate,
)


class WorkspacesModule(Module):
    name = "workspaces"

    def __init__(self) -> None:
        self.svc: WorkspaceServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        self.svc = WorkspaceServiceImpl(ctx.db, ctx.events)
        ctx.services.register(WorkspaceService, self.svc)  # type: ignore[type-abstract]
        ctx.services.register(WorkspaceServiceImpl, self.svc)

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/workspaces", tags=["workspaces"])

        def svc() -> WorkspaceServiceImpl:
            assert self.svc is not None
            return self.svc

        @r.get("", response_model=list[Workspace])
        async def list_workspaces(include_archived: bool = False) -> list[Workspace]:
            return await svc().list(include_archived=include_archived)

        @r.post("", response_model=Workspace, status_code=201)
        async def create_workspace(body: WorkspaceCreate) -> Workspace:
            return await svc().create(body)

        @r.get("/{workspace_id}", response_model=Workspace)
        async def get_workspace(workspace_id: str) -> Workspace:
            return await svc().get(workspace_id)

        @r.patch("/{workspace_id}", response_model=Workspace)
        async def update_workspace(workspace_id: str, body: WorkspaceUpdate) -> Workspace:
            return await svc().update(workspace_id, body)

        @r.get("/{workspace_id}/repos", response_model=list[Repo])
        async def list_repos(workspace_id: str) -> list[Repo]:
            return await svc().repos(workspace_id)

        @r.post("/{workspace_id}/repos", response_model=Repo, status_code=201)
        async def add_repo(workspace_id: str, body: RepoCreate) -> Repo:
            return await svc().add_repo(workspace_id, body)

        @r.patch("/repos/{repo_id}", response_model=Repo)
        async def update_repo(repo_id: str, body: RepoUpdate) -> Repo:
            return await svc().update_repo(repo_id, body)

        @r.delete("/repos/{repo_id}", status_code=204)
        async def remove_repo(repo_id: str) -> None:
            await svc().remove_repo(repo_id)

        return r


module = WorkspacesModule()
