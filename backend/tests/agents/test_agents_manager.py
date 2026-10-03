"""AgentManagerImpl with fake adapters: events, rows, permissions, resume, import, discovery,
stall detection."""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import pytest
from agents_fakes import AgentsEnv, FakeAdapter, FakeMemory, FakeRemote, native_info, tool, wait_until_async

from aistudio.agents.manager import AgentManagerImpl
from aistudio.agents.policy import REMOTE_ACCESS_MESSAGE
from aistudio.agents.profiles import ProfileCreate
from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.agents.transport_local import LocalTransport
from aistudio.contracts.agents import (
    AgentState,
    Boundaries,
    Message,
    MessageDelta,
    SandboxLevel,
    SessionRecord,
    SessionSpec,
    SessionStarted,
    StartSessionRequest,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalStatus
from aistudio.contracts.common import Environment, Location
from aistudio.contracts.limits import LimitService, LimitWindow
from aistudio.contracts.memory import MemoryService
from aistudio.contracts.remote import RemoteService
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.clock import utcnow
from aistudio.core.errors import Conflict, NotFound, Unavailable, ValidationFailed
from aistudio.core.events import Event, EventFilter, Severity


async def start(
    env: AgentsEnv, *, provider: str = "claude", spec: dict[str, Any] | None = None, **req: Any
) -> SessionRecord:
    s = SessionSpec.model_validate({"provider": provider, "cwd": str(env.cwd), **(spec or {})})
    return await env.manager.start_session(StartSessionRequest(workspace_id=env.workspace_id, spec=s, **req))


async def events(env: AgentsEnv, session_id: str, *types: str) -> list[Event]:
    return await env.ctx.events.query(EventFilter(session_id=session_id, types=list(types) or None))


async def pending(env: AgentsEnv) -> list[Approval]:
    return await env.approvals.list(status=ApprovalStatus.pending)


async def test_start_session_streams_events_with_ids(agents_env: AgentsEnv) -> None:
    env = agents_env
    async with env.ctx.events.subscribe(EventFilter(types=["agent.message.delta"])) as stream:
        rec = await start(env, task_id="task_1", run_id="run_1", node_id="n1", label="Yazar 1")
        assert rec.state == AgentState.idle
        assert (rec.native_id, rec.origin, rec.model, rec.label) == (
            "claude-native-1",
            "created",
            "fake-model",
            "Yazar 1",
        )
        handle = await env.manager.handle(rec.id)
        assert handle is env.claude.last
        result = await handle.wait_turn(await handle.send("merhaba"))
        assert result.text == "Merhaba"
        delta = await asyncio.wait_for(stream.__anext__(), 2)
    assert delta.ephemeral and delta.id == 0
    assert (delta.session_id, delta.task_id, delta.run_id, delta.actor) == (
        rec.id,
        "task_1",
        "run_1",
        f"agent:{rec.id}",
    )

    evs = await events(env, rec.id)
    types = [e.type for e in evs]
    assert types[0] == "agent.session.created"
    for t in (
        "agent.session.started",
        "agent.status",
        "agent.turn.started",
        "agent.message",
        "agent.usage",
        "agent.turn.completed",
    ):
        assert t in types
    assert "agent.message.delta" not in types  # ephemeral: never persisted
    agent_evs = [e for e in evs if e.type.startswith("agent.") and e.type != "agent.session.created"]
    assert all(
        (e.actor, e.workspace_id, e.task_id, e.run_id) == (f"agent:{rec.id}", env.workspace_id, "task_1", "run_1")
        for e in agent_evs
    )
    created = evs[0].payload
    assert created["provider"] == "claude" and created["origin"] == "created" and created["label"] == "Yazar 1"
    row = await env.manager.get(rec.id)
    assert row.state == AgentState.idle
    assert row.last_usage is not None and row.last_usage.input_tokens == 10


async def test_spec_composition_with_memory_profile_and_tools(agents_env: AgentsEnv) -> None:
    env = agents_env
    memory = FakeMemory(
        Boundaries(forbidden_paths=[".env"], denied_commands=["git push --force"]), context="HAFIZA: proje gerçekleri"
    )
    env.ctx.services.register(MemoryService, memory)  # type: ignore[type-abstract]
    registry = env.ctx.services.get(ToolRegistry)  # type: ignore[type-abstract]
    registry.register(tool("memory_read"))
    registry.register(tool("memory_propose", mutating=True))
    profile = await env.manager.profiles.create(
        ProfileCreate(
            name="Güvenlikçi",
            provider="claude",
            role="reviewer",
            model="opus",
            effort="high",
            instructions="PROFİL TALİMATI",
            boundaries=Boundaries(forbidden_paths=["secrets/"]),
        )
    )
    rec = await start(
        env,
        profile_id=profile.id,
        spec={
            "system_append": "DÜĞÜM METNİ",
            "boundaries": {"readonly_paths": ["docs/"]},
            "env": {"FOO": "1", "GITHUB_TOKEN": "placeholder"},
        },
    )
    s = env.claude.specs[-1]
    assert (rec.role, rec.model, rec.label, rec.profile_id) == ("reviewer", "opus", "Güvenlikçi", profile.id)
    assert (s.role, s.model, s.effort) == ("reviewer", "opus", "high")
    assert s.boundaries.forbidden_paths == [".env", "secrets/"]
    assert s.boundaries.readonly_paths == ["docs/"]
    assert s.boundaries.denied_commands == ["git push --force"]
    assert s.env == {"FOO": "1"}
    text = s.system_append
    positions = [text.index(x) for x in ("HAFIZA", "rol: İnceleyen", "PROFİL TALİMATI", "DÜĞÜM METNİ")]
    assert positions == sorted(positions)
    for needle in ("memory_propose", "ask_user", "report_status", "remote_exec", "db_query", "Turkish"):
        assert needle in text
    assert {t.name for t in env.claude.tool_hosts[-1].specs()} == {"memory_read", "memory_propose"}
    assert memory.context_roles == ["reviewer"]

    explicit = await start(env, profile_id=profile.id, spec={"role": "writer"})
    assert explicit.role == "writer"
    with pytest.raises(ValidationFailed):
        await start(env, provider="codex", profile_id=profile.id)
    with pytest.raises(NotFound):
        await start(env, profile_id="prf_missing")


async def test_advisor_is_read_only(agents_env: AgentsEnv) -> None:
    env = agents_env
    registry = env.ctx.services.get(ToolRegistry)  # type: ignore[type-abstract]
    registry.register(tool("memory_read"))
    registry.register(tool("memory_propose", mutating=True))
    await start(env, spec={"role": "advisor"})
    s = env.claude.specs[-1]
    assert s.boundaries.sandbox == SandboxLevel.read_only
    assert {t.name for t in env.claude.tool_hosts[-1].specs()} == {"memory_read"}
    h = env.claude.last
    await h.wait_turn(await h.send("edit:src/a.py"))
    assert not h.permission_results[-1].allow
    assert "Danışman" in (h.permission_results[-1].reason or "")
    await h.wait_turn(await h.send("bash:rm -rf build"))
    assert not h.permission_results[-1].allow
    await h.wait_turn(await h.send("bash:git status && git log -n 3"))
    assert h.permission_results[-1].allow
    assert await pending(env) == []


async def test_permission_ask_approve_roundtrip(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env, task_id="t1", run_id="r1")
    h = env.claude.last
    turn = await h.send("bash:npm install")
    await wait_until_async(lambda: _has_pending(env))
    (a,) = await pending(env)
    assert a.kind == ApprovalKind.tool_permission
    assert (a.session_id, a.task_id, a.run_id, a.workspace_id) == (rec.id, "t1", "r1", env.workspace_id)
    assert a.payload["command"] == "npm install" and a.payload["tool"] == "Bash"
    assert a.severity == Severity.high and not a.production
    assert "npm install" in a.title and a.requested_by == f"agent:{rec.id}"
    assert (await env.manager.get(rec.id)).state == AgentState.waiting_permission
    assert await env.manager.check_stalls(0.0001) == []  # waiting sessions never stall

    await env.approvals.decide(a.id, approve=True, decision_payload={"updated_input": {"command": "npm ci"}})
    await h.wait_turn(turn)
    d = h.permission_results[-1]
    assert d.allow and d.decided_by == "user" and d.updated_input == {"command": "npm ci"}
    req_ev, dec_ev = await events(env, rec.id, "agent.permission.request", "agent.permission.decided")
    assert req_ev.payload["verdict"] == "ask" and req_ev.payload["command"] == "npm install"
    assert dec_ev.payload == {
        "request_id": "perm-1",
        "allow": True,
        "reason": "Kullanıcı onayladı.",
        "decided_by": "user",
        "rule": "needs_approval",
        "approval_id": a.id,
    }
    assert (await env.manager.get(rec.id)).state == AgentState.idle


async def test_permission_reject_and_timeout(agents_env: AgentsEnv) -> None:
    env = agents_env
    await start(env)
    h = env.claude.last
    turn = await h.send("bash:make deploy")
    await wait_until_async(lambda: _has_pending(env))
    (a,) = await pending(env)
    await env.approvals.decide(a.id, approve=False, note="hayır, önce testler")
    await h.wait_turn(turn)
    assert not h.permission_results[-1].allow
    assert "hayır, önce testler" in (h.permission_results[-1].reason or "")

    await env.ctx.store.set("agents.permission_timeout_minutes", 0.002)
    await h.wait_turn(await h.send("bash:make deploy"))
    d = h.permission_results[-1]
    assert not d.allow and "süresi doldu" in (d.reason or "")
    cancelled = await env.approvals.list(status=ApprovalStatus.cancelled)
    assert len(cancelled) == 1


async def test_remote_command_denied_without_approval(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env)
    h = env.claude.last
    await h.wait_turn(await h.send("bash:ls && ssh prod-db 'pg_dump app' > dump.sql"))
    d = h.permission_results[-1]
    assert not d.allow and d.reason == REMOTE_ACCESS_MESSAGE and d.decided_by == "policy"
    assert await pending(env) == []
    (dec,) = await events(env, rec.id, "agent.permission.decided")
    assert dec.payload["rule"] == "remote_access" and dec.severity == Severity.normal


async def test_policy_allows_project_commands_and_protects_app_data(agents_env: AgentsEnv) -> None:
    env = agents_env
    await start(env)
    h = env.claude.last
    await h.wait_turn(await h.send("bash:pytest -q tests/test_x.py"))
    assert h.permission_results[-1].allow
    await h.wait_turn(await h.send("edit:src/new_module.py"))
    assert h.permission_results[-1].allow
    await h.wait_turn(await h.send(f"edit:{env.ctx.settings.paths.db}"))
    assert not h.permission_results[-1].allow
    await h.wait_turn(await h.send(f"read:{env.ctx.settings.paths.home}/runtime.json"))
    assert not h.permission_results[-1].allow
    assert await pending(env) == []


async def test_resume_via_handle_after_process_exit(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env, tool_names=["memory_read"])
    h1 = env.claude.last
    await h1.end("completed")
    row = await env.manager.get(rec.id)
    assert row.state == AgentState.done and not env.manager.is_live(rec.id)

    h2 = await env.manager.handle(rec.id)
    assert h2 is not h1 and len(env.claude.specs) == 2
    resumed = env.claude.specs[-1]
    assert resumed.resume_native_id == "claude-native-1"
    assert resumed.system_append == env.claude.specs[0].system_append
    row = await env.manager.get(rec.id)
    assert row.state == AgentState.idle and row.native_id == "claude-native-1"
    assert [e.type for e in await events(env, rec.id, "agent.session.resumed")] == ["agent.session.resumed"]
    assert await env.manager.handle(rec.id) is h2  # live: no second resume

    assert h2 is env.claude.last
    await env.claude.last.end("error")
    (ended,) = [e for e in await events(env, rec.id, "agent.session.ended") if e.payload["reason"] == "error"]
    assert ended.severity == Severity.critical
    assert (await env.manager.get(rec.id)).state == AgentState.error
    turn = await env.manager.send(rec.id, "tekrar")
    assert len(env.claude.specs) == 3
    await env.claude.last.wait_turn(turn)


async def test_resume_after_restart_uses_stored_request(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env, spec={"model": "sonnet", "extra_dirs": [str(env.cwd.parent)]}, label="Kalıcı")
    await env.manager.repo.update(rec.id, state=AgentState.thinking)
    assert await env.manager.repo.recover_after_restart() == 1
    assert (await env.manager.get(rec.id)).state == AgentState.interrupted

    fresh = AgentManagerImpl(env.ctx, env.registry, LocalTransport())
    h = await fresh.handle(rec.id)
    spec = env.claude.specs[-1]
    assert h is env.claude.last
    assert (spec.resume_native_id, spec.model, spec.extra_dirs) == ("claude-native-1", "sonnet", [str(env.cwd.parent)])
    await fresh.stop()


async def test_handle_without_native_id_conflicts(agents_env: AgentsEnv) -> None:
    env = agents_env
    now = utcnow()
    rec = SessionRecord(
        id="ses_x", workspace_id=env.workspace_id, provider="claude", cwd=str(env.cwd), created_at=now, updated_at=now
    )
    await env.manager.repo.insert(rec)
    with pytest.raises(Conflict):
        await env.manager.handle("ses_x")
    with pytest.raises(NotFound):
        await env.manager.handle("ses_missing")


async def test_import_native_history_and_resume(agents_env: AgentsEnv) -> None:
    env = agents_env
    usage = Usage(input_tokens=7, output_tokens=3)
    env.claude.history["abc"] = [
        SessionStarted(native_id="abc", model="sonnet", cwd=str(env.cwd)),
        TurnStarted(turn_id="t1", input="selam"),
        Message(message_id="u1", role="user", text="selam"),
        MessageDelta(message_id="a1", text="mer"),
        Message(message_id="a1", text="merhaba"),
        usage,
        TurnCompleted(turn_id="t1", status="success", usage=usage),
    ]
    info = native_info("claude", "abc", cwd=str(env.cwd), title="Eski oturum")
    rec = await env.manager.import_native(env.workspace_id, info)
    assert (rec.origin, rec.native_id, rec.state, rec.model, rec.title) == (
        "imported",
        "abc",
        AgentState.idle,
        "sonnet",
        "Eski oturum",
    )
    assert rec.last_usage is not None and rec.last_usage.input_tokens == 7
    evs = await events(env, rec.id)
    assert [e.type for e in evs] == [
        "agent.session.created",
        "agent.session.started",
        "agent.turn.started",
        "agent.message",
        "agent.message",
        "agent.usage",
        "agent.turn.completed",
        "agent.session.imported",
    ]
    assert evs[0].payload["origin"] == "imported" and evs[-1].payload["events"] == 6
    assert all(e.session_id == rec.id and e.workspace_id == env.workspace_id for e in evs)
    again = await env.manager.import_native(env.workspace_id, info)
    assert again.id == rec.id

    await env.manager.handle(rec.id)
    spec = env.claude.specs[-1]
    assert (spec.resume_native_id, spec.cwd, spec.location) == ("abc", str(env.cwd), Location())


async def test_remote_import_discovery_and_production_approvals(agents_env: AgentsEnv) -> None:
    env = agents_env
    remote_transport = LocalTransport()
    remote = FakeRemote(remote_transport, Environment.production)
    env.ctx.services.register(RemoteService, remote)  # type: ignore[type-abstract]
    loc = Location.remote("host_1")
    env.codex.native_sessions = [native_info("codex", "r1", cwd="/srv/app", title="Uzak")]
    found = await env.manager.discover(loc)
    assert [(f.native_id, f.location) for f in found] == [("r1", loc)]
    assert remote.transport_calls == ["host_1"]

    rec = await env.manager.import_native(env.workspace_id, found[0])
    assert rec.location == loc and rec.cwd == "/srv/app"
    h = await env.manager.handle(rec.id)
    assert env.codex.transports[-1] is remote_transport
    assert env.codex.specs[-1].location == loc

    turn = await h.send("bash:make")
    await wait_until_async(lambda: _has_pending(env))
    (a,) = await pending(env)
    assert a.production and a.severity == Severity.critical
    await env.approvals.decide(a.id, approve=True)
    await env.codex.last.wait_turn(turn)


async def test_discovery_aggregates_adapters(agents_env: AgentsEnv) -> None:
    env = agents_env
    now = utcnow()
    env.claude.native_sessions = [
        native_info("claude", "c1", cwd="/p/a", title="A", updated_at=now - timedelta(hours=1)),
        native_info("claude", "c2", cwd="/p/b", title="B", updated_at=now),
        native_info("claude", "c2", cwd="/p/b", title="B dup", updated_at=now),
    ]
    env.codex.native_sessions = [
        native_info("codex", "x1", cwd="/p/a", title="X", updated_at=now - timedelta(minutes=30))
    ]
    found = await env.manager.discover(Location())
    assert [f.native_id for f in found] == ["c2", "x1", "c1"]
    filtered = await env.manager.discover(Location(), cwd="/p/a")
    assert {f.native_id for f in filtered} == {"c1", "x1"}
    assert env.claude.discover_calls[-1] == "/p/a"
    env.codex.fail_discovery = True
    assert [f.native_id for f in await env.manager.discover(Location())] == ["c2", "c1"]
    with pytest.raises(Unavailable):
        await env.manager.discover(Location.remote("host_x"))  # no RemoteService registered


async def test_stall_watchdog_emits_once_per_stall(agents_env: AgentsEnv) -> None:
    env = agents_env
    await env.ctx.store.set("agents.stall_minutes", 0.002)  # ~0.12 s
    env.ctx.spawn(env.manager._watchdog_loop(), name="test-watchdog")  # picks up the setting immediately
    rec = await start(env)
    h = env.claude.last
    await asyncio.sleep(0.25)
    assert await stalled(env, rec.id) == []  # idle sessions never stall

    await h.send("hang")
    await wait_until_async(lambda: _count_stalled(env, rec.id, 1))
    await asyncio.sleep(0.3)
    evs = await stalled(env, rec.id)
    assert len(evs) == 1
    assert evs[0].severity == Severity.critical and evs[0].payload["state"] == "thinking"

    await h.emit_activity()  # output again: re-arms the watchdog
    await wait_until_async(lambda: _count_stalled(env, rec.id, 2))


async def test_start_failure_marks_error(agents_env: AgentsEnv) -> None:
    env = agents_env
    env.claude.fail_start = True
    with pytest.raises(Unavailable):
        await start(env)
    (rec,) = await env.manager.list(workspace_id=env.workspace_id)
    assert rec.state == AgentState.error
    (err,) = await events(env, rec.id, "agent.error")
    assert err.payload["code"] == "start_failed" and "binary missing" in err.payload["message"]


async def test_close_interrupt_list_and_initial_prompt(agents_env: AgentsEnv) -> None:
    env = agents_env
    rec = await start(env, initial_prompt="ilk görev")
    h = env.claude.last
    assert h.sent == ["ilk görev"]
    assert [r.id for r in await env.manager.list(active_only=True)] == [rec.id]
    await env.manager.interrupt(rec.id)
    assert h.interrupts == 1
    closed = await env.manager.close(rec.id)
    assert closed.state == AgentState.done and h.closed
    (ended,) = await events(env, rec.id, "agent.session.ended")
    assert ended.payload["reason"] == "closed" and ended.severity == Severity.info
    assert await env.manager.list(active_only=True) == []
    assert [r.id for r in await env.manager.list(workspace_id=env.workspace_id)] == [rec.id]
    await env.manager.close(rec.id)  # idempotent
    await env.manager.interrupt(rec.id)  # not live: no-op
    assert h.interrupts == 1


async def test_sink_forwards_limits(agents_env: AgentsEnv) -> None:
    env = agents_env
    await start(env)
    window = LimitWindow(provider="claude", window="five_hour", label="5 saat", used_percent=42, observed_at=utcnow())
    await env.claude.last.sink.limits([window])
    svc = env.ctx.services.get(LimitService)  # type: ignore[type-abstract]
    (current,) = await svc.current("claude")
    assert current.used_percent == 42


async def test_health_reports_every_provider(agents_env: AgentsEnv) -> None:
    env = agents_env
    report = await env.manager.health()
    assert [(h.provider, h.installed) for h in report] == [("claude", True), ("codex", True)]
    registry = AdapterRegistryImpl()
    registry.register(FakeAdapter("claude"))
    partial = AgentManagerImpl(env.ctx, registry, LocalTransport())
    report = await partial.health()
    assert [(h.provider, h.installed) for h in report] == [("claude", True), ("codex", False)]
    assert report[1].message


async def test_unknown_workspace_rejected(agents_env: AgentsEnv) -> None:
    env = agents_env
    with pytest.raises(NotFound):
        await env.manager.start_session(
            StartSessionRequest(workspace_id="ws_missing", spec=SessionSpec(provider="claude", cwd=str(env.cwd)))
        )


# --------------------------------------------------------------------------- helpers


async def _has_pending(env: AgentsEnv) -> bool:
    return bool(await pending(env))


async def stalled(env: AgentsEnv, session_id: str) -> list[Event]:
    return await events(env, session_id, "agent.stalled")


async def _count_stalled(env: AgentsEnv, session_id: str, n: int) -> bool:
    return len(await stalled(env, session_id)) >= n
