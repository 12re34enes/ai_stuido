"""Helpers for team tests: spec builders and scripted members that drive the team through the bound
ToolHost (exactly like a CLI calling Studio tools)."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from engine_fakes import FakeSession
from engine_support import EngineEnv, wait_for

from aistudio.contracts.flows import FlowGraph, FlowNode, TeamNodeConfig
from aistudio.contracts.teams import TeamMember, TeamSettings, TeamSpec
from aistudio.engine.team.models import TeamRunDetail

FINDINGS_OK = 'Testler geçti.\n\n```json\n{"verdict": "pass", "summary": "Hepsi geçti.", "findings": []}\n```'


def findings_fail(message: str = "Giriş butonu çalışmıyor", severity: str = "high") -> str:
    return (
        "Test başarısız.\n\n```json\n"
        f'{{"verdict": "fail", "summary": "{message}", "findings": '
        f'[{{"severity": "{severity}", "file": "app.py", "line": 3, "message": "{message}"}}]}}\n```'
    )


def member(member_id: str, name: str, role: str, parent: str | None = None, **kw: Any) -> TeamMember:
    return TeamMember.model_validate({"id": member_id, "name": name, "role": role, "parent_id": parent, **kw})


def spec(*members: TeamMember, **settings: Any) -> TeamSpec:
    return TeamSpec(members=list(members), settings=TeamSettings.model_validate(settings))


def team_graph(team: TeamSpec, node_id: str = "team") -> FlowGraph:
    return FlowGraph(nodes=[FlowNode(id=node_id, label="Ekip", config=TeamNodeConfig(team=team))])


Script = Callable[[FakeSession, str], Awaitable[str] | str]


def on_member(env: EngineEnv, name: str, script: Script | str) -> None:
    """Answer turns of the team member whose session label is ``name``."""
    env.agents.on(script, label_contains=name)  # type: ignore[arg-type]


def session_of(env: EngineEnv, name: str) -> FakeSession:
    found = [s for s in env.agents.sessions.values() if s.req.label == name]
    assert len(found) == 1, f"expected one session for {name}, got {len(found)}"
    return found[0]


def sessions_of(env: EngineEnv, name: str) -> list[FakeSession]:
    return [s for s in env.agents.sessions.values() if s.req.label == name]


async def start(env: EngineEnv, team: TeamSpec, *, prompt: str = "Giriş sayfasını yap", **kw: Any) -> str:
    task = await env.create(graph=team_graph(team), prompt=prompt, **kw)
    return await env.run_of(task.id)


async def view(env: EngineEnv, run_id: str, node_id: str | None = None) -> TeamRunDetail:
    return await env.engine.teams.run_view(run_id, node_id)


async def wait_view(
    env: EngineEnv, run_id: str, check: Callable[[TeamRunDetail], bool], timeout: float = 5.0
) -> TeamRunDetail:
    async def probe() -> TeamRunDetail | None:
        try:
            v = await view(env, run_id)
        except Exception:
            return None
        return v if check(v) else None

    return await wait_for(probe, timeout)


def ok(result: Any) -> Any:
    assert not result.is_error, result.content
    return result


async def delegate(s: FakeSession, member_id: str, title: str, **kw: Any) -> str:
    r = ok(
        await s.call("team_delegate", {"member_id": member_id, "title": title, "instructions": f"{title} yap", **kw})
    )
    return str(r.data["assignment_id"])


async def finish(s: FakeSession, summary: str) -> None:
    ok(await s.call("team_finish", {"summary": summary}))


def worker(env: EngineEnv, *paths: str, reply: str = "Yaptım.", finish_summary: str | None = None) -> Script:
    """A leaf member: touches files in its worktree, optionally calls team_finish."""

    async def respond(s: FakeSession, _m: str) -> str:
        if paths and s.req.worktree_id:
            env.worktrees.touch(s.req.worktree_id, *paths)
        if finish_summary is not None:
            await finish(s, finish_summary)
        return reply

    return respond


async def restart(env: EngineEnv, ctx: Any, git_repo: Any, tmp_path: Any, *, while_down: Any = None) -> EngineEnv:
    """Simulate a studiod restart: stop the engine (state stays in the DB) and build a fresh one."""
    from engine_support import build_env

    from aistudio.core.context import AppContext
    from aistudio.core.services import ServiceRegistry

    await env.engine.shutdown()
    if while_down is not None:
        while_down()
    new_ctx = AppContext(
        settings=ctx.settings,
        db=ctx.db,
        events=ctx.events,
        masker=ctx.masker,
        secrets=ctx.secrets,
        store=ctx.store,
        services=ServiceRegistry(),
    )
    return await build_env(new_ctx, git_repo, tmp_path, fakes=env)


class Gate:
    """An asyncio event a scripted member can block on."""

    def __init__(self) -> None:
        self.event = asyncio.Event()

    async def wait(self) -> None:
        await self.event.wait()

    def open(self) -> None:
        self.event.set()
