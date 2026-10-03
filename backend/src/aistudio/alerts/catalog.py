"""Event -> alert mapping (spec §15 "Olaylar ve önem dereceleri").

| Önem   | Olaylar                                                                                   |
|--------|-------------------------------------------------------------------------------------------|
| Kritik | production approval waiting, production deploy failed, boundary violation, agent stalled  |
|        | or crashed, limit exhausted (work queued)                                                 |
| Yüksek | approvals waiting (plan / merge / final / question / ...), gate loop exhausted, PR takibi |
|        | could not fix CI, production deploy succeeded                                             |
| Normal | task completed, new PR review, limit 80%, schedule started/finished, test deploy          |
| Bilgi  | memory proposal, handoff, limit reset (in-app only by default)                            |

Every alert carries a deep link into the app (``aistudio://approval|task|run/<id>``).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime
from typing import Any

from aistudio.alerts.models import Alert
from aistudio.core.events import ET, Event, Severity
from aistudio.core.ids import new_id

APPROVAL_TITLES: dict[str, str] = {
    "plan": "Plan onayı bekliyor",
    "merge": "Birleştirme onayı bekliyor",
    "final": "Son onay bekliyor",
    "question": "Ajan bir soru soruyor",
    "remote_command": "Uzak komut onayı bekliyor",
    "db_write": "Veritabanı yazma onayı bekliyor",
    "deploy": "Deploy onayı bekliyor",
    "tool_permission": "Araç izni bekleniyor",
    "budget": "Bütçe onayı bekliyor",
    "memory": "Hafıza önerisi",
    "custom": "Onay bekliyor",
}
_PRODUCTION_TITLES = {
    "deploy": "Production deploy onayı bekliyor",
    "remote_command": "Production komut onayı bekliyor",
    "db_write": "Production komut onayı bekliyor",
}
# Kinds that need an answer or are informational: no Onayla/Reddet buttons in channels.
NON_ACTIONABLE_KINDS = frozenset({"question", "memory"})

ENV_LABELS = {"production": "Production", "test": "Test", "local": "Yerel"}
PROVIDER_LABELS = {"claude": "Claude", "codex": "Codex"}
GATE_LABELS = {
    "plan_approval": "Plan onayı",
    "boundary_check": "Sınır denetimi",
    "build_test": "Build/test kanıtı",
    "cross_review": "Çapraz inceleme",
    "user_final": "Son onay",
    "deploy_approval": "Deploy onayı",
    "custom_command": "Özel komut",
}
GROUP_LINKS = {
    "approval": "aistudio://approvals",
    "task.completed": "aistudio://tasks",
    "task.failed": "aistudio://tasks",
}


def deep_link(kind: str, ident: str | None) -> str | None:
    return f"aistudio://{kind}/{ident}" if ident else None


def _s(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _first(p: dict[str, Any], *keys: str) -> str:
    for k in keys:
        v = p.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, int | float) and not isinstance(v, bool):
            return str(v)
    return ""


def _when(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return ""
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    return dt.astimezone().strftime("%d.%m %H:%M")


def _pct(value: Any) -> str:
    try:
        return f"%{float(value):.0f}"
    except (TypeError, ValueError):
        return ""


def _link_for(ev: Event, p: dict[str, Any]) -> str | None:
    return (
        deep_link("approval", _first(p, "approval_id"))
        or deep_link("task", _first(p, "fix_task_id") or ev.task_id or _first(p, "task_id"))
        or deep_link("run", ev.run_id or _first(p, "run_id"))
    )


def _base(ev: Event, severity: Severity, title: str, body: str, **extra: Any) -> Alert:
    p = ev.payload
    fields: dict[str, Any] = {
        "id": new_id("alert"),
        "event_id": ev.id or None,
        "event_type": ev.type,
        "severity": severity,
        "title": title,
        "body": body,
        "link": _link_for(ev, p),
        "workspace_id": ev.workspace_id,
        "task_id": ev.task_id,
        "run_id": ev.run_id,
        "dedup_key": f"{ev.type}:{ev.id}",
        "created_at": ev.ts,
    }
    fields.update(extra)
    return Alert(**fields)


# --------------------------------------------------------------------------- builders


def _approval_requested(ev: Event) -> Alert:
    p = ev.payload
    kind = _s(p.get("kind")) or "custom"
    approval_id = _s(p.get("approval_id"))
    production = bool(p.get("production"))
    summary = _s(p.get("summary"))
    body = "\n".join(x for x in (_s(p.get("title")), summary) if x)
    common: dict[str, Any] = {
        "approval_id": approval_id or None,
        "approval_kind": kind,
        "production": production,
        "actionable": kind not in NON_ACTIONABLE_KINDS,
        "dedup_key": f"approval:{approval_id or ev.id}",
        "link": deep_link("approval", approval_id) or _link_for(ev, p),
    }
    if production:
        title = _PRODUCTION_TITLES.get(kind, "Production onayı bekliyor")
        return _base(ev, Severity.critical, title, body, **common)
    if kind == "memory":
        return _base(ev, Severity.info, APPROVAL_TITLES["memory"], body, **common)
    title = APPROVAL_TITLES.get(kind, APPROVAL_TITLES["custom"])
    return _base(ev, Severity.high, title, body, group_key="approval", group_label="{n} onay bekliyor", **common)


def _deploy(ev: Event) -> Alert:
    p = ev.payload
    env = _s(p.get("environment")) or ("production" if p.get("production") else "test")
    prod = env == "production"
    target = _first(p, "profile_name", "name", "profile_id")
    ref = _first(p, "ref")
    detail = _first(p, "error", "message", "reason")
    failed = ev.type == ET.DEPLOY_FAILED
    env_label = ENV_LABELS.get(env, env)
    if prod:
        title = "Production deploy başarısız" if failed else "Production deploy tamamlandı"
        severity = Severity.critical if failed else Severity.high
    else:
        title = f"{env_label} ortamına deploy başarısız" if failed else f"{env_label} ortamına deploy tamamlandı"
        severity = Severity.normal
    lines = [x for x in (target, f"Ref: {ref}" if ref else "", detail if failed else "") if x]
    deploy_id = _first(p, "deploy_id", "id")
    return _base(
        ev, severity, title, "\n".join(lines), dedup_key=f"{ev.type}:{deploy_id or target}:{ref}", production=prod
    )


def _boundary(ev: Event) -> Alert:
    p = ev.payload
    paths = p.get("paths") or p.get("violations") or []
    if isinstance(paths, list):
        listed = ", ".join(str(x.get("path", x)) if isinstance(x, dict) else str(x) for x in paths[:5])
    else:
        listed = str(paths)
    detail = _first(p, "message", "detail", "reason")
    body = "\n".join(x for x in (detail, f"Yasak yollar: {listed}" if listed else "") if x)
    body = body or "Ajan, tanımlı sınırların dışına çıkan bir değişiklik yaptı. Değişiklik birleştirilmeyecek."
    return _base(ev, Severity.critical, "Sınır ihlali", body, dedup_key=f"boundary:{ev.run_id or ev.task_id}:{listed}")


def _agent_stalled(ev: Event) -> Alert:
    p = ev.payload
    who = _first(p, "agent_label", "label", "profile_name") or "Ajan"
    minutes = _first(p, "minutes", "idle_minutes")
    body = f"{who} {minutes} dakikadır çıktı üretmiyor." if minutes else f"{who} bir süredir çıktı üretmiyor."
    return _base(ev, Severity.critical, "Ajan takıldı", body, dedup_key=f"agent.stalled:{ev.session_id}")


def _agent_ended(ev: Event) -> Alert | None:
    p = ev.payload
    if p.get("reason") != "error":
        return None
    who = _first(p, "agent_label", "label") or "Ajan"
    detail = _first(p, "error")
    body = f"{who} beklenmedik şekilde sonlandı." + (f"\n{detail}" if detail else "")
    return _base(ev, Severity.critical, "Ajan çöktü", body, dedup_key=f"agent.crashed:{ev.session_id}")


def _limit(ev: Event) -> Alert:
    p = ev.payload
    provider = PROVIDER_LABELS.get(_s(p.get("provider")), _s(p.get("provider")) or "Sağlayıcı")
    window = _first(p, "label", "window")
    resets = _when(p.get("resets_at"))
    key = f"{ev.type}:{_s(p.get('provider'))}:{_s(p.get('window'))}"
    if ev.type == ET.LIMIT_EXHAUSTED:
        queued = _first(p, "queued_tasks", "queued")
        lines = [f"{provider} {window} limiti doldu.".replace("  ", " ")]
        if resets:
            lines.append(f"Sıfırlanma: {resets}")
        lines.append(f"{queued} iş kuyruğa alındı." if queued else "Yeni işler sıfırlanmaya kadar kuyrukta bekleyecek.")
        return _base(ev, Severity.critical, "Limit doldu", "\n".join(lines), dedup_key=key)
    if ev.type == ET.LIMIT_WARNING:
        pct = _pct(p.get("used_percent")) or "%80"
        body = f"{provider} {window}: {pct} kullanıldı.".replace("  ", " ") + (
            f" Sıfırlanma: {resets}" if resets else ""
        )
        return _base(ev, Severity.normal, "Limit %80'e ulaştı", body, dedup_key=key)
    return _base(ev, Severity.info, "Limit sıfırlandı", f"{provider} {window} limiti sıfırlandı.", dedup_key=key)


def _gate_loop(ev: Event) -> Alert:
    p = ev.payload
    gate = GATE_LABELS.get(_s(p.get("gate")), _s(p.get("gate")) or "Kapı")
    rounds = _first(p, "rounds", "max_rounds", "attempts")
    body = f"{gate} {rounds} turda geçilemedi. İş senin kararını bekliyor." if rounds else f"{gate} geçilemedi."
    return _base(
        ev, Severity.high, "Kapı tur sınırına ulaştı", body, dedup_key=f"gate.loop:{ev.run_id}:{_s(p.get('node_id'))}"
    )


def _pr_label(p: dict[str, Any]) -> str:
    number = _first(p, "number")
    title = _first(p, "title")
    return f"#{number} {title}".strip() if number else title


def _pr_key(ev: Event, extra: str = "") -> str:
    p = ev.payload
    return f"{ev.type}:{_s(p.get('repo_id'))}:{_s(p.get('number'))}:{extra}"


def _pr(ev: Event) -> Alert | None:
    p = ev.payload
    label = _pr_label(p)
    web = _first(p, "url") or None
    sha = _s(p.get("head_sha"))
    if ev.type == "pr.autofix_failed":
        kind = _s(p.get("kind")) or "ci"
        attempts = _first(p, "attempts")
        title = {
            "ci": "PR takibi CI'ı düzeltemedi",
            "review": "PR takibi review yorumlarını ele alamadı",
            "conflict": "PR takibi çakışmayı çözemedi",
        }.get(kind, "PR takibi düzeltemedi")
        reason = {
            "max_attempts": f"{attempts} denemede CI yeşile dönmedi." if attempts else "Deneme sınırına ulaşıldı.",
            "no_change": "Düzeltme görevi değişiklik üretmedi.",
            "task_failed": "Düzeltme görevi başarısız oldu.",
        }.get(_s(p.get("reason")), "")
        body = "\n".join(x for x in (label, reason) if x)
        return _base(ev, Severity.high, title, body, web_url=web, dedup_key=_pr_key(ev, f"{kind}:{sha}"))
    if ev.type == ET.PR_CI_FAILED:
        checks = p.get("failing_checks") or []
        names = ", ".join(str(c) for c in checks[:4]) if isinstance(checks, list) else ""
        fixing = bool(p.get("fix_task_id"))
        lines = [label, f"Kırılan: {names}" if names else "", "Düzeltme görevi başlatıldı." if fixing else ""]
        return _base(
            ev,
            Severity.normal if fixing else Severity.high,
            "CI kırıldı",
            "\n".join(x for x in lines if x),
            web_url=web,
            dedup_key=_pr_key(ev, sha),
            group_key="pr.ci_failed",
            group_label="{n} PR'da CI kırıldı",
        )
    if ev.type == ET.PR_CI_PASSED:
        recovered = bool(p.get("recovered"))
        return _base(
            ev,
            Severity.normal if recovered else Severity.info,
            "CI yeniden yeşil" if recovered else "CI yeşil",
            label,
            web_url=web,
            dedup_key=_pr_key(ev, sha),
        )
    if ev.type == ET.PR_REVIEW:
        count = _first(p, "comments")
        decision = _s(p.get("review_decision"))
        lines = [label]
        if count and count != "0":
            lines.append(f"{count} yeni yorum")
        if decision == "changes_requested":
            lines.append("Değişiklik istendi.")
        elif decision == "approved":
            lines.append("PR onaylandı.")
        if p.get("fix_task_id"):
            lines.append("Yorumları ele alan görev başlatıldı.")
        return _base(
            ev,
            Severity.normal,
            "PR'a yeni review",
            "\n".join(lines),
            web_url=web,
            dedup_key=_pr_key(ev, count),
            group_key="pr.review",
            group_label="{n} PR'a yeni review",
        )
    if ev.type == "pr.merged":
        return _base(ev, Severity.normal, "PR birleştirildi", label, web_url=web, dedup_key=_pr_key(ev))
    if ev.type == "pr.conflict":
        fixing = bool(p.get("fix_task_id"))
        body = "\n".join(
            x for x in (label, f"Hedef: {_s(p.get('base'))}", "Çözüm görevi başlatıldı." if fixing else "") if x
        )
        return _base(ev, Severity.normal, "PR'da çakışma var", body, web_url=web, dedup_key=_pr_key(ev, sha))
    if ev.type == "pr.closed":
        return _base(ev, Severity.info, "PR kapatıldı", label, web_url=web, dedup_key=_pr_key(ev))
    if ev.type == ET.PR_OPENED:
        return _base(ev, Severity.info, "PR açıldı", label, web_url=web, dedup_key=_pr_key(ev))
    return None


def _task(ev: Event) -> Alert:
    p = ev.payload
    title = _first(p, "title", "task_title")
    if ev.type == ET.TASK_COMPLETED:
        return _base(
            ev,
            Severity.normal,
            "Görev tamamlandı",
            title,
            dedup_key=f"{ev.type}:{ev.task_id}",
            group_key="task.completed",
            group_label="{n} görev tamamlandı",
        )
    error = _first(p, "error", "reason")
    return _base(
        ev,
        Severity.normal,
        "Görev başarısız",
        "\n".join(x for x in (title, error) if x),
        dedup_key=f"{ev.type}:{ev.task_id}",
        group_key="task.failed",
        group_label="{n} görev başarısız",
    )


def _schedule(ev: Event) -> Alert:
    p = ev.payload
    name = _first(p, "name", "title", "schedule_name")
    started = ev.type == ET.SCHEDULE_FIRED
    title = "Zamanlanmış görev başladı" if started else "Zamanlanmış görev bitti"
    status = _first(p, "status")
    body = "\n".join(x for x in (name, f"Durum: {status}" if status and not started else "") if x)
    return _base(ev, Severity.normal, title, body, dedup_key=f"{ev.type}:{_s(p.get('schedule_id'))}:{ev.task_id}")


def _memory(ev: Event) -> Alert:
    p = ev.payload
    return _base(ev, Severity.info, "Hafıza önerisi", _first(p, "path", "title", "rationale"))


def _handoff(ev: Event) -> Alert:
    p = ev.payload
    src, dst = _first(p, "from", "from_label", "source"), _first(p, "to", "to_label", "target")
    body = f"{src} → {dst}" if src and dst else _first(p, "summary", "reason")
    return _base(ev, Severity.info, "Ajan devretti", body)


BUILDERS: dict[str, Callable[[Event], Alert | None]] = {
    ET.APPROVAL_REQUESTED: _approval_requested,
    ET.DEPLOY_FAILED: _deploy,
    ET.DEPLOY_SUCCEEDED: _deploy,
    ET.BOUNDARY_VIOLATION: _boundary,
    ET.AGENT_STALLED: _agent_stalled,
    ET.AGENT_SESSION_ENDED: _agent_ended,
    ET.LIMIT_EXHAUSTED: _limit,
    ET.LIMIT_WARNING: _limit,
    ET.LIMIT_RESET: _limit,
    ET.GATE_LOOP_EXHAUSTED: _gate_loop,
    "pr.autofix_failed": _pr,
    ET.PR_CI_FAILED: _pr,
    ET.PR_CI_PASSED: _pr,
    ET.PR_REVIEW: _pr,
    ET.PR_OPENED: _pr,
    "pr.merged": _pr,
    "pr.closed": _pr,
    "pr.conflict": _pr,
    ET.TASK_COMPLETED: _task,
    ET.TASK_FAILED: _task,
    ET.SCHEDULE_FIRED: _schedule,
    "schedule.finished": _schedule,
    "schedule.completed": _schedule,
    ET.MEMORY_PROPOSED: _memory,
    ET.AGENT_HANDOFF: _handoff,
}


def build_alert(ev: Event) -> Alert | None:
    builder = BUILDERS.get(ev.type)
    if builder is None:
        return None
    return builder(ev)


def generic_alert(ev: Event) -> Alert:
    """For event types without a catalog entry that a user rule explicitly asked for."""
    p = ev.payload
    body = _first(p, "title", "message", "summary", "error", "detail")
    return _base(ev, ev.severity, f"Olay: {ev.type}", body)
