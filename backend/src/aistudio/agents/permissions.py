"""Per-session permission handler: policy engine + approval inbox.

Each ``PermissionRequest`` from an adapter is evaluated by :func:`aistudio.agents.policy.evaluate`.
``allow``/``deny`` are answered immediately; ``ask`` becomes a ``tool_permission`` approval
and the agent waits (state ``waiting_permission``) until the user decides. Every request emits
``agent.permission.request`` and ``agent.permission.decided``.

Events:
    agent.permission.request  {request_id, tool, kind, summary, command, paths, verdict, rule, policy_reason}
    agent.permission.decided  {request_id, allow, reason, decided_by, rule, approval_id}
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from aistudio.agents.live import LiveSession
from aistudio.agents.policy import DEFAULT_SAFE_COMMANDS, PolicyContext, PolicyDecision, evaluate, request_paths
from aistudio.agents.roles import PROVIDER_NAMES, ROLE_LABELS
from aistudio.contracts.agents import AgentState, PermissionDecision, PermissionRequest
from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalRequest, ApprovalService, ApprovalStatus
from aistudio.core.context import AppContext
from aistudio.core.events import ET, Severity
from aistudio.core.text import truncate

log = logging.getLogger(__name__)

SETTING_SAFE_COMMANDS = "agents.safe_commands"
SETTING_AUTO_ALLOW_WEB = "agents.auto_allow_web"
SETTING_PERMISSION_TIMEOUT = "agents.permission_timeout_minutes"  # 0 = wait until decided

_INPUT_VALUE_LIMIT = 4000

StateSetter = Callable[[LiveSession, AgentState], Awaitable[None]]


def _compact(value: Any, depth: int = 0) -> Any:
    """Bound the size of tool input stored in approvals (Write tool content can be huge)."""
    if isinstance(value, str):
        return truncate(value, _INPUT_VALUE_LIMIT)
    if depth > 4:
        return "…"
    if isinstance(value, dict):
        return {str(k): _compact(v, depth + 1) for k, v in list(value.items())[:50]}
    if isinstance(value, list | tuple):
        return [_compact(v, depth + 1) for v in list(value)[:50]]
    return value


async def _setting(ctx: AppContext, key: str, default: Any) -> Any:
    try:
        value = await ctx.store.get(key)
    except Exception:
        log.exception("could not read setting %s", key)
        return default
    return default if value is None else value


class PermissionGate:
    """:data:`aistudio.contracts.agents.PermissionHandler` for one live session."""

    def __init__(self, ctx: AppContext, live: LiveSession, set_state: StateSetter) -> None:
        self._ctx = ctx
        self._live = live
        self._set_state = set_state

    async def policy_context(self) -> PolicyContext:
        safe = await _setting(self._ctx, SETTING_SAFE_COMMANDS, list(DEFAULT_SAFE_COMMANDS))
        if not isinstance(safe, list):
            safe = list(DEFAULT_SAFE_COMMANDS)
        auto_web = bool(await _setting(self._ctx, SETTING_AUTO_ALLOW_WEB, False))
        return dataclasses.replace(
            self._live.policy,
            safe_commands=tuple(str(s) for s in safe if isinstance(s, str)),
            auto_allow_web=auto_web,
        )

    async def __call__(self, req: PermissionRequest) -> PermissionDecision:
        live = self._live
        live.touch()
        try:
            decision = evaluate(req, await self.policy_context())
        except Exception:  # a policy bug must fail closed, but still let the user decide
            log.exception("policy evaluation failed for session %s", live.id)
            decision = PolicyDecision("ask", "Politika değerlendirilemedi; kullanıcı onayı gerekiyor.", "policy_error")
        paths = request_paths(req)
        await self._ctx.events.append(
            ET.AGENT_PERMISSION_REQUEST,
            {
                "request_id": req.request_id,
                "tool": req.tool,
                "kind": req.kind.value,
                "summary": req.summary,
                "command": req.command,
                "paths": paths,
                "reason": req.reason,
                "verdict": decision.verdict,
                "rule": decision.rule,
                "policy_reason": decision.reason,
            },
            actor=live.actor,
            **live.ids(),
        )
        approval_id: str | None = None
        if decision.verdict == "allow":
            result = PermissionDecision(allow=True, reason=decision.reason, decided_by="policy")
        elif decision.verdict == "deny":
            result = PermissionDecision(allow=False, reason=decision.reason, decided_by="policy")
        else:
            result, approval_id = await self._ask(req, decision, paths)
        live.touch()
        await self._ctx.events.append(
            ET.AGENT_PERMISSION_DECIDED,
            {
                "request_id": req.request_id,
                "allow": result.allow,
                "reason": result.reason,
                "decided_by": result.decided_by,
                "rule": decision.rule,
                "approval_id": approval_id,
            },
            severity=Severity.info if result.allow else Severity.normal,
            actor=live.actor,
            **live.ids(),
        )
        return result

    def _approval_request(self, req: PermissionRequest, decision: PolicyDecision, paths: list[str]) -> ApprovalRequest:
        live = self._live
        provider = PROVIDER_NAMES.get(live.provider, live.provider)
        role = ROLE_LABELS.get(live.role, live.role)
        lines = [f"Ajan: {live.label} ({provider}, {role})", f"Araç: {req.tool}"]
        if req.command:
            lines.append(f"Komut: {truncate(req.command, 2000)}")
        if paths:
            lines.append("Dosyalar: " + ", ".join(paths[:20]))
        if req.reason:
            lines.append(f"Ajanın açıklaması: {truncate(req.reason, 1000)}")
        lines.append(f"Politika: {decision.reason}")
        return ApprovalRequest(
            kind=ApprovalKind.tool_permission,
            title=truncate(f"İzin isteği - {live.label}: {req.summary}", 200, marker="…"),
            summary="\n".join(lines),
            payload={
                "session_id": live.id,
                "request_id": req.request_id,
                "provider": live.provider,
                "label": live.label,
                "tool": req.tool,
                "kind": req.kind.value,
                "command": req.command,
                "paths": paths,
                "cwd": live.cwd,
                "input": _compact(req.input),
                "policy_rule": decision.rule,
                "policy_reason": decision.reason,
            },
            severity=Severity.critical if live.production else Severity.high,
            production=live.production,
            workspace_id=live.workspace_id,
            task_id=live.task_id,
            run_id=live.run_id,
            session_id=live.id,
            requested_by=live.actor,
        )

    async def _ask(
        self, req: PermissionRequest, decision: PolicyDecision, paths: list[str]
    ) -> tuple[PermissionDecision, str | None]:
        live = self._live
        approvals = self._ctx.services.maybe(ApprovalService)  # type: ignore[type-abstract]
        if approvals is None:
            return PermissionDecision(allow=False, reason="Onay servisi hazır değil; işlem reddedildi."), None
        minutes = await _setting(self._ctx, SETTING_PERMISSION_TIMEOUT, 0)
        timeout = float(minutes) * 60 if isinstance(minutes, int | float) and minutes > 0 else None
        previous = live.state
        await self._set_state(live, AgentState.waiting_permission)
        approval: Approval | None = None
        try:
            approval = await approvals.request(self._approval_request(req, decision, paths))
            try:
                approval = await approvals.wait(approval.id, timeout=timeout)
            except TimeoutError:
                with contextlib.suppress(Exception):
                    await approvals.cancel(approval.id, "Onay süresi doldu.")
                return PermissionDecision(allow=False, reason="Onay süresi doldu; işlem reddedildi."), approval.id
        except asyncio.CancelledError:
            if approval is not None:
                with contextlib.suppress(Exception):
                    await asyncio.shield(approvals.cancel(approval.id, "Ajan oturumu durduruldu."))
            raise
        finally:
            if live.state == AgentState.waiting_permission and not live.ended:
                with contextlib.suppress(Exception):
                    await self._set_state(live, previous)
        return self._from_approval(approval), approval.id

    @staticmethod
    def _from_approval(approval: Approval) -> PermissionDecision:
        decided_by = approval.decided_by or "user"
        if approval.status == ApprovalStatus.approved:
            updated: dict[str, Any] | None = None
            payload = approval.decision_payload or {}
            candidate = payload.get("updated_input")
            if isinstance(candidate, dict):
                updated = {str(k): v for k, v in candidate.items()}
            return PermissionDecision(
                allow=True,
                reason=approval.decision_note or "Kullanıcı onayladı.",
                decided_by=decided_by,
                updated_input=updated,
            )
        reasons = {
            ApprovalStatus.rejected: "Kullanıcı reddetti.",
            ApprovalStatus.expired: "Onay süresi doldu.",
            ApprovalStatus.cancelled: "Onay isteği iptal edildi.",
        }
        reason = approval.decision_note or reasons.get(approval.status, "İzin verilmedi.")
        if approval.status == ApprovalStatus.rejected and approval.decision_note:
            reason = f"Kullanıcı reddetti: {approval.decision_note}"
        return PermissionDecision(allow=False, reason=reason, decided_by=decided_by)
