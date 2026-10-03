"""Approvals decided from Telegram / Slack buttons (spec §15 "Çift yönlü").

* Decisions go through ``ApprovalService.decide(..., channel=<kind>, decided_by="channel:<kind>:<user>")``.
* Production approvals: refused with a Turkish message unless ``safety.remote_production_approvals``
  is on; when it is on, approving needs a second tap ("Emin misin? Production'da çalışacak: …")
  within ``alerts.confirm_timeout_seconds``. The service re-checks the setting on decide.
* Agent questions need an answer, so they are never decided from a channel.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta

from aistudio.alerts.channels.base import Action, InteractionResult
from aistudio.alerts.render import STATUS_TEXT
from aistudio.contracts.approvals import ApprovalKind, ApprovalService, ApprovalStatus
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, NotFound, PermissionDenied

PRODUCTION_APP_ONLY = (
    "Production onayları yalnız uygulamadan verilebilir. Kanaldan onay Ayarlar → Güvenlik bölümünden açılabilir."
)
QUESTION_APP_ONLY = "Ajan sorularını uygulamadan yanıtla."


class ApprovalInteractor:
    def __init__(
        self,
        ctx: AppContext,
        *,
        clock: Callable[[], datetime],
        confirm_ttl: Callable[[], Awaitable[float]],
    ) -> None:
        self._ctx = ctx
        self._clock = clock
        self._confirm_ttl = confirm_ttl
        self._pending: dict[tuple[str, str, str], datetime] = {}

    def prune(self) -> None:
        now = self._clock()
        for key in [k for k, exp in self._pending.items() if exp <= now]:
            del self._pending[key]

    async def handle(
        self,
        *,
        channel_id: str,
        channel_kind: str,
        user_id: str,
        approval_id: str,
        action: Action,
    ) -> InteractionResult:
        svc = self._ctx.services.get(ApprovalService)  # type: ignore[type-abstract]
        try:
            approval = await svc.get(approval_id)
        except NotFound:
            return InteractionResult(kind="not_found", message="Onay isteği bulunamadı.", approval_id=approval_id)
        key = (channel_id, user_id, approval_id)
        if approval.status != ApprovalStatus.pending:
            self._pending.pop(key, None)
            status = STATUS_TEXT.get(approval.status, approval.status.value)
            return InteractionResult(
                kind="already", message=f"Bu onay zaten sonuçlandı: {status}", approval_id=approval_id
            )
        if approval.kind == ApprovalKind.question:
            return InteractionResult(kind="refused", message=QUESTION_APP_ONLY, approval_id=approval_id)
        if action == "cancel":
            self._pending.pop(key, None)
            return InteractionResult(
                kind="cancelled", message="Vazgeçildi. Onay hâlâ bekliyor.", approval_id=approval_id
            )

        approve = action in ("approve", "confirm")
        if approval.production:
            if not await self._ctx.store.get("safety.remote_production_approvals"):
                return InteractionResult(kind="refused", message=PRODUCTION_APP_ONLY, approval_id=approval_id)
            if action == "approve":
                self._pending[key] = self._clock() + timedelta(seconds=await self._confirm_ttl())
                title = self._ctx.masker.mask(approval.title)
                return InteractionResult(
                    kind="confirm", message=f"Emin misin? Production'da çalışacak: {title}", approval_id=approval_id
                )
            if action == "confirm":
                expires = self._pending.pop(key, None)
                if expires is None or expires <= self._clock():
                    return InteractionResult(
                        kind="expired",
                        message="Doğrulamanın süresi doldu. Yeniden Onayla'ya bas.",
                        approval_id=approval_id,
                    )
        try:
            decided = await svc.decide(
                approval_id,
                approve=approve,
                decided_by=f"channel:{channel_kind}:{user_id}",
                channel=channel_kind,
            )
        except PermissionDenied as e:
            return InteractionResult(kind="refused", message=e.message, approval_id=approval_id)
        except Conflict:
            current = await svc.get(approval_id)
            status = STATUS_TEXT.get(current.status, current.status.value)
            return InteractionResult(
                kind="already", message=f"Bu onay zaten sonuçlandı: {status}", approval_id=approval_id
            )
        self._pending.pop(key, None)
        message = "Onaylandı ✅" if decided.status == ApprovalStatus.approved else "Reddedildi ❌"
        return InteractionResult(kind="decided", message=message, approval_id=approval_id)
