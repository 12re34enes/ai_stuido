from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path

import pytest
from gitops_helpers import APP_PY, Env, make_repo, write

from aistudio.contracts.agents import AgentManager
from aistudio.core.errors import ValidationFailed
from aistudio.core.events import ET, EventFilter, Severity
from aistudio.gitops.watcher import CONFLICT_RESOLVED, ConflictWatcher
from aistudio.workspaces.service import RepoCreate


@dataclass
class _Session:
    id: str
    worktree_id: str | None


class FakeAgents:
    def __init__(self, sessions: list[_Session]) -> None:
        self.sessions = sessions

    async def list(self, **_: object) -> list[_Session]:
        return self.sessions


def _edit(base: str, line: str, new: str) -> None:
    p = Path(base, "src/app.py")
    p.write_text(p.read_text().replace(line, new))


async def _conflict_events(env: Env) -> list[tuple[str, list[str], list[str]]]:
    rows = await env.ctx.events.query(EventFilter(types=[ET.CONFLICT_DETECTED, CONFLICT_RESOLVED]))
    return [(e.type, e.payload["worktree_ids"], e.payload["paths"]) for e in rows]


async def test_overlap_detected_and_resolved(env: Env, tmp_path: Path) -> None:
    other_repo = make_repo(tmp_path / "other")
    other = await env.workspaces.add_repo(env.ws.id, RepoCreate(path=str(other_repo)))
    a = await env.mgr.create(env.repo.id, label="claude", run_id="run_1")
    b = await env.mgr.create(env.repo.id, label="codex", run_id="run_1")
    c = await env.mgr.create(other.id, label="claude")
    env.ctx.services.register(  # type: ignore[type-abstract]
        AgentManager, FakeAgents([_Session("ses_a", a.id), _Session("ses_b", b.id)])
    )
    watcher = env.mgr.watcher
    assert await watcher.scan() == []

    _edit(a.path, "line 5\n", "line five\n")
    _edit(b.path, "line 30\n", "line thirty\n")  # same file, no textual conflict
    write(a.path, "shared.txt", "from a\n")
    write(b.path, "shared.txt", "from b\n")  # add/add with different content -> conflict
    write(c.path, "shared.txt", "other repo\n")  # different repo: never overlaps
    write(a.path, "only-a.txt", "a\n")

    overlaps = await watcher.scan()
    assert [(o.path, o.worktree_ids) for o in overlaps] == [
        ("shared.txt", sorted([a.id, b.id])),
        ("src/app.py", sorted([a.id, b.id])),
    ]
    rows = await env.ctx.events.query(EventFilter(types=[ET.CONFLICT_DETECTED]))
    assert len(rows) == 1
    ev = rows[0]
    assert ev.severity == Severity.high and ev.run_id == "run_1" and ev.workspace_id == env.ws.id
    assert ev.payload["paths"] == ["shared.txt", "src/app.py"]
    assert ev.payload["worktree_ids"] == sorted([a.id, b.id])
    assert ev.payload["merge_conflicts"] == ["shared.txt"]
    assert ev.payload["session_ids"] == ["ses_a", "ses_b"]
    assert "aynı dosyalara" in ev.payload["message"]

    api_view = await env.mgr.overlaps()
    both = ["ses_a", "ses_b"]
    assert {o.path: o.session_ids for o in api_view} == {"shared.txt": both, "src/app.py": both}

    await watcher.scan()  # unchanged state: no duplicate alerts
    assert len(await _conflict_events(env)) == 1

    os.remove(Path(b.path, "shared.txt"))
    await watcher.scan()
    events = await _conflict_events(env)
    assert events[-1] == (CONFLICT_RESOLVED, sorted([a.id, b.id]), ["shared.txt"])
    assert [o.path for o in await watcher.scan()] == ["src/app.py"]

    await env.mgr.remove(b.id, force=True)  # a participant leaves -> the rest resolves
    await watcher.scan()
    events = await _conflict_events(env)
    assert events[-1] == (CONFLICT_RESOLVED, sorted([a.id, b.id]), ["src/app.py"])
    assert await env.mgr.overlaps() == []


async def test_state_is_rebuilt_from_events_after_restart(env: Env) -> None:
    a = await env.mgr.create(env.repo.id, label="claude")
    b = await env.mgr.create(env.repo.id, label="codex")
    write(a.path, "x.txt", "a\n")
    write(b.path, "x.txt", "b\n")
    await env.mgr.watcher.scan()
    assert len(await _conflict_events(env)) == 1

    restarted = ConflictWatcher(env.mgr, env.ctx)
    assert [o.path for o in await restarted.scan()] == ["x.txt"]
    assert len(await _conflict_events(env)) == 1  # no re-alert after a restart

    os.remove(Path(b.path, "x.txt"))
    await restarted.scan()
    assert (await _conflict_events(env))[-1][0] == CONFLICT_RESOLVED


async def test_check_pair(env: Env, tmp_path: Path) -> None:
    a = await env.mgr.create(env.repo.id)
    b = await env.mgr.create(env.repo.id)
    _edit(a.path, "line 1\n", "line one\n")
    _edit(b.path, "line 40\n", "line forty\n")
    clean = await env.mgr.check_pair(a.id, b.id)
    assert clean.clean and clean.conflicts == []
    _edit(b.path, "line 1\n", "line uno\n")
    conflict = await env.mgr.check_pair(a.id, b.id)
    assert not conflict.clean and conflict.conflicts == ["src/app.py"]
    # checks never touch the worktrees' real index
    assert Path(a.path, "src/app.py").read_text().startswith("line one")

    other = await env.workspaces.add_repo(env.ws.id, RepoCreate(path=str(make_repo(tmp_path / "o"))))
    c = await env.mgr.create(other.id)
    with pytest.raises(ValidationFailed):
        await env.mgr.check_pair(a.id, c.id)


async def test_file_events_trigger_detection_without_polling(env: Env) -> None:
    await env.ctx.store.set("gitops.conflict_poll_seconds", 3600)
    env.mgr.start()
    try:
        a = await env.mgr.create(env.repo.id, label="claude")
        b = await env.mgr.create(env.repo.id, label="codex")
        await asyncio.sleep(0.5)  # let the creation-triggered full scan settle
        async with env.ctx.events.subscribe(EventFilter(types=[ET.CONFLICT_DETECTED])) as stream:
            write(a.path, "src/app.py", APP_PY + "a\n")
            write(b.path, "src/app.py", APP_PY + "b\n")

            async def first() -> list[str]:
                async for ev in stream:
                    return ev.payload["paths"]
                return []

            paths = await asyncio.wait_for(first(), timeout=15)
        assert paths == ["src/app.py"]
    finally:
        await env.mgr.stop()
