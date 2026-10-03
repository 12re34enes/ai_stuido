"""Shared fixtures.

* ``ctx``     - an AppContext on a temp home with an in-memory secret store (no app/modules).
* ``app_ctx`` - (TestClient, AppContext, token) with every module loaded and started.
* ``git_repo``- a temporary git repository with one commit on ``main``.
"""

from __future__ import annotations

import subprocess
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from aistudio.bootstrap import build_app, build_context
from aistudio.core.config import Paths, Settings
from aistudio.core.context import AppContext
from aistudio.security.masking import Masker
from aistudio.security.secrets import MemorySecretStore

TEST_TOKEN = "test-token-123456"


def make_settings(home: Path) -> Settings:
    return Settings(
        paths=Paths(home),
        dev=True,
        dev_token=TEST_TOKEN,
        allowed_origins=("tauri://localhost", "http://localhost:1420"),
    )


@pytest.fixture
async def ctx(tmp_path: Path) -> AsyncIterator[AppContext]:
    masker = Masker()
    c = build_context(make_settings(tmp_path / "home"), secrets=MemorySecretStore(masker), masker=masker)
    await c.db.create_all()
    yield c
    await c.shutdown_tasks()
    await c.db.close()


@pytest.fixture
def app_ctx(tmp_path: Path) -> Iterator[tuple[TestClient, AppContext, str]]:
    masker = Masker()
    c = build_context(make_settings(tmp_path / "home"), secrets=MemorySecretStore(masker), masker=masker)
    app, token = build_app(c, token=TEST_TOKEN)
    with TestClient(app, headers={"Authorization": f"Bearer {token}"}) as client:
        yield client, c, token


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "README.md").write_text("# test\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "init")
    return repo
