"""Fixtures for gitops tests: real temporary git repos, a hermetic git config, and an
``Env`` with the workspaces + gitops modules set up on the shared ``ctx`` fixture."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from gitops_helpers import Env, make_repo, setup_env

from aistudio.core.context import AppContext


@pytest.fixture(autouse=True)
def hermetic_git(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    """Ignore the developer's global/system git config (signing, hooks, default branch...)."""
    home = tmp_path_factory.mktemp("githome")
    cfg = home / ".gitconfig"
    cfg.write_text("[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(cfg))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture
def repo_path(tmp_path: Path) -> Path:
    return make_repo(tmp_path / "repo")


@pytest.fixture
async def env(ctx: AppContext, repo_path: Path) -> AsyncIterator[Env]:
    gm, e = await setup_env(ctx, repo_path)
    try:
        yield e
    finally:
        await gm.stop()
