"""Fixtures for memory tests: real workspace + approval services and a memory service."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from memory_helpers import MemEnv, make_mem_env

from aistudio.core.context import AppContext


@pytest.fixture
async def mem(ctx: AppContext) -> AsyncIterator[MemEnv]:
    env = await make_mem_env(ctx)
    yield env
    await env.svc.stop()
