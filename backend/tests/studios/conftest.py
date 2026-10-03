"""Fixtures for studios tests."""

from __future__ import annotations

from pathlib import Path

import pytest
from studio_helpers import StudioEnv, make_studio_env

from aistudio.core.context import AppContext


@pytest.fixture
async def studio_env(ctx: AppContext, git_repo: Path) -> StudioEnv:
    return await make_studio_env(ctx, git_repo)
