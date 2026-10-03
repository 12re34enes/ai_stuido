"""Team restart recovery: persisted team state, sessions re-attached through AgentManager.handle()."""

from __future__ import annotations

from pathlib import Path

from engine_fakes import FakeSession
from engine_support import EngineEnv
from team_support import (
    Gate,
    delegate,
    finish,
    member,
    ok,
    on_member,
    restart,
    session_of,
    sessions_of,
    spec,
    start,
    wait_view,
)

from aistudio.contracts.agents import AgentState
from aistudio.core.context import AppContext

RESUMED = "AI Studio yeniden başlatıldı"


async def test_restart_resumes_team_and_reattaches_sessions(
    env: EngineEnv, ctx: AppContext, git_repo: Path, tmp_path: Path
) -> None:
    team = spec(
        member("lead", "Lider", "lead"),
        member("dev-a", "Dev A", "worker", "lead"),
        member("dev-b", "Dev B", "worker", "lead"),
    )
    gate = Gate()  # never opened: the CLIs die with studiod during these turns

    async def lead(s: FakeSession, message: str) -> str:
        if s.turn_index == 0:
            await delegate(s, "dev-a", "Hızlı iş")
            await delegate(s, "dev-b", "Uzun iş")
            await s.call("team_wait", {})  # cut short by the restart
            return "yarıda kaldı"
        assert message.startswith(RESUMED)
        r = ok(await s.call("team_wait", {}))
        assert {x["status"] for x in r.data["results"]} == {"completed"}, r.content
        await finish(s, "Yeniden başlatmadan sonra bitti.")
        return "ok"

    async def dev_a(s: FakeSession, _m: str) -> str:
        env.worktrees.touch(s.req.worktree_id or "", "a.py")
        return "A bitti."

    async def dev_b(s: FakeSession, message: str) -> str:
        if s.turn_index == 0:
            await gate.wait()
            return "olmadı"
        assert message.startswith(RESUMED) and "Uzun iş" in message
        env.worktrees.touch(s.req.worktree_id or "", "b.py")
        return "B bitti."

    on_member(env, "Lider", lead)
    on_member(env, "Dev A", dev_a)
    on_member(env, "Dev B", dev_b)
    run_id = await start(env, team)
    await wait_view(
        env,
        run_id,
        lambda v: (
            any(a.title == "Hızlı iş" and a.status == "completed" for a in v.assignments)
            and any(a.title == "Uzun iş" and a.status == "running" for a in v.assignments)
        ),
    )
    lead_s, dev_b_s = session_of(env, "Lider"), session_of(env, "Dev B")

    def cli_died() -> None:
        for s in (lead_s, dev_b_s):
            handle = env.agents.handles[s.id]
            if handle._current is not None:
                handle._current.cancel()
            handle.set_state(AgentState.idle)

    env2 = await restart(env, ctx, git_repo, tmp_path, while_down=cli_died)
    try:
        run = await env2.wait_run(run_id, timeout=10)
        assert run.status == "completed", run
        node = [n for n in run.nodes if n.node_id == "team"]
        assert [n.attempt for n in node] == [1] and node[0].output == "Yeniden başlatmadan sonra bitti."
        for name in ("Lider", "Dev A", "Dev B"):
            assert len(sessions_of(env, name)) == 1, name  # nothing was started twice
        assert lead_s.id in env.agents.handle_calls and dev_b_s.id in env.agents.handle_calls
        assert dev_b_s.messages[1].startswith(RESUMED) and lead_s.messages[1].startswith(RESUMED)
        assert len(session_of(env, "Dev A").messages) == 1  # its finished assignment was not redone
        v = await env2.engine.teams.run_view(run_id)
        assert [(a.title, a.status) for a in v.assignments] == [("Hızlı iş", "completed"), ("Uzun iş", "completed")]
        assert v.attempt == 1 and v.status == "completed"
        started = [e.payload for e in await env2.events(run_id, ["team.started"])]
        assert [p["resumed"] for p in started] == [False, True]
    finally:
        gate.open()
        await env2.engine.shutdown()
