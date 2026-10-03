from __future__ import annotations

import time
from typing import Any

import respx
from alertfakes import HOOK_SECRET, HOOK_URL
from fastapi.testclient import TestClient

from aistudio.contracts.approvals import ApprovalKind, ApprovalRequest, ApprovalService
from aistudio.core.context import AppContext

AppCtx = tuple[TestClient, AppContext, str]


def test_channels_crud_and_test_send(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    channels = client.get("/api/alerts/channels").json()
    assert [(c["kind"], c["name"], c["enabled"]) for c in channels] == [("macos", "macOS bildirimi", True)]
    kinds = {k["kind"]: k for k in client.get("/api/alerts/kinds").json()}
    assert kinds["telegram"]["two_way"] is True and kinds["webhook"]["secret_fields"] == ["url", "signing_secret"]

    r = client.post(
        "/api/alerts/channels",
        json={"kind": "webhook", "name": "Ops", "secrets": {"url": HOOK_URL, "signing_secret": HOOK_SECRET}},
    )
    assert r.status_code == 201, r.text
    chan = r.json()
    assert chan["secrets_set"] == ["signing_secret", "url"] and HOOK_SECRET not in r.text and HOOK_URL not in r.text

    bad = client.post("/api/alerts/channels", json={"kind": "discord", "secrets": {}})
    assert bad.status_code == 422 and "Webhook adresi" in bad.json()["error"]["message"]

    with respx.mock() as mock:
        mock.post(HOOK_URL).respond(200)
        out = client.post(f"/api/alerts/channels/{chan['id']}/test").json()
    assert out["status"] == "sent"
    log = client.get("/api/alerts/log", params={"channel_id": chan["id"]}).json()
    assert [(e["status"], e["test"]) for e in log] == [("sent", True)]

    patched = client.patch(
        f"/api/alerts/channels/{chan['id']}", json={"enabled": False, "secrets": {"signing_secret": None}}
    ).json()
    assert patched["enabled"] is False and patched["secrets_set"] == ["url"]
    assert client.delete(f"/api/alerts/channels/{chan['id']}").status_code == 204
    assert client.get(f"/api/alerts/channels/{chan['id']}").status_code == 404
    mac = channels[0]["id"]
    refused = client.delete(f"/api/alerts/channels/{mac}")
    assert refused.status_code == 409 and "silinemez" in refused.json()["error"]["message"]


def test_rules_defaults_and_quiet_hours(app_ctx: AppCtx) -> None:
    client, _, _ = app_ctx
    mac = client.get("/api/alerts/channels").json()[0]["id"]
    rule = client.post(
        "/api/alerts/rules",
        json={"name": "PR'lar sessiz", "event_types": ["pr.*"], "min_severity": "normal", "channel_ids": []},
    )
    assert rule.status_code == 201, rule.text
    rid = rule.json()["id"]
    upd = client.patch(f"/api/alerts/rules/{rid}", json={"channel_ids": [mac], "sound": True}).json()
    assert upd["channel_ids"] == [mac] and upd["sound"] is True and upd["event_types"] == ["pr.*"]
    bad = client.post("/api/alerts/rules", json={"name": "x", "channel_ids": ["chan_missing"]})
    assert bad.status_code == 422
    assert [r["id"] for r in client.get("/api/alerts/rules").json()] == [rid]
    assert client.delete(f"/api/alerts/rules/{rid}").status_code == 204

    defaults = client.get("/api/alerts/defaults").json()
    assert [row["label"] for row in defaults["routing"]] == ["Kritik", "Yüksek", "Normal", "Bilgi"]
    assert defaults["routing"][0]["bypasses_quiet_hours"] is True
    assert defaults["settings"]["dedup_seconds"] == 300 and defaults["settings"]["group_window_seconds"] == 60
    changed = client.put("/api/alerts/defaults", json={"dedup_seconds": 120, "rate_limit_per_minute": 10}).json()
    assert changed["settings"]["dedup_seconds"] == 120 and changed["settings"]["rate_limit_per_minute"] == 10
    not_mobile = client.put("/api/alerts/defaults", json={"primary_channel_id": mac})
    assert not_mobile.status_code == 422

    qh = client.put(
        "/api/alerts/quiet-hours",
        json={"enabled": True, "start": "22:30", "end": "07:00", "timezone": "Europe/Istanbul"},
    )
    assert qh.status_code == 200 and client.get("/api/alerts/quiet-hours").json()["start"] == "22:30"
    assert client.put("/api/alerts/quiet-hours", json={"start": "7"}).status_code == 422


def test_approval_request_reaches_the_desktop_app(app_ctx: AppCtx) -> None:
    client, ctx, _ = app_ctx
    svc = ctx.services.get(ApprovalService)  # type: ignore[type-abstract]

    async def make() -> str:
        a = await svc.request(ApprovalRequest(kind=ApprovalKind.merge, title="main'e birleştir"))
        return a.id

    approval_id = client.portal.call(make)  # type: ignore[union-attr]
    notify: list[dict[str, Any]] = []
    for _ in range(200):
        notify = client.get("/api/events", params={"types": "alert.notify"}).json()["events"]
        if notify:
            break
        time.sleep(0.01)
    assert notify, "alert.notify was not emitted"
    payload = notify[0]["payload"]
    assert payload["title"] == "Birleştirme onayı bekliyor" and payload["approval_id"] == approval_id
    assert [a["id"] for a in payload["actions"]] == ["approve", "reject", "open"]
    # The app decides through the regular approvals API (channel "notification").
    r = client.post(f"/api/approvals/{approval_id}/decision", json={"approve": True, "channel": "notification"})
    assert r.status_code == 200
    resolved: list[dict[str, Any]] = []
    for _ in range(200):
        resolved = client.get("/api/events", params={"types": "alert.resolved"}).json()["events"]
        if resolved:
            break
        time.sleep(0.01)
    assert resolved and resolved[0]["payload"]["approvals"] == {approval_id: "approved"}
