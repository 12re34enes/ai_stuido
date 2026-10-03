"""Fixtures for backup tests: a context with workspaces + memory repos and a backup service."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from backup_helpers import BackupEnv, make_backup_env

from aistudio.core.context import AppContext


@pytest.fixture
async def backup_env(ctx: AppContext) -> AsyncIterator[BackupEnv]:
    env = await make_backup_env(ctx)
    yield env
    await env.svc.stop()
