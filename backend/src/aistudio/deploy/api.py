"""``/api/deploy`` routes."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Response

from aistudio.contracts.common import Environment
from aistudio.contracts.deploy import DeployProfile
from aistudio.deploy.models import DeployProfileCreate, DeployProfileUpdate, DeployRun, RunDeployRequest
from aistudio.deploy.service import DeployServiceImpl


def build_router(get_svc: Callable[[], DeployServiceImpl]) -> APIRouter:
    r = APIRouter(prefix="/deploy", tags=["deploy"])

    @r.get("/profiles", response_model=list[DeployProfile])
    async def list_profiles(workspace_id: str | None = None) -> list[DeployProfile]:
        return await get_svc().list_profiles(workspace_id)

    @r.post("/profiles", response_model=DeployProfile, status_code=201)
    async def create_profile(body: DeployProfileCreate) -> DeployProfile:
        return await get_svc().create_profile(body)

    @r.get("/profiles/{profile_id}", response_model=DeployProfile)
    async def get_profile(profile_id: str) -> DeployProfile:
        return await get_svc().get_profile(profile_id)

    @r.patch("/profiles/{profile_id}", response_model=DeployProfile)
    async def update_profile(profile_id: str, body: DeployProfileUpdate) -> DeployProfile:
        return await get_svc().update_profile(profile_id, body)

    @r.delete("/profiles/{profile_id}", status_code=204)
    async def delete_profile(profile_id: str) -> Response:
        await get_svc().delete_profile(profile_id)
        return Response(status_code=204)

    @r.post("/profiles/{profile_id}/run", response_model=DeployRun, status_code=202)
    async def run_deploy(profile_id: str, body: RunDeployRequest) -> DeployRun:
        """Starts in the background; production waits for the locked approval first."""
        return await get_svc().start(profile_id, ref=body.ref, actor="user", summary=body.summary)

    @r.get("/runs", response_model=list[DeployRun])
    async def list_runs(
        profile_id: str | None = None,
        workspace_id: str | None = None,
        environment: Environment | None = None,
        limit: int = 100,
    ) -> list[DeployRun]:
        runs = await get_svc().list_runs(
            profile_id=profile_id, workspace_id=workspace_id, environment=environment, limit=limit
        )
        return [run.model_copy(update={"log": ""}) for run in runs]

    @r.get("/runs/{deploy_id}", response_model=DeployRun)
    async def get_run(deploy_id: str) -> DeployRun:
        return await get_svc().get_run(deploy_id)

    @r.post("/runs/{deploy_id}/rollback", response_model=DeployRun, status_code=202)
    async def rollback(deploy_id: str) -> DeployRun:
        return await get_svc().start_rollback(deploy_id, actor="user")

    @r.post("/runs/{deploy_id}/cancel", response_model=DeployRun)
    async def cancel(deploy_id: str) -> DeployRun:
        return await get_svc().cancel(deploy_id)

    return r
