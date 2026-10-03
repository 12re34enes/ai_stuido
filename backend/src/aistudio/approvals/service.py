"""Central approval inbox.

Every decision point (plan, merge, remote command, deploy, tool permission, agent question...)
becomes an ``Approval``. Waiters block on an asyncio.Event; decisions can come from the app,
the menu bar, a notification action, or a two-way alert channel (Telegram/Slack).
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any

import sqlalchemy as sa

from aistudio.contracts.approvals import Approval, ApprovalRequest, ApprovalStatus
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, PermissionDenied
from aistudio.core.eventlog import EventLog
from aistudio.core.events import ET, Severity
from aistudio.core.ids import new_id
from aistudio.core.settings_store import SettingsStore
from aistudio.storage.db import Database
from aistudio.storage.tables import approvals as approvals_t

_APP_CHANNELS = frozenset({"app", "menubar", "palette", "notification"})


class ApprovalServiceImpl:
    def __init__(self, db: Database, events: EventLog, store: SettingsStore) -> None:
        self._db = db
        self._events = events
        self._store = store
        self._waiters: dict[str, asyncio.Event] = {}

    async def request(self, req: ApprovalRequest) -> Approval:
        approval = Approval(id=new_id("apr"), created_at=utcnow(), **req.model_dump())
        async with self._db.begin() as conn:
            await conn.execute(
                approvals_t.insert().values(
                    **approval.model_dump(mode="python", exclude={"severity", "kind", "status"}),
                    severity=approval.severity.value,
                    kind=approval.kind.value,
                    status=approval.status.value,
                )
            )
        self._waiters.setdefault(approval.id, asyncio.Event())
        await self._events.append(
            ET.APPROVAL_REQUESTED,
            {
                "approval_id": approval.id,
                "kind": approval.kind.value,
                "title": approval.title,
                "summary": approval.summary,
                "production": approval.production,
            },
            severity=Severity.critical if approval.production else approval.severity,
            actor=approval.requested_by,
            workspace_id=approval.workspace_id,
            task_id=approval.task_id,
            run_id=approval.run_id,
            session_id=approval.session_id,
        )
        return approval

    async def get(self, approval_id: str) -> Approval:
        async with self._db.connect() as conn:
            row = (await conn.execute(sa.select(approvals_t).where(approvals_t.c.id == approval_id))).mappings().first()
        if row is None:
            raise NotFound("Onay isteği bulunamadı.")
        return Approval(**row)

    async def list(
        self,
        *,
        status: ApprovalStatus | None = ApprovalStatus.pending,
        workspace_id: str | None = None,
        limit: int = 200,
    ) -> list[Approval]:
        stmt = sa.select(approvals_t).order_by(approvals_t.c.created_at.desc()).limit(limit)
        if status is not None:
            stmt = stmt.where(approvals_t.c.status == status.value)
        if workspace_id is not None:
            stmt = stmt.where(approvals_t.c.workspace_id == workspace_id)
        async with self._db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [Approval(**r) for r in rows]

    async def wait(self, approval_id: str, timeout: float | None = None) -> Approval:
        # Register the waiter BEFORE reading status so a concurrent decision cannot slip between.
        ev = self._waiters.setdefault(approval_id, asyncio.Event())
        approval = await self.get(approval_id)
        if approval.status != ApprovalStatus.pending:
            self._waiters.pop(approval_id, None)
            return approval
        deadline = approval.expires_at
        effective = timeout
        if deadline is not None:
            remaining = (deadline - utcnow()).total_seconds()
            effective = remaining if effective is None else min(effective, remaining)
        try:
            if effective is not None and effective <= 0:
                raise TimeoutError
            await asyncio.wait_for(ev.wait(), timeout=effective)
        except TimeoutError:
            if deadline is not None and utcnow() >= deadline:
                return await self._finish(
                    approval_id, ApprovalStatus.expired, decided_by="system", channel="system", note="Süresi doldu."
                )
            raise
        return await self.get(approval_id)

    async def request_and_wait(self, req: ApprovalRequest, timeout: float | None = None) -> Approval:
        approval = await self.request(req)
        return await self.wait(approval.id, timeout=timeout)

    async def decide(
        self,
        approval_id: str,
        *,
        approve: bool,
        decided_by: str = "user",
        channel: str = "app",
        note: str | None = None,
        decision_payload: dict[str, Any] | None = None,
    ) -> Approval:
        approval = await self.get(approval_id)
        if approval.production and channel not in _APP_CHANNELS:
            allowed = await self._store.get("safety.remote_production_approvals")
            if not allowed:
                raise PermissionDenied(
                    "Production onayları yalnız uygulamadan verilebilir. "
                    "Ayarlar → Güvenlik bölümünden değiştirilebilir."
                )
        status = ApprovalStatus.approved if approve else ApprovalStatus.rejected
        return await self._finish(
            approval_id, status, decided_by=decided_by, channel=channel, note=note, decision_payload=decision_payload
        )

    async def cancel(self, approval_id: str, reason: str | None = None) -> Approval:
        return await self._finish(
            approval_id, ApprovalStatus.cancelled, decided_by="system", channel="system", note=reason
        )

    async def _finish(
        self,
        approval_id: str,
        status: ApprovalStatus,
        *,
        decided_by: str,
        channel: str,
        note: str | None,
        decision_payload: dict[str, Any] | None = None,
    ) -> Approval:
        now: datetime = utcnow()
        async with self._db.begin() as conn:
            result = await conn.execute(
                approvals_t.update()
                .where(approvals_t.c.id == approval_id, approvals_t.c.status == ApprovalStatus.pending.value)
                .values(
                    status=status.value,
                    decided_by=decided_by,
                    channel=channel,
                    decision_note=note,
                    decision_payload=decision_payload,
                    decided_at=now,
                )
            )
        if result.rowcount == 0:
            current = await self.get(approval_id)  # raises NotFound if missing
            raise Conflict("Bu onay isteği zaten sonuçlandı.", details={"status": current.status.value})
        approval = await self.get(approval_id)
        await self._events.append(
            ET.APPROVAL_DECIDED,
            {
                "approval_id": approval_id,
                "kind": approval.kind.value,
                "status": status.value,
                "decided_by": decided_by,
                "channel": channel,
                "note": note,
            },
            actor=decided_by if decided_by.startswith(("user", "channel:")) else "system",
            workspace_id=approval.workspace_id,
            task_id=approval.task_id,
            run_id=approval.run_id,
            session_id=approval.session_id,
        )
        ev = self._waiters.pop(approval_id, None)
        if ev is not None:
            ev.set()
        return approval
