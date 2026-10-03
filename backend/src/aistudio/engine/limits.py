"""Limit and budget policy applied before an agent turn starts (spec §17).

``LimitPolicy.on_exhausted``:
* ``switch_provider`` - use the other provider for the same role, unless that would break the
  cross-review rule (``forbidden``), otherwise fall back to waiting;
* ``queue`` - wait until the provider's window resets (the node shows as waiting);
* ``ask`` - approval kind ``budget``; ``decision_payload.action`` is ``switch`` | ``wait`` |
  ``continue`` (budget overrun only) | ``same_provider`` (cross review only: the user explicitly
  allows a same-provider review).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any

from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.contracts.common import Provider, other_provider
from aistudio.contracts.limits import Budget, LimitService
from aistudio.core.clock import utcnow
from aistudio.core.events import Severity
from aistudio.engine.nodes.base import NodeFailure, approval_request

if TYPE_CHECKING:
    from aistudio.engine.nodes.base import NodeContext

PROVIDER_LABEL: dict[str, str] = {"claude": "Claude", "codex": "Codex"}


@dataclass
class _Check:
    ok: bool
    exhausted: bool
    reason: str | None
    resets_at: datetime | None


def _budget_has_limits(budget: Budget) -> bool:
    return any(v is not None for v in budget.model_dump().values())


async def check_provider(limits: LimitService, provider: Provider, budget: Budget, task_id: str) -> _Check:
    avail = await limits.is_available(provider)
    if not avail.ok:
        reason = avail.reason or f"{PROVIDER_LABEL[provider]} limiti dolu."
        return _Check(ok=False, exhausted=True, reason=reason, resets_at=avail.resets_at)
    if _budget_has_limits(budget):
        check = await limits.check_budget(provider, budget, task_id=task_id)
        if not check.ok:
            reason = check.reason or "Görev bütçesi aşıldı."
            return _Check(ok=False, exhausted=False, reason=reason, resets_at=check.resets_at)
    return _Check(ok=True, exhausted=False, reason=None, resets_at=None)


async def ensure_provider(
    nctx: NodeContext,
    provider: Provider,
    *,
    purpose: str,
    forbidden: Provider | None = None,
    allow_switch: bool = True,
    same_provider_review: bool = False,
) -> tuple[Provider, dict[str, Any]]:
    """Return the provider to use (possibly switched) once limits and budget allow it."""
    limits = nctx.rt.limits()
    info: dict[str, Any] = {}
    if limits is None:
        return provider, info
    task = nctx.ex.task
    budget = task.budget or nctx.ex.graph.settings.budget
    if not _budget_has_limits(budget):
        budget = await nctx.rt.default_budget()
    policy = nctx.ex.graph.settings.limit_policy.on_exhausted
    while True:
        check = await check_provider(limits, provider, budget, task.id)
        if check.ok:
            await nctx.clear_waiting()
            return provider, info
        alt = other_provider(provider)
        can_switch = allow_switch and alt != forbidden
        if policy == "switch_provider" and can_switch:
            alt_check = await check_provider(limits, alt, budget, task.id)
            if alt_check.ok:
                await _switched(nctx, provider, alt, check.reason, purpose)
                info["switched_from"] = provider
                return alt, info
        if policy == "ask":
            counter = int(nctx.state.get("budget_asks", 0))
            options = ["wait"]
            if can_switch:
                options.insert(0, "switch")
            if same_provider_review and forbidden is not None:
                options.insert(0, "same_provider")
            if not check.exhausted:
                options.append("continue")
            title = (
                f"{PROVIDER_LABEL[provider]} limiti dolu: {purpose}"
                if check.exhausted
                else f"Görev bütçesi aşılıyor: {purpose}"
            )
            approval = await nctx.approval(
                f"budget:{counter}",
                approval_request(
                    ApprovalKind.budget,
                    title,
                    summary=check.reason,
                    payload={
                        "provider": provider,
                        "purpose": purpose,
                        "exhausted": check.exhausted,
                        "options": options,
                        "resets_at": check.resets_at.isoformat() if check.resets_at else None,
                        "node_id": nctx.node_id,
                    },
                ),
                waiting_reason=title,
            )
            nctx.state["budget_asks"] = counter + 1
            await nctx.save_state()
            action = (approval.decision_payload or {}).get("action")
            if approval.status == ApprovalStatus.approved:
                if action is None:
                    action = options[0] if options[0] != "wait" else ("continue" if not check.exhausted else "wait")
                if action == "switch" and can_switch:
                    await _switched(nctx, provider, alt, check.reason, purpose)
                    info["switched_from"] = provider
                    return alt, info
                if action == "same_provider" and same_provider_review and forbidden is not None:
                    info["same_provider_approved_by"] = approval.decided_by or "user"
                    return forbidden, info
                if action == "continue" and not check.exhausted:
                    info["budget_override_by"] = approval.decided_by or "user"
                    return provider, info
            elif not check.exhausted:
                raise NodeFailure("Görev bütçesi aşıldı; kullanıcı devam etmeyi onaylamadı.")
        await _wait_for_reset(nctx, provider, check, purpose)


async def _switched(nctx: NodeContext, old: Provider, new: Provider, reason: str | None, purpose: str) -> None:
    await nctx.emit(
        "node.provider_switched",
        {"from": old, "to": new, "reason": reason, "purpose": purpose},
        severity=Severity.normal,
    )


async def _wait_for_reset(nctx: NodeContext, provider: Provider, check: _Check, purpose: str) -> None:
    poll = max(0.01, await nctx.rt.float_setting("engine.limit_poll_seconds"))
    when = f" ({check.resets_at.astimezone().strftime('%H:%M')})" if check.resets_at else ""
    await nctx.set_waiting(f"Limit sıfırlanınca devam edecek{when}: {check.reason}", kind="limit")
    if not nctx.state.get("limit_wait_emitted"):
        nctx.state["limit_wait_emitted"] = True
        await nctx.save_state()
        await nctx.emit(
            "run.limit_wait",
            {
                "provider": provider,
                "purpose": purpose,
                "reason": check.reason,
                "resets_at": check.resets_at.isoformat() if check.resets_at else None,
            },
            severity=Severity.critical,
        )
    delay = poll
    if check.resets_at is not None:
        delay = min(delay, max(0.01, (check.resets_at - utcnow()).total_seconds()))
    await nctx.sleep_until(delay)
