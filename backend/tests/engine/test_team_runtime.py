"""Team node runtime with fake sessions that drive the team through their bound Studio tools."""

from __future__ import annotations

import asyncio
from typing import Any

from engine_fakes import FakeSession
from engine_support import EngineEnv, wait_for
from team_support import (
    FINDINGS_OK,
    Gate,
    delegate,
    findings_fail,
    finish,
    member,
    ok,
    on_member,
    session_of,
    sessions_of,
    spec,
    start,
    view,
    wait_view,
    worker,
)

from aistudio.contracts.agents import TurnResult
from aistudio.contracts.flows import FlowMode
from aistudio.core.events import Event

TEAM_EVENT_FIELDS = {"node_id", "node_run_id", "label", "run_id", "task_id", "workspace_id"}


def team_events(events: list[Event], type_: str) -> list[dict[str, Any]]:
    return [e.payload for e in events if e.type == type_]


async def test_lead_delegates_to_workers_and_sub_agents(env: EngineEnv) -> None:
    team = spec(
        member("lead", "Lider", "lead", effort="high"),
        member("dev-a", "Dev A", "worker", "lead", provider="codex", effort="medium"),
        member("dev-b", "Dev B", "worker", "lead"),
        member("dev-c", "Dev C", "worker", "lead", provider="codex"),
        member("sub-1", "Alt 1", "worker", "dev-a"),
        member("sub-2", "Alt 2", "worker", "dev-a", provider="codex"),
    )
    order: list[str] = []

    async def lead(s: FakeSession, _m: str) -> str:
        if s.turn_index == 0:
            await delegate(s, "dev-a", "Arayüz")
            b = await delegate(s, "dev-b", "API")
            await delegate(s, "dev-c", "Entegrasyon", depends_on=[b])
            r = ok(await s.call("team_wait", {}))
            assert {x["status"] for x in r.data["results"]} == {"completed"}, r.content
            assert r.data["pending"] == []
            await finish(s, "Giriş sayfası hazır.")
        return "Lider bitti."

    async def dev_a(s: FakeSession, _m: str) -> str:
        x = await delegate(s, "sub-1", "Form")
        y = await delegate(s, "sub-2", "Stil")
        r = ok(await s.call("team_wait", {"assignment_ids": [x, y]}))
        assert len(r.data["results"]) == 2
        env.worktrees.touch(s.req.worktree_id or "", "ui.py")
        await finish(s, "Arayüz tamam.")
        return "Arayüz bitti."

    async def dev_b(s: FakeSession, _m: str) -> str:
        order.append("b")
        env.worktrees.touch(s.req.worktree_id or "", "api.py")
        return "API uç noktaları eklendi."  # no team_finish: the final text becomes the summary

    async def dev_c(s: FakeSession, message: str) -> str:
        order.append("c")
        assert "API uç noktaları eklendi." in message  # the dependency's result is handed over
        env.worktrees.touch(s.req.worktree_id or "", "main.py")
        await finish(s, "Entegre edildi.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev A", dev_a)
    on_member(env, "Dev B", dev_b)
    on_member(env, "Dev C", dev_c)
    on_member(env, "Alt 1", worker(env, "form.py", finish_summary="Form yapıldı."))
    on_member(env, "Alt 2", worker(env, "style.css"))
    run_id = await start(env, team)
    run = await env.wait_run(run_id, timeout=10)
    assert run.status == "completed", run

    node = [n for n in run.nodes if n.node_id == "team"][-1]
    assert node.output == "Giriş sayfası hazır."
    data = node.data or {}
    assert data["provider"] == "claude" and data["role"] == "writer"
    assert data["team"]["assignments"] == {"total": 5, "completed": 5, "failed": 0, "cancelled": 0}
    assert data["team"]["merge_conflicts"] == 0 and len(data["team"]["tree"]) == 5
    lead_wt = env.worktrees.worktrees[data["worktree_ids"][0]]

    v = await view(env, run_id)
    assert v.status == "completed" and v.active is False and v.attempt == 1
    by_title = {a.title: a for a in v.assignments}
    assert by_title["Form"].from_member == "dev-a" and by_title["Form"].parent_id == by_title["Arayüz"].id
    assert by_title["Arayüz"].parent_id is None and by_title["Arayüz"].result_summary == "Arayüz tamam."
    assert by_title["API"].result_summary == "API uç noktaları eklendi."
    assert by_title["Entegrasyon"].depends_on == [by_title["API"].id]
    assert by_title["Stil"].result_summary == "Yaptım."
    assert all(a.status == "completed" and a.delivered for a in v.assignments)
    assert order == ["b", "c"]
    members = {m.member_id: m for m in v.members}
    assert members["dev-a"].completed == 1 and members["sub-1"].provider == "claude"
    assert members["dev-c"].provider == "codex" and members["dev-a"].effort == "medium"

    # one long-lived session per member
    for name in ("Lider", "Dev A", "Dev B", "Dev C", "Alt 1", "Alt 2"):
        assert len(sessions_of(env, name)) == 1, name
    assert session_of(env, "Dev C").provider == "codex"

    # member worktrees branch from the manager's branch and merge back into it
    wts = {w.label: w for w in env.worktrees.worktrees.values()}
    assert wts["team-dev-a"].base_ref == lead_wt.branch
    assert wts["team-sub-1"].base_ref == wts["team-dev-a"].branch
    merged_into = {m["worktree_id"]: m["target_ref"] for m in env.worktrees.merges}
    assert merged_into[wts["team-sub-1"].id] == wts["team-dev-a"].branch
    assert merged_into[wts["team-dev-a"].id] == lead_wt.branch
    assert merged_into[wts["team-dev-b"].id] == lead_wt.branch
    assert by_title["API"].merge is not None and by_title["API"].merge.status == "clean"

    # tool binding: delegation only for managers; team tools are opt-in
    lead_tools = set(session_of(env, "Lider").tool_names)
    assert {"team_delegate", "team_wait", "team_finish", "ask_user"} <= lead_tools
    assert "team_consult" not in lead_tools
    assert {t for t in session_of(env, "Alt 1").tool_names if t.startswith("team_")} == {"team_finish"}
    assert "team_delegate" in session_of(env, "Dev A").tool_names
    assert "Ekibin (doğrudan bağlı üyelerin)" in session_of(env, "Lider").messages[0]
    assert "`dev-a` — Dev A" in session_of(env, "Lider").messages[0]

    events = await env.events(run_id)
    types = {e.type for e in events}
    for t in (
        "team.started",
        "team.member",
        "team.assignment.created",
        "team.assignment.started",
        "team.assignment.completed",
        "team.merge",
        "team.finished",
        "agent.handoff",
    ):
        assert t in types, t
    created = team_events(events, "team.assignment.created")
    assert len(created) == 5
    first = created[0]
    assert set(first) >= TEAM_EVENT_FIELDS
    assert {"assignment", "assignment_id", "from_member", "to_member", "title", "depends_on", "kind"} <= set(first)
    assert first["from_session_id"] == session_of(env, "Lider").id
    assert first["assignment"]["title"] == "Arayüz"
    handoffs = team_events(events, "agent.handoff")
    assert sum(1 for h in handoffs if h["kind"] == "delegate") == 5
    assert sum(1 for h in handoffs if h["kind"] == "result") == 5
    assert any(h["from"] == "Lider" and h["to"] == "Dev A" for h in handoffs)
    started = team_events(events, "team.started")[0]
    assert [m["id"] for m in started["members"]] == ["lead", "dev-a", "dev-b", "dev-c", "sub-1", "sub-2"]
    finished = team_events(events, "team.finished")[0]
    assert finished["status"] == "completed" and finished["summary"] == "Giriş sayfası hazır."
    statuses = {(p["member_id"], p["status"]) for p in team_events(events, "team.member")}
    assert ("lead", "waiting") in statuses and ("dev-a", "working") in statuses
    checkpoints = await env.engine.list_checkpoints(run_id)
    assert any("birleştirmesi sonrası" in c.label for c in checkpoints)
    assert any(c.label == "Ekip sonrası" for c in checkpoints)


async def test_member_turn_ends_without_finish_and_lead_gets_results_as_new_turn(env: EngineEnv) -> None:
    team = spec(member("lead", "Lider", "lead"), member("dev", "Dev", "worker", "lead"))

    async def lead(s: FakeSession, message: str) -> str:
        if s.turn_index == 0:
            await delegate(s, "dev", "Kurulum")
            return "İş verildi, sonucu bekliyorum."  # ends the turn without waiting
        assert "## Ekipten sonuçlar" in message and "Kurulum yazıldı." in message
        return "Her şey tamam."  # no team_finish either: the final text becomes the summary

    on_member(env, "Lider", lead)
    on_member(env, "Dev", worker(env, "INSTALL.md", reply="Kurulum yazıldı."))
    run_id = await start(env, team)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert [n.output for n in run.nodes if n.node_id == "team"] == ["Her şey tamam."]
    assert len(session_of(env, "Lider").messages) == 2


async def test_advisor_consultation_reports_and_advice(env: EngineEnv) -> None:
    team = spec(
        member("advisor", "Danışman", "advisor", "lead", provider="codex", writes=False),
        member("lead", "Lider", "lead"),
        member("dev-a", "Dev A", "worker", "lead"),
        member("dev-b", "Dev B", "worker", "lead"),
    )

    async def lead(s: FakeSession, _m: str) -> str:
        if s.turn_index == 0:
            answer = ok(await s.call("team_consult", {"question": "Oturum yönetimi için ne önerirsin?"}))
            assert answer.content == "JWT kullan."
            await delegate(s, "dev-a", "Form")
            await delegate(s, "dev-b", "API")
            ok(await s.call("team_wait", {}))

            async def advised() -> bool:
                return any(sid == s.id for sid, _t in env.agents.steers)

            await wait_for(advised)  # the advisor's reply to the Form report reaches the running lead
            await finish(s, "Bitti.")
        return "ok"

    async def dev_b(s: FakeSession, _m: str) -> str:
        r = ok(await s.call("team_report", {"summary": "API'nin yarısı bitti."}))
        assert r.data["delivery"] == "forwarded"

        async def advised() -> bool:
            return any(sid == s.id for sid, _t in env.agents.steers)

        await wait_for(advised)
        return "API tamam."

    def advisor(_s: FakeSession, message: str) -> str:
        if "Danışma sorusu" in message:
            return "JWT kullan."
        if "Üyeden rapor" in message:
            return "API'yi küçük tut."
        if "Form" in message:
            return "Formu erişilebilir yap."
        return "Öneri yok."

    on_member(env, "Lider", lead)
    on_member(env, "Dev A", worker(env, "form.py"))
    on_member(env, "Dev B", dev_b)
    on_member(env, "Danışman", advisor)
    run_id = await start(env, team)
    run = await env.wait_run(run_id)
    assert run.status == "completed", run

    adv = session_of(env, "Danışman")
    assert adv.role == "advisor" and adv.req.spec.boundaries.sandbox == "read_only"
    assert not [t for t in adv.tool_names if t.startswith("team_")]
    assert "team_delegate" not in adv.tool_names
    lead_s = session_of(env, "Lider")
    assert adv.req.spec.cwd == env.worktrees.worktrees[lead_s.req.worktree_id or ""].path
    assert {"team_consult", "team_report"} <= set(lead_s.tool_names)
    assert {"team_consult", "team_report", "team_finish"} <= set(session_of(env, "Dev A").tool_names)
    # consult + member report + one report per finished assignment
    assert len(adv.messages) == 4
    assert sum("İş tamamlandı" in m for m in adv.messages) == 2

    events = await env.events(run_id)
    reports = team_events(events, "team.report")
    assert sorted(r["kind"] for r in reports) == ["assignment", "assignment", "member"]
    assert all(r["advisor"] == "advisor" and set(r) >= TEAM_EVENT_FIELDS for r in reports)
    advice = team_events(events, "team.advice")
    kinds = sorted((a["kind"], a["to_member"]) for a in advice)
    assert kinds == [("consult", "lead"), ("reply", "dev-b"), ("reply", "lead")]  # "Öneri yok." is not forwarded
    consult = next(a for a in advice if a["kind"] == "consult")
    assert consult["question"] == "Oturum yönetimi için ne önerirsin?" and consult["text"] == "JWT kullan."
    steered = {sid: text for sid, text in env.agents.steers}
    assert "Formu erişilebilir yap." in steered[lead_s.id]
    assert "API'yi küçük tut." in steered[session_of(env, "Dev B").id]


async def test_on_demand_reports_are_kept_for_the_next_consultation(env: EngineEnv) -> None:
    team = spec(
        member("advisor", "Danışman", "advisor", "lead", writes=False),
        member("lead", "Lider", "lead"),
        report_mode="on_demand",
    )

    async def lead(s: FakeSession, _m: str) -> str:
        r = ok(await s.call("team_report", {"summary": "Veritabanı şeması hazır."}))
        assert r.data["delivery"] == "on_demand"
        ok(await s.call("team_consult", {"question": "Sırada ne var?"}))
        await finish(s, "Tamam.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Danışman", "Testleri yaz.")
    run_id = await start(env, team)
    assert (await env.wait_run(run_id)).status == "completed"
    adv = session_of(env, "Danışman")
    assert len(adv.messages) == 1  # nothing was sent before the consultation
    assert "Veritabanı şeması hazır." in adv.messages[0] and "Sırada ne var?" in adv.messages[0]


async def test_periodic_reports(env: EngineEnv, monkeypatch: Any) -> None:
    from aistudio.engine.team import runtime as team_runtime

    monkeypatch.setattr(team_runtime, "PERIODIC_UNIT_S", 0.05)
    team = spec(
        member("advisor", "Danışman", "advisor", "lead", writes=False),
        member("lead", "Lider", "lead"),
        member("dev", "Dev", "worker", "lead"),
        report_mode="periodic",
        report_interval_minutes=1,
    )
    gate = Gate()

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev", "Rapor sayfası")
        ok(await s.call("team_wait", {}))
        await finish(s, "Tamam.")
        return "ok"

    async def dev(_s: FakeSession, _m: str) -> str:
        await gate.wait()
        return "Yapıldı."

    on_member(env, "Lider", lead)
    on_member(env, "Dev", dev)
    on_member(env, "Danışman", "Öneri yok.")
    run_id = await start(env, team)

    async def reported() -> bool:
        return any("Dönemsel ilerleme raporu" in m for s in sessions_of(env, "Danışman") for m in s.messages)

    await wait_for(reported)
    await asyncio.sleep(0.2)
    adv = session_of(env, "Danışman")
    assert len(adv.messages) == 1  # no new activity, no new report
    assert "Rapor sayfası" in adv.messages[0]
    gate.open()
    assert (await env.wait_run(run_id)).status == "completed"
    reports = team_events(await env.events(run_id), "team.report")
    assert reports and all(r["kind"] == "periodic" for r in reports)


async def test_dependent_tester_fails_once_then_passes(env: EngineEnv) -> None:
    team = spec(
        member("lead", "Lider", "lead"),
        member("dev", "Dev", "worker", "lead", provider="codex"),
        member(
            "qa",
            "Test",
            "tester",
            "dev",
            writes=False,
            test_mode="dependent",
            tests_member_id="dev",
            test_command="pytest",
        ),
        test_max_rounds=2,
    )
    verdicts = iter([findings_fail("Giriş butonu çalışmıyor"), FINDINGS_OK])
    seen: dict[str, Any] = {}

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev", "Giriş")
        r = ok(await s.call("team_wait", {}))
        seen["wait"] = r
        await finish(s, "Giriş tamam.")
        return "ok"

    async def dev(s: FakeSession, message: str) -> str:
        env.worktrees.touch(s.req.worktree_id or "", "login.py")
        if s.turn_index == 1:
            assert "Testler başarısız (düzeltme turu 1/2)" in message
            assert "Giriş butonu çalışmıyor" in message
        return f"Tur {s.turn_index + 1} bitti."

    on_member(env, "Lider", lead)
    on_member(env, "Dev", dev)
    on_member(env, "Test", lambda _s, _m: next(verdicts))
    run_id = await start(env, team)
    run = await env.wait_run(run_id)
    assert run.status == "completed", run

    tester = session_of(env, "Test")
    dev_s = session_of(env, "Dev")
    assert len(dev_s.messages) == 2 and len(tester.messages) == 2
    assert tester.req.spec.cwd == dev_s.req.spec.cwd  # the tester works in the tested member's worktree
    assert "`pytest`" in tester.messages[0] and "login.py" in tester.messages[0]
    assert not [t for t in tester.tool_names if t.startswith("team_")]

    v = await view(env, run_id)
    work = next(a for a in v.assignments if a.kind == "work")
    assert work.round == 2 and work.status == "completed" and work.result_summary == "Tur 2 bitti."
    assert [(t.status, t.round, t.mode) for t in work.tests] == [("failed", 1, "dependent"), ("passed", 2, "dependent")]
    tests = [a for a in v.assignments if a.kind == "test"]
    assert [(a.from_member, a.to_member, a.status) for a in tests] == [
        ("engine", "qa", "failed"),
        ("engine", "qa", "completed"),
    ]
    assert all(a.target_id == work.id for a in tests)
    results = seen["wait"].data["results"]
    assert [t["status"] for t in results[0]["tests"]] == ["failed", "passed"]
    assert "Testler:" in seen["wait"].content

    events = await env.events(run_id)
    test_events = team_events(events, "team.test")
    assert [(e["status"], e["round"], e["tester"], e["member"]) for e in test_events] == [
        ("failed", 1, "qa", "dev"),
        ("passed", 2, "qa", "dev"),
    ]
    assert test_events[0]["blocking_count"] == 1 and test_events[0]["tester_session_id"] == tester.id
    detail = await env.engine.task_detail(run.task_id)
    assert detail.quality is not None
    comp = {c.key: c for c in detail.quality.components}
    assert comp["team"].raw["test_rounds"] == 1 and comp["team"].raw["test_failures"] == 1
    assert comp["team"].value is not None and comp["team"].value < 1


async def test_dependent_tester_round_limit_reports_failure_and_still_merges(env: EngineEnv) -> None:
    team = spec(
        member("lead", "Lider", "lead"),
        member("dev", "Dev", "worker", "lead"),
        member("qa", "Test", "tester", "dev", writes=False, tests_member_id="dev"),
        test_max_rounds=1,
    )
    seen: dict[str, Any] = {}

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev", "Giriş")
        seen["wait"] = ok(await s.call("team_wait", {}))
        await finish(s, "Bitti.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev", worker(env, "a.py"))
    on_member(env, "Test", findings_fail("Hâlâ bozuk"))
    run_id = await start(env, team)
    assert (await env.wait_run(run_id)).status == "completed"
    result = seen["wait"].data["results"][0]
    assert result["round"] == 2 and [t["status"] for t in result["tests"]] == ["failed", "failed"]
    assert result["merge"]["status"] == "clean"
    assert "başarısız" in seen["wait"].content
    assert len(session_of(env, "Dev").messages) == 2  # one fix round only


async def test_independent_tester_at_end_sends_failures_to_lead(env: EngineEnv) -> None:
    team = spec(
        member("lead", "Lider", "lead"),
        member("dev", "Dev", "worker", "lead"),
        member("qa", "QA", "tester", "lead", provider="codex", writes=False, test_mode="independent"),
        independent_tests_trigger="at_end",
        test_max_rounds=2,
    )
    verdicts = iter([findings_fail("Çıkış linki kırık", "critical"), FINDINGS_OK])

    async def lead(s: FakeSession, message: str) -> str:
        if s.turn_index == 0:
            await delegate(s, "dev", "Sayfa")
            ok(await s.call("team_wait", {}))
            await finish(s, "İlk sürüm.")
        else:
            assert "Testler başarısız (düzeltme turu 1/2)" in message and "Çıkış linki kırık" in message
            await finish(s, "Düzeltilmiş sürüm.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev", worker(env, "page.py"))
    on_member(env, "QA", lambda _s, _m: next(verdicts))
    run_id = await start(env, team)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    assert [n.output for n in run.nodes if n.node_id == "team"] == ["Düzeltilmiş sürüm."]
    qa = session_of(env, "QA")
    lead_s = session_of(env, "Lider")
    assert qa.req.spec.cwd == lead_s.req.spec.cwd and len(qa.messages) == 2
    assert "birleştirilmiş çalışmasını" in qa.messages[0]
    v = await view(env, run_id)
    checks = [a for a in v.assignments if a.kind == "check"]
    assert [(a.status, a.round) for a in checks] == [("failed", 1), ("completed", 2)]
    test_events = team_events(await env.events(run_id), "team.test")
    assert [(e["mode"], e["status"], e["member"]) for e in test_events] == [
        ("independent", "failed", "lead"),
        ("independent", "passed", "lead"),
    ]


async def test_independent_tester_after_each_merge(env: EngineEnv) -> None:
    team = spec(
        member("lead", "Lider", "lead"),
        member("dev-a", "Dev A", "worker", "lead"),
        member("dev-b", "Dev B", "worker", "lead"),
        member("qa", "QA", "tester", "lead", writes=False, test_mode="independent"),
        independent_tests_trigger="after_each_merge",
    )
    seen: dict[str, Any] = {}

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev-a", "A")
        await delegate(s, "dev-b", "B")
        seen["wait"] = ok(await s.call("team_wait", {}))
        await finish(s, "Bitti.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev A", worker(env, "a.py"))
    on_member(env, "Dev B", worker(env, "b.py"))
    on_member(env, "QA", FINDINGS_OK)
    run_id = await start(env, team)
    assert (await env.wait_run(run_id)).status == "completed"
    assert len(session_of(env, "QA").messages) == 2  # once per merge, not again at the end
    for result in seen["wait"].data["results"]:
        assert [(t["mode"], t["status"]) for t in result["tests"]] == [("independent", "passed")]


async def test_merge_conflict_is_reported_to_the_manager(env: EngineEnv) -> None:
    team = spec(member("lead", "Lider", "lead"), member("dev", "Dev", "worker", "lead"))
    env.worktrees.label_conflicts["team-dev"] = ["app.py", "README.md"]
    seen: dict[str, Any] = {}

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev", "Uygulama")
        seen["wait"] = ok(await s.call("team_wait", {}))
        await finish(s, "Çakışmayı kendim çözdüm.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev", worker(env, "app.py"))
    run_id = await start(env, team)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    r = seen["wait"]
    merge = r.data["results"][0]["merge"]
    assert merge["status"] == "conflict" and merge["conflicts"] == ["README.md", "app.py"]
    assert "ÇAKIŞMA" in r.content and "`app.py`" in r.content
    events = await env.events(run_id)
    merges = team_events(events, "team.merge")
    assert merges[0]["status"] == "conflict" and merges[0]["to_member"] == "lead"
    assert merges[0]["conflicts"] == ["README.md", "app.py"]
    node = [n for n in run.nodes if n.node_id == "team"][-1]
    assert (node.data or {})["team"]["merge_conflicts"] == 1


async def test_cancellation_tears_down_the_team(env: EngineEnv) -> None:
    team = spec(member("lead", "Lider", "lead"), member("dev", "Dev", "worker", "lead"))
    gate = Gate()

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev", "Uzun iş")
        await s.call("team_wait", {})
        return "ok"

    async def dev(_s: FakeSession, _m: str) -> str:
        await gate.wait()
        return "bitti"

    on_member(env, "Lider", lead)
    on_member(env, "Dev", dev)
    try:
        run_id = await start(env, team)
        await wait_view(env, run_id, lambda v: any(a.status == "running" for a in v.assignments))
        await env.engine.cancel(run_id)
        run = await env.wait_run(run_id)
        assert run.status == "cancelled"
        v = await view(env, run_id)
        assert v.status == "cancelled" and v.active is False
        assert [a.status for a in v.assignments] == ["cancelled"]
        assert {session_of(env, "Lider").id, session_of(env, "Dev").id} <= set(env.agents.interrupted)
        finished = team_events(await env.events(run_id), "team.finished")
        assert finished and finished[-1]["status"] == "cancelled"
    finally:
        gate.open()


async def test_scope_violations_are_rejected_in_turkish(env: EngineEnv) -> None:
    team = spec(
        member("advisor", "Danışman", "advisor", "lead", writes=False),
        member("lead", "Lider", "lead"),
        member("dev-a", "Dev A", "worker", "lead"),
        member("sub", "Alt", "worker", "dev-a"),
        member("qa", "Test", "tester", "dev-a", writes=False, tests_member_id="dev-a"),
    )
    errors: dict[str, str] = {}

    async def call_err(s: FakeSession, key: str, name: str, args: dict[str, Any]) -> None:
        r = await s.call(name, args)
        assert r.is_error, (key, r.content)
        errors[key] = r.content

    async def lead(s: FakeSession, _m: str) -> str:
        base = {"title": "x", "instructions": "y"}
        await call_err(s, "grandchild", "team_delegate", {"member_id": "sub", **base})
        await call_err(s, "tester", "team_delegate", {"member_id": "qa", **base})
        await call_err(s, "advisor", "team_delegate", {"member_id": "advisor", **base})
        await call_err(s, "unknown", "team_delegate", {"member_id": "kimse", **base})
        await call_err(s, "deps", "team_delegate", {"member_id": "dev-a", "depends_on": ["asg_yok"], **base})
        await call_err(s, "empty", "team_delegate", {"member_id": "dev-a", "title": " ", "instructions": "y"})
        await call_err(s, "wait_foreign", "team_wait", {"assignment_ids": ["asg_yok"]})
        a = await delegate(s, "dev-a", "Ana iş")
        await call_err(s, "finish_open", "team_finish", {"summary": "erken"})
        await call_err(s, "finish_empty", "team_finish", {"summary": " "})
        r = ok(await s.call("team_wait", {"assignment_ids": [a]}))
        assert r.data["results"][0]["status"] == "completed"
        none = ok(await s.call("team_wait", {}))
        assert none.content == "Bekleyen veya okunmamış işin yok."
        await finish(s, "Tamam.")
        return "ok"

    async def dev_a(s: FakeSession, _m: str) -> str:
        await call_err(s, "self", "team_delegate", {"member_id": "dev-a", "title": "x", "instructions": "y"})
        await call_err(s, "up", "team_delegate", {"member_id": "lead", "title": "x", "instructions": "y"})
        await finish(s, "Kendim yaptım.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev A", dev_a)
    on_member(env, "Test", FINDINGS_OK)
    run_id = await start(env, team)
    assert (await env.wait_run(run_id)).status == "completed"
    assert "yalnız doğrudan bağlı üyelerine iş verebilirsin: dev-a (Dev A)" in errors["grandchild"]
    for key in ("tester", "advisor", "unknown", "self", "up"):
        assert "iş veremezsin" in errors[key], key
    assert "Bilinmeyen veya sana ait olmayan iş kimliği" in errors["deps"]
    assert "boş olamaz" in errors["empty"] and "boş olamaz" in errors["finish_empty"]
    assert "Bilinmeyen veya sana ait olmayan" in errors["wait_foreign"]
    assert "Henüz bitmemiş işlerin var" in errors["finish_open"]
    assert not sessions_of(env, "Alt")  # never got any work
    assert not [t for t in session_of(env, "Test").tool_names if t.startswith("team_")]


async def test_team_tools_outside_a_team_and_opt_in_binding(env: EngineEnv) -> None:
    from aistudio.contracts.tools import ToolContext

    ctx = ToolContext(workspace_id=env.workspace.id, session_id="ses_yabanci", provider="claude")
    host = env.tools.bind(ctx)
    assert not [s.name for s in host.specs() if s.name.startswith("team_")]  # opt-in: never bound by default
    explicit = env.tools.bind(ctx, ["team_wait", "ask_user"])
    assert sorted(s.name for s in explicit.specs()) == ["ask_user", "team_wait"]
    r = await explicit.call("team_wait", {})
    assert r.is_error and "yalnız çalışan bir ekibin üyesi" in r.content
    advisor_host = env.tools.bind(ctx, ["team_delegate", "team_wait"], allow_mutating=False)
    assert [s.name for s in advisor_host.specs()] == ["team_wait"]  # team_delegate is mutating
    assert all(s.opt_in for s in env.tools.all_specs() if s.name.startswith("team_"))


async def test_safety_caps(env: EngineEnv) -> None:
    team = spec(
        member("lead", "Lider", "lead"),
        member("dev-a", "Dev A", "worker", "lead"),
        member("dev-b", "Dev B", "worker", "lead"),
        max_assignments=2,
        max_parallel_members=1,
    )
    active = {"now": 0, "max": 0}
    errors: list[str] = []

    async def busy(s: FakeSession, _m: str) -> str:
        active["now"] += 1
        active["max"] = max(active["max"], active["now"])
        await asyncio.sleep(0.05)
        active["now"] -= 1
        return "ok"

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev-a", "A")
        await delegate(s, "dev-b", "B")
        r = await s.call("team_delegate", {"member_id": "dev-a", "title": "C", "instructions": "c"})
        assert r.is_error
        errors.append(r.content)
        ok(await s.call("team_wait", {}))
        await finish(s, "Bitti.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev A", busy)
    on_member(env, "Dev B", busy)
    run_id = await start(env, team)
    assert (await env.wait_run(run_id)).status == "completed"
    assert "en fazla iş sayısına ulaştı (2)" in errors[0]
    assert active["max"] == 1


async def test_failed_assignment_fails_its_dependents_and_reaches_the_lead(env: EngineEnv) -> None:
    team = spec(
        member("lead", "Lider", "lead"),
        member("dev-a", "Dev A", "worker", "lead"),
        member("dev-b", "Dev B", "worker", "lead"),
    )
    seen: dict[str, Any] = {}

    async def lead(s: FakeSession, _m: str) -> str:
        a = await delegate(s, "dev-a", "Temel")
        await delegate(s, "dev-b", "Üst kat", depends_on=[a])
        seen["wait"] = ok(await s.call("team_wait", {}))
        await finish(s, "Kısmen bitti.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev A", lambda _s, _m: TurnResult(turn_id="x", status="error", error="CLI çöktü"))  # type: ignore[arg-type, return-value]
    run_id = await start(env, team)
    assert (await env.wait_run(run_id)).status == "completed"
    results = {r["title"]: r for r in seen["wait"].data["results"]}
    assert results["Temel"]["status"] == "failed" and "CLI çöktü" in results["Temel"]["error"]
    assert results["Üst kat"]["status"] == "failed"
    assert "Bağımlı olduğu iş tamamlanamadı: 'Temel'" in results["Üst kat"]["error"]
    assert not sessions_of(env, "Dev B")
    failed = team_events(await env.events(run_id), "team.assignment.failed")
    assert len(failed) == 2


async def test_lone_lead_works_alone(env: EngineEnv) -> None:
    team = spec(member("lead", "Lider", "lead"))

    async def lead(s: FakeSession, message: str) -> str:
        assert "Bu görevi kendin yap" in message
        assert not {"team_delegate", "team_wait"} & set(s.tool_names)
        env.worktrees.touch(s.req.worktree_id or "", "solo.py")
        await finish(s, "Tek başıma yaptım.")
        return "ok"

    on_member(env, "Lider", lead)
    run_id = await start(env, team)
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    node = [n for n in run.nodes if n.node_id == "team"][-1]
    assert node.output == "Tek başıma yaptım." and (node.data or {})["changed_files"] == ["solo.py"]


async def test_member_provider_switches_when_its_limit_is_exhausted(env: EngineEnv) -> None:
    from aistudio.contracts.flows import FlowSettings
    from aistudio.contracts.limits import LimitPolicy

    team = spec(member("lead", "Lider", "lead"), member("dev", "Dev", "worker", "lead", provider="codex"))
    env.limits.exhaust("codex")

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev", "İş")
        ok(await s.call("team_wait", {}))
        await finish(s, "Tamam.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev", worker(env, "x.py"))
    from team_support import team_graph

    graph = team_graph(team)
    graph.settings = FlowSettings(limit_policy=LimitPolicy(on_exhausted="switch_provider"))
    task = await env.create(graph=graph)
    run_id = await env.run_of(task.id)
    assert (await env.wait_run(run_id)).status == "completed"
    assert session_of(env, "Dev").provider == "claude"
    v = await view(env, run_id)
    dev = next(m for m in v.members if m.member_id == "dev")
    assert dev.provider == "claude" and dev.switched_from == "codex"
    switched = [e.payload for e in await env.events(run_id, ["node.provider_switched"])]
    assert switched and switched[0]["member_id"] == "dev"


async def test_team_mode_runs_gates_on_the_lead_worktree_and_loops_back(env: EngineEnv) -> None:
    from engine_support import FINDINGS_PASS, findings_json

    from aistudio.contracts.approvals import ApprovalKind

    team = spec(member("lead", "Lider", "lead"), member("dev", "Dev", "worker", "lead", provider="codex"))
    reviews = iter([findings_json(("high", "Parola düz metin saklanıyor")), FINDINGS_PASS])
    env.agents.on(lambda _s, _m: next(reviews), node_id="review")

    async def lead(s: FakeSession, message: str) -> str:
        if s.turn_index == 0:
            await delegate(s, "dev", "Kayıt formu")
            ok(await s.call("team_wait", {}))
            await finish(s, "İlk sürüm.")
        else:
            assert "Düzeltilmesi gerekenler" in message and "Parola düz metin saklanıyor" in message
            await delegate(s, "dev", "Parolayı hashle")
            ok(await s.call("team_wait", {}))
            await finish(s, "Parolalar hashleniyor.")
        return "ok"

    on_member(env, "Lider", lead)
    on_member(env, "Dev", worker(env, "register.py"))
    task = await env.create(FlowMode.team, team=team, title="Kayıt")
    run_id = await env.run_of(task.id)
    await env.decide(ApprovalKind.final)
    run = await env.wait_run(run_id, timeout=10)
    assert run.status == "completed", run
    assert [n.attempt for n in run.nodes if n.node_id == "team"] == [1, 2]
    assert len(sessions_of(env, "Lider")) == 1 and len(sessions_of(env, "Dev")) == 1  # sessions are reused
    lead_wt = session_of(env, "Lider").req.worktree_id
    assert ("" if lead_wt is None else lead_wt) in {w for w, c in env.worktrees.commands if c == "pytest -q"}
    gates = await env.engine.store.gate_results(run_id)
    review = [g for g in gates if g.kind == "cross_review"]
    assert review[0].evidence["author_provider"] == "claude" and review[0].evidence["reviewer_provider"] == "codex"
    v = await view(env, run_id)
    assert v.attempt == 2 and [a.title for a in v.assignments] == ["Kayıt formu", "Parolayı hashle"]
    detail = await env.engine.task_detail(task.id)
    assert detail.task.mode == FlowMode.team
    assert detail.quality is not None and any(c.key == "team" for c in detail.quality.components)


async def test_user_messages_to_members(env: EngineEnv) -> None:
    team = spec(member("lead", "Lider", "lead"), member("dev", "Dev", "worker", "lead"))
    gate = Gate()

    async def lead(s: FakeSession, _m: str) -> str:
        await delegate(s, "dev", "İş")
        ok(await s.call("team_wait", {}))
        await finish(s, "Tamam.")
        return "ok"

    async def dev(s: FakeSession, message: str) -> str:
        if s.turn_index == 0:
            await gate.wait()
            return "İlk tur."
        if s.turn_index == 1:
            assert "Kullanıcıdan mesaj" in message and "Testleri unutma" in message
            return "Mesajı uyguladım."
        return "Rica ederim."

    on_member(env, "Lider", lead)
    on_member(env, "Dev", dev)
    from aistudio.engine.team.models import MemberMessageBody

    run_id = await start(env, team)
    await wait_view(env, run_id, lambda v: any(a.status == "running" for a in v.assignments))
    steer = await env.engine.teams.message_member(run_id, "lead", MemberMessageBody(text="Acele et", mode="steer"))
    assert steer.delivered == "steer"
    queued = await env.engine.teams.message_member(run_id, "dev", MemberMessageBody(text="Testleri unutma"))
    assert queued.delivered == "queued"
    gate.open()
    run = await env.wait_run(run_id)
    assert run.status == "completed"
    v = await view(env, run_id)
    assert v.assignments[0].result_summary == "Mesajı uyguladım."
    assert ("[steer] Acele et") in session_of(env, "Lider").messages
    after = await env.engine.teams.message_member(run_id, "dev", MemberMessageBody(text="Teşekkürler"))
    assert after.delivered == "direct"
    messages = team_events(await env.events(run_id), "team.message")
    assert [m["delivered"] for m in messages] == ["steer", "queued", "direct"]
