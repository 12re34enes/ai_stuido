from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
import respx
from alertfakes import DISCORD_HOOK, HOOK_URL, TG_API, TG_TOKEN, AlertEnv

from aistudio.alerts.models import AlertRuleCreate, AlertSettingsUpdate, ChannelUpdate, QuietHours
from aistudio.contracts.approvals import ApprovalKind
from aistudio.core.events import Severity


@pytest.fixture
def http() -> Any:
    with respx.mock(assert_all_called=False) as mock:
        yield mock


async def test_approval_alert_becomes_macos_notification(env: AlertEnv) -> None:
    approval, event = await env.approval(ApprovalKind.plan, title="Ödeme planı")
    outcomes = await env.svc.handle_event(event)
    assert [o.status for o in outcomes] == ["sent"]
    notify = await env.last("alert.notify")
    p = notify.payload
    assert p["title"] == "Plan onayı bekliyor" and p["body"] == "Ödeme planı\nÖzet satırı"
    assert p["severity"] == "high" and p["sound"] is False and p["approval_id"] == approval.id
    assert p["link"] == f"aistudio://approval/{approval.id}"
    assert [a["id"] for a in p["actions"]] == ["approve", "reject", "open"]
    assert [a["label"] for a in p["actions"]] == ["Onayla", "Reddet", "Aç"]
    assert p["thread_id"] == "approvals" and p["expires_at"]
    assert notify.workspace_id == "ws_1" and notify.severity == Severity.high
    sent = await env.last("alert.sent")
    assert sent.payload["channel_kind"] == "macos" and sent.payload["attempts"] == 1


async def test_production_approval_is_critical_with_sound_and_no_quick_approve(env: AlertEnv) -> None:
    _, event = await env.approval(ApprovalKind.deploy, production=True, title="Prod v2.4")
    await env.svc.handle_event(event)
    p = (await env.last("alert.notify")).payload
    assert p["severity"] == "critical" and p["sound"] is True and p["production"] is True
    assert [a["id"] for a in p["actions"]] == ["open", "reject"]


async def test_decision_resolves_macos_notification(env: AlertEnv) -> None:
    approval, event = await env.approval()
    await env.svc.handle_event(event)
    await env.approvals.decide(approval.id, approve=True)
    await env.svc.handle_event(await env.last("approval.decided"))
    await env.svc.drain()
    resolved = await env.last("alert.resolved")
    assert resolved.payload["approvals"] == {approval.id: "approved"} and resolved.payload["all_decided"] is True


async def test_routing_reaches_the_right_channels(env: AlertEnv, http: Any) -> None:
    await env.channel("telegram", config={"chat_id": "555"}, bot_token=TG_TOKEN)
    await env.channel("discord", webhook_url=DISCORD_HOOK)
    tg = http.post(f"{TG_API}/sendMessage").respond(200, json={"ok": True, "result": {"message_id": 1}})
    dc = http.post(DISCORD_HOOK).respond(204)

    normal = await env.svc.handle_event(await env.event("task.completed", {"title": "x"}, task_id="t1"))
    assert [o.channel_kind for o in normal] == ["macos"]
    high = await env.svc.handle_event(await env.event("gate.loop_exhausted", {"gate": "build_test"}, run_id="r1"))
    assert [o.channel_kind for o in high] == ["macos", "telegram"]
    critical = await env.svc.handle_event(await env.event("boundary.violation", {"paths": ["a"]}, run_id="r1"))
    assert sorted(o.channel_kind or "" for o in critical) == ["discord", "macos", "telegram"]
    assert tg.call_count == 2 and dc.call_count == 1
    info = await env.svc.handle_event(await env.event("memory.proposed", {"path": "facts.md"}))
    assert info == []  # Bilgi: in-app only


async def test_quiet_hours_silence_all_but_critical(env: AlertEnv, http: Any) -> None:
    await env.channel("telegram", config={"chat_id": "555"}, bot_token=TG_TOKEN)
    tg = http.post(f"{TG_API}/sendMessage").respond(200, json={"ok": True, "result": {"message_id": 1}})
    # 09:00 UTC = 12:00 Istanbul
    await env.svc.set_quiet_hours(QuietHours(enabled=True, start="11:00", end="13:00", timezone="Europe/Istanbul"))
    high = await env.svc.handle_event(await env.event("gate.loop_exhausted", {"gate": "build_test"}, run_id="r1"))
    assert [(o.channel_kind, o.status) for o in high] == [("macos", "sent")]
    notify = await env.last("alert.notify")
    assert notify.payload["silent"] is True and notify.payload["sound"] is False
    log = await env.svc.delivery_log(status="suppressed")
    assert [(e.channel_kind, e.error) for e in log] == [("telegram", "Sessiz saatler")]
    assert tg.call_count == 0
    critical = await env.svc.handle_event(await env.event("agent.stalled", {"minutes": 9}, session_id="s1"))
    assert sorted(o.channel_kind or "" for o in critical) == ["macos", "telegram"]
    assert (await env.last("alert.notify")).payload["sound"] is True
    assert tg.call_count == 1


async def test_dedup_within_five_minutes(env: AlertEnv) -> None:
    for _ in range(2):
        await env.svc.handle_event(await env.event("agent.stalled", {"minutes": 5}, session_id="s1"))
    assert len(await env.events("alert.notify")) == 1
    assert [e.status for e in await env.svc.delivery_log()] == ["deduplicated", "sent"]
    env.clock.advance(301)
    await env.svc.handle_event(await env.event("agent.stalled", {"minutes": 10}, session_id="s1"))
    assert len(await env.events("alert.notify")) == 2


async def test_burst_is_grouped(env: AlertEnv) -> None:
    approvals = []
    for i in range(4):
        a, event = await env.approval(title=f"Plan {i}")
        approvals.append(a)
        await env.svc.handle_event(event)
    assert len(await env.events("alert.notify")) == 1  # the first one went out at once
    await env.approvals.decide(approvals[3].id, approve=False)  # decided before the flush: dropped
    env.clock.advance(61)
    tasks = await env.svc.flush_groups()
    outcomes = await asyncio.gather(*tasks)
    assert [o.status for o in outcomes] == ["sent"]
    group = (await env.last("alert.notify")).payload
    assert group["title"] == "2 onay bekliyor"
    assert [i["approval_id"] for i in group["items"]] == [approvals[1].id, approvals[2].id]
    assert group["link"] == "aistudio://approvals"
    assert group["actions"] == [{"id": "open", "label": "Aç", "url": "aistudio://approvals"}]
    assert [e.status for e in await env.svc.delivery_log(status="grouped")] == ["grouped"] * 3


async def test_outgoing_text_is_masked(env: AlertEnv, http: Any) -> None:
    secret = "-".join(["leaky", "value", "777", "abc"])
    env.ctx.masker.add_secret(secret)
    await env.channel("webhook", url=HOOK_URL)
    route = http.post(HOOK_URL).respond(200)
    await env.svc.update_settings(AlertSettingsUpdate())
    await env.svc.create_rule(
        AlertRuleCreate(name="hepsi webhook", channel_ids=[(await env.svc.list_channels())[1].id])
    )
    tasks = await env.svc.submit(env.alert(title=f"token {secret}", body=f"çıktı: password={secret}"))
    await asyncio.gather(*tasks)
    body = json.loads(route.calls.last.request.content)
    assert secret not in json.dumps(body, ensure_ascii=False)
    assert body["title"] == "token [gizli]" and "[gizli]" in body["body"]


async def test_retries_transient_failures_and_logs(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("webhook", url=HOOK_URL)
    await env.svc.create_rule(AlertRuleCreate(name="r", channel_ids=[chan.id]))
    route = http.post(HOOK_URL).mock(side_effect=[httpx.Response(502), httpx.Response(503), httpx.Response(200)])
    outcome = (await asyncio.gather(*await env.svc.submit(env.alert())))[0]
    assert (outcome.status, outcome.attempts) == ("sent", 3) and route.call_count == 3

    route.mock(side_effect=None)
    route.respond(400, text="bad payload")
    failed = (await asyncio.gather(*await env.svc.submit(env.alert())))[0]
    assert (failed.status, failed.attempts) == ("failed", 1)
    assert failed.error is not None and "HTTP 400" in failed.error
    ev = await env.last("alert.failed")
    assert ev.payload["channel_id"] == chan.id and ev.severity == Severity.normal
    assert (await env.svc.get_channel(chan.id)).last_error == failed.error
    statuses = [e.status for e in await env.svc.delivery_log(channel_id=chan.id)]
    assert statuses == ["failed", "sent"]


async def test_channel_errors_never_leak_secrets(env: AlertEnv, http: Any) -> None:
    await env.channel("telegram", config={"chat_id": "555"}, bot_token=TG_TOKEN)
    http.post(f"{TG_API}/sendMessage").mock(side_effect=httpx.ConnectError(f"cannot reach {TG_API}"))
    outcomes = await env.svc.handle_event(await env.event("agent.stalled", {"minutes": 9}, session_id="s9"))
    failed = next(o for o in outcomes if o.channel_kind == "telegram")
    assert failed.status == "failed" and failed.attempts == 3
    assert TG_TOKEN not in json.dumps([e.payload for e in await env.events("alert.failed")])


async def test_per_channel_rate_limit(env: AlertEnv) -> None:
    await env.svc.update_settings(AlertSettingsUpdate(rate_limit_per_minute=2, dedup_seconds=0, group_window_seconds=0))
    results = []
    for i in range(3):
        results += await env.svc.handle_event(await env.event("task.completed", {"title": f"t{i}"}, task_id=f"t{i}"))
    assert [o.status for o in results] == ["sent", "sent", "rate_limited"]
    critical = await env.svc.handle_event(await env.event("agent.stalled", {}, session_id="s1"))
    assert [o.status for o in critical] == ["sent"]  # critical alerts bypass the local limit


async def test_rules_and_generic_events(env: AlertEnv, http: Any) -> None:
    hook = await env.channel("webhook", url=HOOK_URL)
    route = http.post(HOOK_URL).respond(200)
    await env.svc.create_rule(AlertRuleCreate(name="uzak komutlar", event_types=["remote.*"], channel_ids=[hook.id]))
    out = await env.svc.handle_event(
        await env.event("remote.command", {"title": "systemctl restart api"}, severity=Severity.high)
    )
    assert [(o.channel_kind, o.status) for o in out] == [("webhook", "sent")]
    assert json.loads(route.calls.last.request.content)["title"] == "Olay: remote.command"
    assert await env.svc.handle_event(await env.event("db.query", {})) == []  # nobody asked for it


async def test_disabled_channel_and_master_switch(env: AlertEnv) -> None:
    await env.svc.update_channel(await env.macos_id(), ChannelUpdate(enabled=False))
    assert await env.svc.handle_event(await env.event("task.completed", {}, task_id="t1")) == []
    await env.svc.update_channel(await env.macos_id(), ChannelUpdate(enabled=True))
    await env.svc.update_settings(AlertSettingsUpdate(enabled=False))
    assert await env.svc.handle_event(await env.event("task.completed", {}, task_id="t2")) == []


async def test_background_pipeline_follows_the_event_log(env: AlertEnv) -> None:
    await env.svc.stop()
    from aistudio.alerts.service import AlertService

    svc = AlertService(env.ctx, clock=env.clock, tick_seconds=0.01, listeners=False)
    await svc.start()
    try:
        await env.approval(title="Canlı plan")
        for _ in range(200):
            if await env.events("alert.notify"):
                break
            await asyncio.sleep(0.01)
        notes = await env.events("alert.notify")
        assert notes and notes[0].payload["body"].startswith("Canlı plan")
    finally:
        await svc.drain()
        await svc.stop()
