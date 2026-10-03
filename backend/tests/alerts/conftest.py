"""Fixtures for alert tests (helpers live in ``alertfakes``)."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from alertfakes import AlertEnv, FakeClock, FakeSmtp, SocketFactory

from aistudio.alerts import tables as _tables  # noqa: F401
from aistudio.alerts.service import AlertService
from aistudio.approvals.service import ApprovalServiceImpl
from aistudio.contracts.approvals import ApprovalService
from aistudio.core.context import AppContext


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


async def _make_env(ctx: AppContext, clock: FakeClock, *, listeners: bool) -> tuple[AlertEnv, AlertService]:
    await ctx.db.create_all()
    approvals = ctx.services.maybe(ApprovalServiceImpl)
    if approvals is None:
        approvals = ApprovalServiceImpl(ctx.db, ctx.events, ctx.store)
        ctx.services.register(ApprovalService, approvals)  # type: ignore[type-abstract]
        ctx.services.register(ApprovalServiceImpl, approvals)
    smtp, sockets = FakeSmtp(), SocketFactory()
    svc = AlertService(
        ctx,
        smtp_send=smtp,
        slack_socket_factory=sockets,
        clock=clock,
        retry_delays=(0.0, 0.0),
        telegram_poll_timeout=0,
        telegram_idle_pause=0.01,
        listeners=listeners,
    )
    await svc.start(pipeline=False)
    return AlertEnv(ctx, svc, approvals, clock, smtp, sockets), svc


@pytest.fixture
async def env(ctx: AppContext, clock: FakeClock) -> AsyncIterator[AlertEnv]:
    """Alert service without background listeners (channels are driven directly)."""
    e, svc = await _make_env(ctx, clock, listeners=False)
    yield e
    await svc.drain()
    await svc.stop()


@pytest.fixture
async def live_env(ctx: AppContext, clock: FakeClock) -> AsyncIterator[AlertEnv]:
    """Alert service whose two-way channels start their listeners (Socket Mode / long polling)."""
    e, svc = await _make_env(ctx, clock, listeners=True)
    yield e
    await svc.drain()
    await svc.stop()
