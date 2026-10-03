from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest
import respx
from alertfakes import SLACK_APP, SLACK_BOT, TG_API, TG_TOKEN, AlertEnv

from aistudio.alerts.channels.slack import SlackChannel
from aistudio.alerts.channels.telegram import TelegramChannel
from aistudio.alerts.interactions import PRODUCTION_APP_ONLY
from aistudio.alerts.render import UNAUTHORIZED
from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalStatus


@pytest.fixture
def http() -> Any:
    with respx.mock(assert_all_called=False) as mock:
        mock.post(f"{TG_API}/sendMessage").respond(200, json={"ok": True, "result": {"message_id": 10}})
        mock.post(f"{TG_API}/answerCallbackQuery").respond(200, json={"ok": True, "result": True})
        mock.post(f"{TG_API}/editMessageText").respond(200, json={"ok": True, "result": {}})
        mock.post("https://slack.com/api/chat.postMessage").respond(
            200, json={"ok": True, "channel": "C1", "ts": "1700.1"}
        )
        mock.post("https://slack.com/api/chat.update").respond(200, json={"ok": True})
        mock.post("https://slack.com/api/chat.postEphemeral").respond(200, json={"ok": True})
        yield mock


def bodies(http: Any, url: str) -> list[dict[str, Any]]:
    return [json.loads(c.request.content) for c in http.calls if str(c.request.url) == url]


# --------------------------------------------------------------------------- Telegram


async def telegram(env: AlertEnv, **config: Any) -> TelegramChannel:
    chan = await env.channel(
        "telegram", config={"chat_id": "555", "linked_user_id": "42", **config}, bot_token=TG_TOKEN
    )
    inst = env.svc._instances[chan.id]  # pyright: ignore[reportPrivateUsage]
    assert isinstance(inst, TelegramChannel)
    return inst


def callback(data: str, user: int = 42, message_id: int = 10) -> dict[str, Any]:
    return {
        "update_id": 1000 + message_id,
        "callback_query": {
            "id": f"cb{data}",
            "from": {"id": user, "username": "deniz"},
            "message": {"message_id": message_id, "chat": {"id": 555, "type": "private"}},
            "data": data,
        },
    }


def feed(http: Any, *updates: dict[str, Any]) -> Any:
    return http.post(f"{TG_API}/getUpdates").respond(200, json={"ok": True, "result": list(updates)})


async def notify(env: AlertEnv, kind: ApprovalKind = ApprovalKind.plan, *, production: bool = False) -> Approval:
    approval, event = await env.approval(kind, production=production, title="Ödeme planı")
    await env.svc.handle_event(event)
    return approval


async def after_decision(env: AlertEnv) -> None:
    await env.svc.handle_event(await env.last("approval.decided"))
    await env.svc.drain()


async def test_telegram_callback_approves_and_edits_message(env: AlertEnv, http: Any) -> None:
    tg = await telegram(env)
    approval = await notify(env)
    getupdates = feed(http, callback(f"a:ok:{approval.id}"))
    assert await tg.poll_once() == 1
    assert json.loads(getupdates.calls.last.request.content)["allowed_updates"] == ["message", "callback_query"]
    decided = await env.approvals.get(approval.id)
    assert decided.status == ApprovalStatus.approved
    assert (decided.channel, decided.decided_by) == ("telegram", "channel:telegram:42")
    assert bodies(http, f"{TG_API}/answerCallbackQuery")[-1]["text"] == "Onaylandı ✅"
    await after_decision(env)
    edit = bodies(http, f"{TG_API}/editMessageText")[-1]
    assert edit["message_id"] == 10 and edit["chat_id"] == "555"
    assert "✅ Onaylandı · Telegram (42)" in edit["text"]
    assert edit["reply_markup"] == {"inline_keyboard": []}
    # The next poll acknowledges the processed update.
    feed(http)
    await tg.poll_once()
    assert json.loads(http.calls.last.request.content)["offset"] == 1011


async def test_telegram_rejects_unlinked_users(env: AlertEnv, http: Any) -> None:
    tg = await telegram(env)
    approval = await notify(env)
    feed(http, callback(f"a:ok:{approval.id}", user=99))
    await tg.poll_once()
    answer = bodies(http, f"{TG_API}/answerCallbackQuery")[-1]
    assert answer["text"] == UNAUTHORIZED and answer["show_alert"] is True
    assert (await env.approvals.get(approval.id)).status == ApprovalStatus.pending


async def test_telegram_production_refused_when_remote_disabled(env: AlertEnv, http: Any) -> None:
    tg = await telegram(env)
    approval = await notify(env, ApprovalKind.deploy, production=True)
    feed(http, callback(f"a:ok:{approval.id}"))
    await tg.poll_once()
    answer = bodies(http, f"{TG_API}/answerCallbackQuery")[-1]
    assert answer["show_alert"] is True and answer["text"].startswith(
        "Production onayları yalnız uygulamadan verilebilir"
    )
    reply = bodies(http, f"{TG_API}/sendMessage")[-1]
    assert reply["text"] == f"⛔ {PRODUCTION_APP_ONLY}"
    assert reply["reply_parameters"]["message_id"] == 10
    assert (await env.approvals.get(approval.id)).status == ApprovalStatus.pending


async def test_telegram_production_needs_second_tap(env: AlertEnv, http: Any) -> None:
    await env.ctx.store.set("safety.remote_production_approvals", True)
    tg = await telegram(env)
    approval = await notify(env, ApprovalKind.deploy, production=True)
    feed(http, callback(f"a:ok:{approval.id}"))
    await tg.poll_once()
    prompt = bodies(http, f"{TG_API}/sendMessage")[-1]
    assert prompt["text"] == "⚠️ Emin misin? Production'da çalışacak: Ödeme planı"
    assert prompt["reply_markup"]["inline_keyboard"] == [
        [{"text": "✅ Evet, onayla", "callback_data": f"a:ok2:{approval.id}"}],
        [{"text": "↩️ Vazgeç", "callback_data": f"a:x:{approval.id}"}],
    ]
    assert (await env.approvals.get(approval.id)).status == ApprovalStatus.pending
    feed(http, callback(f"a:ok2:{approval.id}", message_id=11))
    await tg.poll_once()
    decided = await env.approvals.get(approval.id)
    assert decided.status == ApprovalStatus.approved and decided.channel == "telegram"
    edited = bodies(http, f"{TG_API}/editMessageText")[-1]
    assert edited["message_id"] == 11 and edited["text"] == "Onaylandı ✅"


async def test_telegram_second_tap_expires_and_cancel(env: AlertEnv, http: Any) -> None:
    await env.ctx.store.set("safety.remote_production_approvals", True)
    tg = await telegram(env)
    approval = await notify(env, ApprovalKind.remote_command, production=True)
    feed(http, callback(f"a:ok:{approval.id}"))
    await tg.poll_once()
    env.clock.advance(121)  # alerts.confirm_timeout_seconds
    feed(http, callback(f"a:ok2:{approval.id}", message_id=11))
    await tg.poll_once()
    assert "süresi doldu" in bodies(http, f"{TG_API}/answerCallbackQuery")[-1]["text"]
    assert (await env.approvals.get(approval.id)).status == ApprovalStatus.pending
    # A forged confirmation without the first tap is refused the same way.
    feed(http, callback(f"a:ok2:{approval.id}", message_id=12))
    await tg.poll_once()
    assert (await env.approvals.get(approval.id)).status == ApprovalStatus.pending
    feed(http, callback(f"a:x:{approval.id}", message_id=13))
    await tg.poll_once()
    assert bodies(http, f"{TG_API}/editMessageText")[-1]["text"] == "Vazgeçildi. Onay hâlâ bekliyor."
    # Rejecting a production approval needs no confirmation (when remote approvals are on).
    feed(http, callback(f"a:no:{approval.id}", message_id=10))
    await tg.poll_once()
    assert (await env.approvals.get(approval.id)).status == ApprovalStatus.rejected


async def test_decision_in_the_app_updates_telegram(env: AlertEnv, http: Any) -> None:
    await telegram(env)
    approval = await notify(env)
    await env.approvals.decide(approval.id, approve=False, channel="app")
    await after_decision(env)
    edit = bodies(http, f"{TG_API}/editMessageText")[-1]
    assert "❌ Reddedildi · uygulamadan" in edit["text"] and edit["reply_markup"] == {"inline_keyboard": []}


async def test_telegram_already_decided_and_questions(env: AlertEnv, http: Any) -> None:
    tg = await telegram(env)
    approval = await notify(env)
    await env.approvals.decide(approval.id, approve=True)
    feed(http, callback(f"a:no:{approval.id}"))
    await tg.poll_once()
    assert bodies(http, f"{TG_API}/answerCallbackQuery")[-1]["text"] == "Bu onay zaten sonuçlandı: ✅ Onaylandı"
    question = await notify(env, ApprovalKind.question)
    feed(http, callback(f"a:ok:{question.id}"))
    await tg.poll_once()
    assert bodies(http, f"{TG_API}/answerCallbackQuery")[-1]["text"] == "Ajan sorularını uygulamadan yanıtla."
    assert (await env.approvals.get(question.id)).status == ApprovalStatus.pending
    # Questions never get approve/reject buttons in the first place.
    sent = [b for b in bodies(http, f"{TG_API}/sendMessage") if "soru" in b["text"]]
    assert "reply_markup" not in sent[-1]


async def test_telegram_link_flow(env: AlertEnv, http: Any) -> None:
    chan = await env.channel("telegram", bot_token=TG_TOKEN)
    tg = env.svc._instances[chan.id]  # pyright: ignore[reportPrivateUsage]
    assert isinstance(tg, TelegramChannel)
    code = await env.svc.create_link_code(chan.id)
    assert code.instructions.startswith(f"Telegram'da botuna şu mesajı gönder: /baglan {code.code}")
    message = {
        "update_id": 1,
        "message": {
            "message_id": 1,
            "text": f"/baglan@aistudio_bot {code.code}",
            "chat": {"id": 777, "type": "private"},
            "from": {"id": 777, "username": "deniz"},
        },
    }
    feed(http, message)
    await tg.poll_once()
    cfg = (await env.svc.get_channel(chan.id)).config
    assert (cfg["chat_id"], cfg["linked_user_id"], cfg["linked_username"]) == ("777", "777", "deniz")
    assert bodies(http, f"{TG_API}/sendMessage")[-1]["text"].startswith("Bağlantı tamam ✅")
    assert (await env.last("alert.channel_linked")).payload["channel_id"] == chan.id
    # Codes are single use.
    feed(http, {**message, "update_id": 2})
    await tg.poll_once()
    assert bodies(http, f"{TG_API}/sendMessage")[-1]["text"].startswith("Kod geçersiz")


async def test_telegram_long_poll_loop_decides(live_env: AlertEnv, http: Any) -> None:
    approval, event = await live_env.approval(title="Canlı")
    state = {"served": False}

    def updates(request: httpx.Request) -> httpx.Response:
        if not state["served"]:
            state["served"] = True
            return httpx.Response(200, json={"ok": True, "result": [callback(f"a:ok:{approval.id}")]})
        return httpx.Response(200, json={"ok": True, "result": []})

    http.post(f"{TG_API}/getUpdates").mock(side_effect=updates)
    chan = await live_env.channel("telegram", config={"chat_id": "555", "linked_user_id": "42"}, bot_token=TG_TOKEN)
    assert chan.listening is True
    await live_env.svc.handle_event(event)
    for _ in range(300):
        if (await live_env.approvals.get(approval.id)).status != ApprovalStatus.pending:
            break
        await asyncio.sleep(0.01)
    assert (await live_env.approvals.get(approval.id)).status == ApprovalStatus.approved


async def test_telegram_invalid_token_stops_polling(live_env: AlertEnv, http: Any) -> None:
    http.post(f"{TG_API}/getUpdates").respond(401, json={"ok": False, "error_code": 401, "description": "Unauthorized"})
    chan = await live_env.channel("telegram", config={"chat_id": "555"}, bot_token=TG_TOKEN)
    for _ in range(300):
        current = await live_env.svc.get_channel(chan.id)
        if current.last_error and not current.listening:
            break
        await asyncio.sleep(0.01)
    out = await live_env.svc.get_channel(chan.id)
    assert out.last_error == "Telegram bot belirteci geçersiz." and out.listening is False
    assert (await live_env.last("alert.channel_error")).payload["channel_id"] == chan.id


# --------------------------------------------------------------------------- Slack (Socket Mode)


async def slack(live_env: AlertEnv, users: list[str] | None = None) -> tuple[SlackChannel, Any]:
    chan = await live_env.channel(
        "slack",
        config={"mode": "bot", "channel": "C1", "allowed_user_ids": users if users is not None else ["U1"]},
        bot_token=SLACK_BOT,
        app_token=SLACK_APP,
    )
    inst = live_env.svc._instances[chan.id]  # pyright: ignore[reportPrivateUsage]
    assert isinstance(inst, SlackChannel)
    for _ in range(100):
        if inst.listening:
            break
        await asyncio.sleep(0.01)
    sock = live_env.sockets.sockets[-1]
    assert sock.connected and (sock.app_token, sock.bot_token) == (SLACK_APP, SLACK_BOT)
    return inst, sock


def block_action(action_id: str, approval_id: str, user: str = "U1", **extra: Any) -> dict[str, Any]:
    return {
        "type": "block_actions",
        "user": {"id": user, "username": "deniz"},
        "channel": {"id": "C1"},
        "container": {"type": "message", "channel_id": "C1", "message_ts": "1700.1"},
        "actions": [{"action_id": action_id, "value": approval_id}],
        **extra,
    }


async def test_slack_button_approves_and_updates_message(live_env: AlertEnv, http: Any) -> None:
    inst, sock = await slack(live_env)
    approval = await notify(live_env)
    envelope = await sock.emit("interactive", block_action("aistudio_approve", approval.id))
    assert sock.acks == [envelope]
    decided = await live_env.approvals.get(approval.id)
    assert decided.status == ApprovalStatus.approved and decided.decided_by == "channel:slack:U1"
    await after_decision(live_env)
    update = bodies(http, "https://slack.com/api/chat.update")[-1]
    assert (update["channel"], update["ts"]) == ("C1", "1700.1")
    texts = [b.get("text", {}).get("text", "") for b in update["blocks"]]
    assert any("✅ Onaylandı · Slack (U1)" in t for t in texts)
    assert not any(b["type"] == "actions" and b.get("block_id", "").startswith("aistudio:") for b in update["blocks"])
    assert inst.listening


async def test_slack_unlinked_user_and_production_refusal(live_env: AlertEnv, http: Any) -> None:
    _, sock = await slack(live_env)
    approval = await notify(live_env, ApprovalKind.deploy, production=True)
    await sock.emit("interactive", block_action("aistudio_approve", approval.id, user="U9"))
    assert bodies(http, "https://slack.com/api/chat.postEphemeral")[-1] == {
        "channel": "C1",
        "user": "U9",
        "text": UNAUTHORIZED,
    }
    await sock.emit("interactive", block_action("aistudio_approve", approval.id))
    refusal = bodies(http, "https://slack.com/api/chat.postEphemeral")[-1]
    assert refusal["user"] == "U1" and refusal["text"] == PRODUCTION_APP_ONLY
    assert (await live_env.approvals.get(approval.id)).status == ApprovalStatus.pending


async def test_slack_production_second_confirmation(live_env: AlertEnv, http: Any) -> None:
    await live_env.ctx.store.set("safety.remote_production_approvals", True)
    _, sock = await slack(live_env)
    approval = await notify(live_env, ApprovalKind.deploy, production=True)
    await sock.emit("interactive", block_action("aistudio_approve", approval.id))
    prompt = bodies(http, "https://slack.com/api/chat.postEphemeral")[-1]
    assert prompt["text"] == "Emin misin? Production'da çalışacak: Ödeme planı"
    ids = [e["action_id"] for b in prompt["blocks"] if b["type"] == "actions" for e in b["elements"]]
    assert ids == ["aistudio_confirm", "aistudio_cancel"]
    assert (await live_env.approvals.get(approval.id)).status == ApprovalStatus.pending
    response_url = "https://hooks.example.test/actions/T1/1/x"
    responder = http.post(response_url).respond(200)
    await sock.emit(
        "interactive",
        block_action(
            "aistudio_confirm",
            approval.id,
            response_url=response_url,
            container={"type": "ephemeral", "channel_id": "C1"},
        ),
    )
    assert (await live_env.approvals.get(approval.id)).status == ApprovalStatus.approved
    assert json.loads(responder.calls.last.request.content) == {"replace_original": True, "text": "Onaylandı ✅"}


async def test_slack_dm_link_code(live_env: AlertEnv, http: Any) -> None:
    inst, sock = await slack(live_env, users=[])
    code = await live_env.svc.create_link_code(inst.id)
    await sock.emit(
        "events_api",
        {
            "event": {
                "type": "message",
                "channel_type": "im",
                "channel": "D1",
                "user": "U7",
                "text": f"bağlan {code.code}",
            }
        },
    )
    cfg = (await live_env.svc.get_channel(inst.id)).config
    assert cfg["allowed_user_ids"] == ["U7"] and cfg["channel"] == "C1"
    assert bodies(http, "https://slack.com/api/chat.postMessage")[-1]["channel"] == "D1"


async def test_listeners_stop_with_the_service(live_env: AlertEnv) -> None:
    _, sock = await slack(live_env)
    await live_env.svc.stop()
    assert sock.closed is True
