"""Text helpers shared by the channels (Turkish labels, outcome lines, plain text)."""

from __future__ import annotations

from datetime import datetime

from aistudio.alerts.models import Alert, AlertItem
from aistudio.contracts.approvals import Approval, ApprovalStatus
from aistudio.core.events import Severity

SEVERITY_LABELS: dict[Severity, str] = {
    Severity.critical: "Kritik",
    Severity.high: "Yüksek",
    Severity.normal: "Normal",
    Severity.info: "Bilgi",
}
SEVERITY_EMOJI: dict[Severity, str] = {
    Severity.critical: "🔴",
    Severity.high: "🟠",
    Severity.normal: "🔵",
    Severity.info: "⚪",
}
STATUS_TEXT: dict[ApprovalStatus, str] = {
    ApprovalStatus.pending: "⏳ Bekliyor",
    ApprovalStatus.approved: "✅ Onaylandı",
    ApprovalStatus.rejected: "❌ Reddedildi",
    ApprovalStatus.expired: "⌛ Süresi doldu",
    ApprovalStatus.cancelled: "🚫 İptal edildi",
}
CHANNEL_LABELS = {
    "app": "uygulamadan",
    "menubar": "menü çubuğundan",
    "notification": "bildirimden",
    "palette": "komut paletinden",
    "system": "sistem",
    "telegram": "Telegram",
    "slack": "Slack",
}
KIND_LABELS = {"telegram": "Telegram", "slack": "Slack"}

UNAUTHORIZED = "Bu işlem için yetkin yok. Yalnız AI Studio'ya bağlı kullanıcı onay verebilir."


def first_line(text: str, limit: int = 140) -> str:
    line = next((x.strip() for x in text.splitlines() if x.strip()), "")
    return line if len(line) <= limit else line[: limit - 1] + "…"


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: max(0, limit - 1)] + "…"


def decided_by_label(approval: Approval) -> str:
    by = approval.decided_by or ""
    if by.startswith("channel:"):
        parts = by.split(":", 2)
        kind = KIND_LABELS.get(parts[1], parts[1]) if len(parts) > 1 else ""
        user = parts[2] if len(parts) > 2 else ""
        return f"{kind} ({user})" if user else kind
    return CHANNEL_LABELS.get(approval.channel or "", approval.channel or "uygulamadan")


def outcome_line(approval: Approval) -> str:
    text = STATUS_TEXT.get(approval.status, approval.status.value)
    if approval.status in (ApprovalStatus.approved, ApprovalStatus.rejected):
        return f"{text} · {decided_by_label(approval)}"
    return text


def is_pending(item: AlertItem, approvals: dict[str, Approval] | None) -> bool:
    if not item.approval_id:
        return False
    if approvals is None or item.approval_id not in approvals:
        return True
    return approvals[item.approval_id].status == ApprovalStatus.pending


def item_line(item: AlertItem) -> str:
    detail = first_line(item.body, 120)
    return f"{item.title} — {detail}" if detail else item.title


def plain_text(alert: Alert, approvals: dict[str, Approval] | None = None, *, with_link: bool = True) -> str:
    """Channel-neutral text: body (or numbered group items), outcomes and the deep link."""
    lines: list[str] = []
    if alert.items:
        for idx, item in enumerate(alert.items, 1):
            line = f"{idx}. {item_line(item)}"
            if approvals and item.approval_id in approvals and not is_pending(item, approvals):
                line += f" ({outcome_line(approvals[item.approval_id])})"
            lines.append(line)
    elif alert.body:
        lines.append(alert.body)
    if not alert.items and alert.approval_id and approvals and alert.approval_id in approvals:
        approval = approvals[alert.approval_id]
        if approval.status != ApprovalStatus.pending:
            lines += ["", outcome_line(approval)]
    if with_link and alert.link:
        lines += ["", f"Uygulamada aç: {alert.link}"]
    return "\n".join(lines).strip()


def iso(dt: datetime) -> str:
    return dt.isoformat(timespec="seconds")


def is_http(url: str | None) -> bool:
    return bool(url) and str(url).startswith(("https://", "http://"))
