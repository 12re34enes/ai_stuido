"""Fixtures for git hosting tests (helpers live in ``gitfakes``)."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from gitfakes import FakeClock, FakeEngine

from aistudio.contracts.engine import FlowEngine
from aistudio.core.context import AppContext
from aistudio.git_hosting import tables as _tables  # noqa: F401
from aistudio.git_hosting.service import GitHostingServiceImpl


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
async def gh_ctx(ctx: AppContext) -> AppContext:
    await ctx.db.create_all()
    return ctx


@pytest.fixture
def engine(ctx: AppContext, clock: FakeClock) -> FakeEngine:
    eng = FakeEngine(clock=clock)
    ctx.services.register(FlowEngine, eng)  # type: ignore[type-abstract]
    return eng


@pytest.fixture
async def hosting(gh_ctx: AppContext, clock: FakeClock) -> AsyncIterator[GitHostingServiceImpl]:
    svc = GitHostingServiceImpl(gh_ctx, clock=clock)
    yield svc
    await svc.aclose()
