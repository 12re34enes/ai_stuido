from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
import respx
from alertfakes import (
    DISCORD_HOOK,
    HOOK_SECRET,
    HOOK_URL,
    NTFY_TOKEN,
    NTFY_URL,
    SLACK_BOT,
    SLACK_HOOK,
    SMTP_PASSWORD,
    TEAMS_HOOK,
    TG_API,
    TG_TOKEN,
    AlertEnv,
)

from aistudio.alerts.channels.simple import webhook_signature
from aistudio.alerts.models import Alert, AlertRuleCreate, ChannelOut
from aistudio.alerts.tables import alerts_messages
from aistudio.core.errors import ValidationFailed
from aistudio.core.events import Severity


@pytest.fixture
def http() -> Any:
    with respx.mock(assert_all_called=False) as mock:
        yield mock


async def send_via(env: AlertEnv, chan: ChannelOut, alert: Alert) -> None:
    await env.svc.create_rule(AlertRuleCreate(name=f"→ {chan.kind}", channel_ids=[chan.id]))
    outcomes = await asyncio.gather(*await env.svc.submit(alert))
    assert [o.status for o in outcomes] == ["sent"], outcomes


def approval_alert(env: AlertEnv, **over: Any) -> Alert:
    fields: dict[str, Any] = {
        "event_type": "approval.requested",
        "severity": Severity.high,
        "title": "Plan onayı bekliyor",
        "body": "Ödeme <planı> & testler",
        "link": "aistudio://approval/apr_1",
        "approval_id": "apr_1",
        "approval_kind": "plan",
        "actionable": True,
        "web_url": "https://github.com/acme/widgets/pull/7",
    }
    fields.update(over)
    return env.alert(**fields)


async def test_slack_webhook_is_one_way(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("slack", webhook_url=SLACK_HOOK)
    assert chan.config["mode"] == "webhook" and chan.secrets_set == ["webhook_url"] and chan.two_way is False
    route = http.post(SLACK_HOOK).respond(200, text="ok")
    await send_via(env, chan, approval_alert(env))
    body = json.loads(route.calls.last.request.content)
    blocks = body["blocks"]
    assert blocks[0]["type"] == "header" and blocks[0]["text"]["text"] == "🟠 Plan onayı bekliyor"
    assert blocks[1]["text"]["text"] == "Ödeme &lt;planı&gt; &amp; testler"
    action_ids = [e.get("action_id") for b in blocks if b["type"] == "actions" for e in b["elements"]]
    assert action_ids == ["aistudio_link"]  # no approve/reject without Socket Mode
    assert "`aistudio://approval/apr_1`" in blocks[-2]["elements"][0]["text"]
    assert body["text"].startswith("Plan onayı bekliyor")


async def test_slack_bot_posts_buttons_and_remembers_message(env: AlertEnv, http: Any) -> None:
    chan = await env.channel(
        "slack",
        config={"mode": "bot", "channel": "C123", "allowed_user_ids": ["U1"]},
        bot_token=SLACK_BOT,
        app_token="-".join(["slack", "app", "x"]),
    )
    assert chan.two_way is True
    route = http.post("https://slack.com/api/chat.postMessage").respond(
        200, json={"ok": True, "channel": "C123", "ts": "1700.1"}
    )
    await send_via(env, chan, approval_alert(env))
    req = route.calls.last.request
    assert req.headers["authorization"] == f"Bearer {SLACK_BOT}"
    body = json.loads(req.content)
    assert body["channel"] == "C123"
    buttons = [e for b in body["blocks"] if b["type"] == "actions" for e in b["elements"] if "value" in e]
    assert [(b["action_id"], b["value"], b.get("style")) for b in buttons] == [
        ("aistudio_approve", "apr_1", "primary"),
        ("aistudio_reject", "apr_1", "danger"),
    ]
    async with env.ctx.db.connect() as conn:
        rows = (await conn.execute(alerts_messages.select())).mappings().all()
    assert [(r["approval_id"], r["external_ref"]) for r in rows] == [("apr_1", {"channel": "C123", "ts": "1700.1"})]


async def test_slack_api_errors_are_turkish(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("slack", config={"mode": "bot", "channel": "C9"}, bot_token=SLACK_BOT)
    http.post("https://slack.com/api/chat.postMessage").respond(200, json={"ok": False, "error": "not_in_channel"})
    out = await env.svc.test_channel(chan.id)
    assert out.status == "failed" and out.error == "Bot kanala eklenmemiş. Kanalda /invite @bot yaz."


async def test_telegram_message_and_inline_keyboard(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("telegram", config={"chat_id": "555"}, bot_token=TG_TOKEN)
    route = http.post(f"{TG_API}/sendMessage").respond(200, json={"ok": True, "result": {"message_id": 10}})
    await send_via(env, chan, approval_alert(env))
    body = json.loads(route.calls.last.request.content)
    assert body["chat_id"] == "555" and body["parse_mode"] == "HTML"
    assert body["text"].startswith("🟠 <b>Plan onayı bekliyor</b>\nÖdeme &lt;planı&gt; &amp; testler")
    assert "<code>aistudio://approval/apr_1</code>" in body["text"]
    assert body["reply_markup"]["inline_keyboard"] == [
        [
            {"text": "✅ Onayla", "callback_data": "a:ok:apr_1"},
            {"text": "❌ Reddet", "callback_data": "a:no:apr_1"},
        ],
        [{"text": "🔗 Aç", "url": "https://github.com/acme/widgets/pull/7"}],
    ]


async def test_telegram_requires_linked_chat(env: AlertEnv) -> None:
    chan = await env.channel("telegram", bot_token=TG_TOKEN)
    out = await env.svc.test_channel(chan.id)
    assert out.status == "failed" and out.error is not None and "henüz bağlanmadı" in out.error


async def test_discord_embed(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("discord", webhook_url=DISCORD_HOOK)
    route = http.post(DISCORD_HOOK).respond(204)
    await send_via(env, chan, approval_alert(env, severity=Severity.critical, title="Sınır ihlali"))
    body = json.loads(route.calls.last.request.content)
    embed = body["embeds"][0]
    assert embed["title"] == "🔴 Sınır ihlali" and embed["color"] == 0xE5484D
    assert embed["url"] == "https://github.com/acme/widgets/pull/7"
    assert embed["fields"] == [{"name": "Uygulamada aç", "value": "`aistudio://approval/apr_1`", "inline": False}]
    assert embed["footer"]["text"] == "AI Studio · Kritik"
    assert body["allowed_mentions"] == {"parse": []} and body["username"] == "AI Studio"


async def test_teams_adaptive_card(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("teams", webhook_url=TEAMS_HOOK)
    route = http.post(TEAMS_HOOK).respond(202)
    await send_via(env, chan, approval_alert(env, severity=Severity.critical))
    body = json.loads(route.calls.last.request.content)
    assert body["type"] == "message"
    attachment = body["attachments"][0]
    assert attachment["contentType"] == "application/vnd.microsoft.card.adaptive"
    card = attachment["content"]
    assert card["type"] == "AdaptiveCard" and card["version"] == "1.4"
    assert card["body"][0]["color"] == "Attention" and card["body"][0]["text"] == "🔴 Plan onayı bekliyor"
    facts = {f["title"]: f["value"] for f in card["body"][-1]["facts"]}
    assert facts == {"Önem": "Kritik", "Uygulamada aç": "aistudio://approval/apr_1"}
    assert card["actions"] == [
        {"type": "Action.OpenUrl", "title": "Aç", "url": "https://github.com/acme/widgets/pull/7"}
    ]


async def test_email_over_starttls(env: AlertEnv) -> None:
    chan = await env.channel(
        "email",
        config={
            "host": "smtp.example.test",
            "username": "studio",
            "from_addr": "studio@example.test",
            "to_addrs": "a@example.test, b@example.test",
        },
        password=SMTP_PASSWORD,
    )
    assert chan.config["to_addrs"] == ["a@example.test", "b@example.test"] and chan.config["security"] == "starttls"
    await send_via(env, chan, approval_alert(env))
    msg, kwargs = env.smtp.sent[-1]
    assert msg["Subject"] == "[AI Studio] Yüksek: Plan onayı bekliyor"
    assert msg["To"] == "a@example.test, b@example.test" and msg["From"] == "studio@example.test"
    text = msg.get_body(preferencelist=("plain",))
    html = msg.get_body(preferencelist=("html",))
    assert text is not None and html is not None
    assert "Uygulamada aç: aistudio://approval/apr_1" in text.get_content()
    assert "Ödeme &lt;planı&gt; &amp; testler" in html.get_content()
    assert kwargs["hostname"] == "smtp.example.test" and kwargs["port"] == 587
    assert kwargs["start_tls"] is True and kwargs["use_tls"] is False
    assert kwargs["username"] == "studio" and kwargs["password"] == SMTP_PASSWORD


async def test_ntfy_priority_and_click(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("ntfy", topic_url=NTFY_URL, token=NTFY_TOKEN)
    route = http.post("https://ntfy.example.test/").respond(200, json={"id": "x"})
    await send_via(env, chan, approval_alert(env, severity=Severity.critical))
    req = route.calls.last.request
    assert req.headers["authorization"] == f"Bearer {NTFY_TOKEN}"
    body = json.loads(req.content)
    assert body["topic"] == NTFY_URL.rsplit("/", 1)[1]
    assert body["priority"] == 5 and body["tags"] == ["rotating_light"]
    assert body["title"] == "Plan onayı bekliyor"
    assert body["click"] == "aistudio://approval/apr_1"
    assert [a["url"] for a in body["actions"]] == [
        "aistudio://approval/apr_1",
        "https://github.com/acme/widgets/pull/7",
    ]


@pytest.mark.parametrize(("severity", "priority"), [(Severity.high, 4), (Severity.normal, 3), (Severity.info, 2)])
async def test_ntfy_priority_mapping(env: AlertEnv, http: Any, severity: Severity, priority: int) -> None:
    chan = await env.channel("ntfy", topic_url=NTFY_URL)
    route = http.post("https://ntfy.example.test/").respond(200)
    await send_via(env, chan, env.alert(severity=severity))
    assert json.loads(route.calls.last.request.content)["priority"] == priority
    assert "authorization" not in route.calls.last.request.headers


async def test_webhook_json_and_hmac_signature(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("webhook", url=HOOK_URL, signing_secret=HOOK_SECRET)
    route = http.post(HOOK_URL).respond(200)
    alert = approval_alert(env)
    await send_via(env, chan, alert)
    req = route.calls.last.request
    ts = req.headers["x-aistudio-timestamp"]
    assert ts == str(int(env.clock.now.timestamp()))
    assert req.headers["x-aistudio-signature"] == webhook_signature(HOOK_SECRET, ts, req.content)
    assert req.headers["x-aistudio-event"] == "alert" and req.headers["x-aistudio-delivery"]
    body = json.loads(req.content)
    assert body["id"] == alert.id and body["severity"] == "high" and body["approval_id"] == "apr_1"
    assert body["link"] == "aistudio://approval/apr_1" and "Uygulamada aç" in body["text"]


async def test_test_endpoint_logs_a_test_delivery(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("webhook", url=HOOK_URL)
    route = http.post(HOOK_URL).respond(200)
    out = await env.svc.test_channel(chan.id)
    assert out.status == "sent" and out.attempts == 1
    assert json.loads(route.calls.last.request.content)["title"] == "AI Studio test bildirimi"
    log = await env.svc.delivery_log(channel_id=chan.id)
    assert [(e.status, e.test) for e in log] == [("sent", True)]


@pytest.mark.parametrize(
    ("kind", "config", "secrets", "message"),
    [
        ("slack", {"mode": "bot"}, {"bot_token": "x"}, "kanal kimliği gerekli"),
        ("slack", {}, {}, "webhook adresi"),
        ("telegram", {}, {}, "bot belirteci gerekli"),
        ("discord", {}, {"webhook_url": "http://insecure.example.test"}, "https"),
        ("email", {"host": "h", "from_addr": "f@x.test"}, {}, "alıcı"),
        ("ntfy", {}, {"topic_url": "https://ntfy.example.test"}, "ntfy konu adresi geçersiz"),
        ("webhook", {}, {"url": "ftp://x"}, "Webhook adresi"),
        ("webhook", {}, {"url": "https://x.test", "token": "y"}, "bilinmeyen gizli alan"),
    ],
)
async def test_channel_validation_in_turkish(
    env: AlertEnv, kind: Any, config: dict[str, Any], secrets: dict[str, str], message: str
) -> None:
    with pytest.raises(ValidationFailed, match=message):
        await env.channel(kind, config=config, **secrets)
