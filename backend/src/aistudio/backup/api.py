"""HTTP API: ``/api/backup``."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter
from pydantic import BaseModel

from aistudio.backup.service import (
    BackupInfo,
    BackupManifest,
    BackupServiceImpl,
    BackupSettings,
    BackupSettingsUpdate,
    RestoreResult,
)


class RestoreBody(BaseModel):
    safety_backup: bool = True


def build_router(get_svc: Callable[[], BackupServiceImpl]) -> APIRouter:
    r = APIRouter(prefix="/backup", tags=["backup"])

    @r.get("", response_model=list[BackupInfo])
    async def list_backups() -> list[BackupInfo]:
        return await get_svc().list()

    @r.post("", response_model=BackupInfo, status_code=201)
    async def create_backup() -> BackupInfo:
        return await get_svc().create(reason="manual")

    @r.get("/settings", response_model=BackupSettings)
    async def get_settings() -> BackupSettings:
        return await get_svc().settings()

    @r.put("/settings", response_model=BackupSettings)
    async def put_settings(body: BackupSettingsUpdate) -> BackupSettings:
        return await get_svc().update_settings(body)

    @r.get("/{name}", response_model=BackupManifest)
    async def get_backup(name: str) -> BackupManifest:
        return await get_svc().manifest(name)

    @r.post("/{name}/restore", response_model=RestoreResult)
    async def restore_backup(name: str, body: RestoreBody | None = None) -> RestoreResult:
        safety = body.safety_backup if body is not None else True
        return await get_svc().restore(name, safety_backup=safety, actor="user")

    return r
