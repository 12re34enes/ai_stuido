"""Fixtures for engine tests (helpers live in ``engine_support.py``)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from engine_support import EngineEnv, build_env

from aistudio.core.context import AppContext


@pytest.fixture
async def env(ctx: AppContext, git_repo: Path, tmp_path: Path) -> AsyncIterator[EngineEnv]:
    e = await build_env(ctx, git_repo, tmp_path)
    yield e
    await e.engine.shutdown()
