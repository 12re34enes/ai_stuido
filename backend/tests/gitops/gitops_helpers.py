"""Helpers shared by the gitops tests (importable as ``gitops_helpers``)."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from aistudio.contracts.workspaces import Repo, Workspace
from aistudio.core.context import AppContext
from aistudio.gitops.module import GitopsModule
from aistudio.gitops.service import WorktreeManagerImpl
from aistudio.workspaces.module import WorkspacesModule
from aistudio.workspaces.service import RepoCreate, WorkspaceCreate, WorkspaceServiceImpl

APP_PY = "".join(f"line {i}\n" for i in range(1, 41))


def git(cwd: Path | str, *args: str, input: str | None = None) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True, input=input
    ).stdout.strip()


def git_rc(cwd: Path | str, *args: str) -> int:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True).returncode


def write(base: Path | str, rel: str, content: str | bytes) -> Path:
    p = Path(base) / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        p.write_bytes(content)
    else:
        p.write_text(content)
    return p


def commit(cwd: Path | str, message: str) -> str:
    git(cwd, "add", "-A")
    git(cwd, "commit", "-q", "-m", message)
    return git(cwd, "rev-parse", "HEAD")


def make_repo(path: Path) -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    write(path, "README.md", "# test\n")
    write(path, "src/app.py", APP_PY)
    write(path, ".gitignore", "node_modules/\n*.log\n")
    commit(path, "init")
    return path


@dataclass
class Env:
    ctx: AppContext
    mgr: WorktreeManagerImpl
    workspaces: WorkspaceServiceImpl
    ws: Workspace
    repo: Repo
    path: Path


async def setup_env(ctx: AppContext, repo_path: Path, *, host_id: str | None = None) -> tuple[GitopsModule, Env]:
    wsm = WorkspacesModule()
    await wsm.setup(ctx)
    gm = GitopsModule()
    await gm.setup(ctx)
    await ctx.db.create_all()
    svc = ctx.services.get(WorkspaceServiceImpl)
    ws = await svc.create(WorkspaceCreate(name="Deneme Alanı"))
    req = RepoCreate(path=str(repo_path), host_id=host_id, default_branch="main" if host_id else None)
    repo = await svc.add_repo(ws.id, req)
    assert gm.mgr is not None
    return gm, Env(ctx=ctx, mgr=gm.mgr, workspaces=svc, ws=ws, repo=repo, path=repo_path)
