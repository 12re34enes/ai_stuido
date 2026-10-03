"""HTTP API: ``/api/studios``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from aistudio.contracts.flows import FlowGraph
from aistudio.contracts.studios import Studio, StudioInput
from aistudio.core.errors import ValidationFailed
from aistudio.studios.service import StudioServiceImpl, StudioVersionInfo
from aistudio.studios.validation import GraphValidation


class SaveBody(BaseModel):
    studio: Studio
    note: str | None = None


class InstantiateBody(BaseModel):
    workspace_id: str
    inputs: dict[str, Any] = Field(default_factory=dict)


class ValidateBody(BaseModel):
    graph: FlowGraph
    inputs: list[StudioInput] | None = None


def build_router(get_svc: Callable[[], StudioServiceImpl]) -> APIRouter:
    r = APIRouter(prefix="/studios", tags=["studios"])

    @r.get("", response_model=list[Studio])
    async def list_studios() -> list[Studio]:
        return await get_svc().list()

    @r.post("", response_model=Studio, status_code=201)
    async def save_studio(body: SaveBody) -> Studio:
        return await get_svc().save(body.studio, note=body.note)

    @r.post("/validate", response_model=GraphValidation)
    async def validate_graph(body: ValidateBody) -> GraphValidation:
        return get_svc().validate_graph(body.graph, body.inputs)

    @r.post("/validate-studio", response_model=GraphValidation)
    async def validate_studio(studio: Studio) -> GraphValidation:
        return get_svc().validate(studio)

    @r.get("/{studio_id}", response_model=Studio)
    async def get_studio(studio_id: str, version: int | None = None) -> Studio:
        return await get_svc().get(studio_id, version)

    @r.put("/{studio_id}", response_model=Studio)
    async def save_version(studio_id: str, body: SaveBody) -> Studio:
        if body.studio.id != studio_id:
            raise ValidationFailed("Stüdyo kimliği adresle uyuşmuyor.")
        return await get_svc().save(body.studio, note=body.note)

    @r.get("/{studio_id}/versions", response_model=list[StudioVersionInfo])
    async def versions(studio_id: str) -> list[StudioVersionInfo]:
        return await get_svc().versions(studio_id)

    @r.post("/{studio_id}/instantiate", response_model=FlowGraph)
    async def instantiate(studio_id: str, body: InstantiateBody) -> FlowGraph:
        return await get_svc().instantiate(studio_id, workspace_id=body.workspace_id, inputs=body.inputs)

    return r
