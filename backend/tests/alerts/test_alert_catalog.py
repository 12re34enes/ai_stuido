from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from aistudio.alerts.catalog import build_alert, generic_alert
from aistudio.core.events import Event, Severity

TS = datetime(2026, 10, 3, 9, 0, tzinfo=UTC)


def ev(type_: str, payload: dict[str, Any] | None = None, **kw: Any) -> Event:
    return Event(id=10, ts=TS, type=type_, payload=payload or {}, **kw)


SPEC_TABLE: list[tuple[str, dict[str, Any], Severity, str]] = [
    # Kritik
    (
        "approval.requested",
        {"approval_id": "apr_1", "kind": "deploy", "title": "v2", "production": True},
        Severity.critical,
        "Production deploy onayı bekliyor",
    ),
    (
        "approval.requested",
        {"approval_id": "apr_1", "kind": "remote_command", "title": "rm", "production": True},
        Severity.critical,
        "Production komut onayı bekliyor",
    ),
    (
        "deploy.failed",
        {"environment": "production", "profile_name": "Prod API", "error": "health check"},
        Severity.critical,
        "Production deploy başarısız",
    ),
    ("boundary.violation", {"paths": ["secrets/.env"]}, Severity.critical, "Sınır ihlali"),
    ("agent.stalled", {"minutes": 10, "agent_label": "Claude yazar"}, Severity.critical, "Ajan takıldı"),
    ("agent.session.ended", {"reason": "error", "error": "exit 137"}, Severity.critical, "Ajan çöktü"),
    (
        "limit.exhausted",
        {"provider": "claude", "label": "5 saat", "resets_at": "2026-10-03T14:00:00Z"},
        Severity.critical,
        "Limit doldu",
    ),
    # Yüksek
    (
        "approval.requested",
        {"approval_id": "apr_2", "kind": "plan", "title": "Plan"},
        Severity.high,
        "Plan onayı bekliyor",
    ),
    (
        "approval.requested",
        {"approval_id": "apr_3", "kind": "merge", "title": "m"},
        Severity.high,
        "Birleştirme onayı bekliyor",
    ),
    ("approval.requested", {"approval_id": "apr_4", "kind": "final", "title": "f"}, Severity.high, "Son onay bekliyor"),
    (
        "approval.requested",
        {"approval_id": "apr_5", "kind": "question", "title": "q"},
        Severity.high,
        "Ajan bir soru soruyor",
    ),
    ("gate.loop_exhausted", {"gate": "cross_review", "rounds": 3}, Severity.high, "Kapı tur sınırına ulaştı"),
    (
        "pr.autofix_failed",
        {"number": 7, "title": "T", "kind": "ci", "reason": "max_attempts", "attempts": 3},
        Severity.high,
        "PR takibi CI'ı düzeltemedi",
    ),
    (
        "deploy.succeeded",
        {"environment": "production", "profile_name": "Prod API"},
        Severity.high,
        "Production deploy tamamlandı",
    ),
    # Normal
    ("task.completed", {"title": "Ödeme modülü"}, Severity.normal, "Görev tamamlandı"),
    ("pr.review", {"number": 7, "title": "T", "comments": 2}, Severity.normal, "PR'a yeni review"),
    (
        "limit.warning",
        {"provider": "codex", "label": "Haftalık", "used_percent": 81.4},
        Severity.normal,
        "Limit %80'e ulaştı",
    ),
    ("schedule.fired", {"name": "Gece testleri"}, Severity.normal, "Zamanlanmış görev başladı"),
    ("schedule.finished", {"name": "Gece testleri", "status": "completed"}, Severity.normal, "Zamanlanmış görev bitti"),
    (
        "deploy.succeeded",
        {"environment": "test", "profile_name": "Staging"},
        Severity.normal,
        "Test ortamına deploy tamamlandı",
    ),
    ("deploy.failed", {"environment": "test"}, Severity.normal, "Test ortamına deploy başarısız"),
    # Bilgi
    ("memory.proposed", {"path": "facts.md"}, Severity.info, "Hafıza önerisi"),
    (
        "approval.requested",
        {"approval_id": "apr_6", "kind": "memory", "title": "facts"},
        Severity.info,
        "Hafıza önerisi",
    ),
    ("agent.handoff", {"from": "planlayıcı", "to": "geliştirici"}, Severity.info, "Ajan devretti"),
    ("limit.reset", {"provider": "claude", "label": "5 saat"}, Severity.info, "Limit sıfırlandı"),
]


@pytest.mark.parametrize(("type_", "payload", "severity", "title"), SPEC_TABLE)
def test_spec_severity_table(type_: str, payload: dict[str, Any], severity: Severity, title: str) -> None:
    alert = build_alert(ev(type_, payload))
    assert alert is not None
    assert (alert.severity, alert.title) == (severity, title)


def test_approval_alerts_link_and_actions() -> None:
    plan = build_alert(
        ev("approval.requested", {"approval_id": "apr_2", "kind": "plan", "title": "Plan", "summary": "3 adım"})
    )
    assert plan is not None
    assert plan.link == "aistudio://approval/apr_2" and plan.approval_id == "apr_2"
    assert plan.body == "Plan\n3 adım" and plan.actionable is True
    assert plan.group_key == "approval" and plan.dedup_key == "approval:apr_2"
    question = build_alert(ev("approval.requested", {"approval_id": "apr_5", "kind": "question", "title": "q"}))
    assert question is not None and question.actionable is False
    prod = build_alert(
        ev("approval.requested", {"approval_id": "apr_1", "kind": "deploy", "title": "v2", "production": True})
    )
    assert prod is not None and prod.production is True and prod.group_key is None


def test_links_follow_task_and_run() -> None:
    a = build_alert(ev("task.completed", {"title": "x"}, task_id="task_9"))
    assert a is not None and a.link == "aistudio://task/task_9"
    b = build_alert(ev("gate.loop_exhausted", {"gate": "build_test"}, run_id="run_3"))
    assert b is not None and b.link == "aistudio://run/run_3"
    c = build_alert(
        ev(
            "pr.ci_failed",
            {"number": 7, "fix_task_id": "task_5", "url": "https://github.com/a/b/pull/7"},
            task_id="task_1",
        )
    )
    assert c is not None
    assert c.link == "aistudio://task/task_5" and c.web_url == "https://github.com/a/b/pull/7"
    assert c.severity == Severity.normal  # a fix task is already running
    d = build_alert(ev("pr.ci_failed", {"number": 7, "fix_task_id": None}))
    assert d is not None and d.severity == Severity.high  # nobody is fixing it


def test_bodies_are_turkish_and_informative() -> None:
    stalled = build_alert(ev("agent.stalled", {"minutes": 10, "agent_label": "Claude yazar"}, session_id="s1"))
    assert stalled is not None and stalled.body == "Claude yazar 10 dakikadır çıktı üretmiyor."
    assert stalled.dedup_key == "agent.stalled:s1"
    limit = build_alert(ev("limit.exhausted", {"provider": "claude", "label": "5 saat", "queued_tasks": 2}))
    assert limit is not None and "Claude 5 saat limiti doldu." in limit.body and "2 iş kuyruğa alındı." in limit.body
    gate = build_alert(ev("gate.loop_exhausted", {"gate": "cross_review", "rounds": 3}))
    assert gate is not None and gate.body.startswith("Çapraz inceleme 3 turda geçilemedi.")


def test_unmapped_and_ignored_events() -> None:
    assert build_alert(ev("agent.message", {"text": "merhaba"})) is None
    assert build_alert(ev("agent.session.ended", {"reason": "completed"})) is None
    g = generic_alert(ev("remote.command", {"title": "systemctl restart api"}, severity=Severity.high))
    assert g.title == "Olay: remote.command" and g.severity == Severity.high and g.body == "systemctl restart api"
