"""Helpers shared by the studios tests (imported by name; the test dir is on sys.path)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from aistudio.contracts.common import Environment
from aistudio.contracts.deploy import DeployProfile, DeployService
from aistudio.contracts.workspaces import Repo, Workspace, WorkspaceService
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound
from aistudio.studios import tables as _studio_tables  # noqa: F401  (registers tables)
from aistudio.studios.service import StudioServiceImpl
from aistudio.workspaces.service import RepoCreate, WorkspaceCreate, WorkspaceServiceImpl


class FakeDeployService:
    def __init__(self) -> None:
        self.profiles: dict[str, DeployProfile] = {}

    def add(self, profile_id: str, workspace_id: str, env: Environment) -> DeployProfile:
        p = DeployProfile(
            id=profile_id,
            workspace_id=workspace_id,
            name=f"{env.value} profili",
            kind="command",
            environment=env,
            created_at=utcnow(),
        )
        self.profiles[profile_id] = p
        return p

    async def get_profile(self, profile_id: str) -> DeployProfile:
        try:
            return self.profiles[profile_id]
        except KeyError:
            raise NotFound("Deploy profili bulunamadı.") from None

    async def deploy(self, *a: Any, **kw: Any) -> Any:  # pragma: no cover - not used
        raise NotImplementedError

    async def rollback(self, *a: Any, **kw: Any) -> Any:  # pragma: no cover - not used
        raise NotImplementedError


@dataclass
class StudioEnv:
    ctx: AppContext
    svc: StudioServiceImpl
    workspaces: WorkspaceServiceImpl
    ws: Workspace
    repo: Repo
    deploy: FakeDeployService = field(default_factory=FakeDeployService)


async def make_studio_env(ctx: AppContext, repo_path: Path, *, with_deploy: bool = True) -> StudioEnv:
    await ctx.db.create_all()
    workspaces = WorkspaceServiceImpl(ctx.db, ctx.events)
    ctx.services.register(WorkspaceService, workspaces)  # type: ignore[type-abstract]
    deploy = FakeDeployService()
    if with_deploy:
        ctx.services.register(DeployService, deploy)  # type: ignore[type-abstract]
    ws = await workspaces.create(WorkspaceCreate(name="Stüdyo Testi"))
    repo = await workspaces.add_repo(ws.id, RepoCreate(path=str(repo_path), name="app"))
    deploy.add("dp_test", ws.id, Environment.test)
    deploy.add("dp_prod", ws.id, Environment.production)
    return StudioEnv(ctx=ctx, svc=StudioServiceImpl(ctx), workspaces=workspaces, ws=ws, repo=repo, deploy=deploy)


def sample_inputs(studio_id: str, repo_name: str = "app") -> dict[str, Any]:
    """Minimal valid inputs for each built-in studio (required fields only)."""
    return {
        "architecture": {"question": "Bildirimler kuyrukla mı gönderilsin?"},
        "market-analysis": {"topic": "KOBİ'ler için ön muhasebe yazılımları"},
        "design": {"brief": "Ayarlar ekranı", "repo": repo_name, "screenshot_command": "pnpm test:shots"},
        "database": {"change": "Siparişlere para birimi", "repo": repo_name, "test_deploy_profile": "dp_test"},
        "code-review": {"target": "main..feature/odeme", "repo": repo_name},
        "debugging": {"symptom": "Boş sepette 500 hatası", "repo": repo_name},
        "documentation": {"subject": "Kurulum rehberi", "repo": repo_name},
        "proposal": {"request": "Mobil uygulama için ödeme entegrasyonu"},
    }[studio_id]
