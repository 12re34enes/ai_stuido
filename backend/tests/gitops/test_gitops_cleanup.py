from __future__ import annotations

import shutil
from datetime import timedelta
from pathlib import Path

from gitops_helpers import Env, commit, git, git_rc, write

from aistudio.core.clock import utcnow
from aistudio.core.events import EventFilter
from aistudio.gitops.tables import worktrees as wt_t


async def _age(env: Env, worktree_id: str, hours: float) -> None:
    async with env.ctx.db.begin() as conn:
        await conn.execute(
            wt_t.update().where(wt_t.c.id == worktree_id).values(updated_at=utcnow() - timedelta(hours=hours))
        )


def _has_branch(env: Env, branch: str) -> bool:
    return git_rc(env.path, "show-ref", "--verify", f"refs/heads/{branch}") == 0


async def test_cleanup_respects_retention_and_branch_safety(env: Env) -> None:
    git(env.path, "checkout", "-q", "-b", "dev")
    await env.ctx.store.set("gitops.retention_hours", 24)

    merged_old = await env.mgr.create(env.repo.id, label="merged-old")
    write(merged_old.path, "m.txt", "m\n")
    commit(merged_old.path, "m")
    assert (await env.mgr.merge(merged_old.id)).merged
    await _age(env, merged_old.id, 25)

    merged_new = await env.mgr.create(env.repo.id, label="merged-new")
    write(merged_new.path, "n.txt", "n\n")
    commit(merged_new.path, "n")
    assert (await env.mgr.merge(merged_new.id)).merged

    abandoned_work = await env.mgr.create(env.repo.id, label="abandoned-work")
    write(abandoned_work.path, "w.txt", "w\n")
    commit(abandoned_work.path, "unmerged agent work")
    write(abandoned_work.path, "dirty.txt", "uncommitted\n")
    await env.mgr.abandon(abandoned_work.id)
    await _age(env, abandoned_work.id, 30)

    abandoned_empty = await env.mgr.create(env.repo.id, label="abandoned-empty")
    await env.mgr.abandon(abandoned_empty.id)
    await _age(env, abandoned_empty.id, 30)

    active = await env.mgr.create(env.repo.id, label="active")
    await _age(env, active.id, 100)

    report = await env.mgr.cleanup()
    assert sorted(report.removed) == sorted([merged_old.id, abandoned_work.id, abandoned_empty.id])
    assert report.errors == {} and report.pruned_repos == 1
    statuses = {w.id: w.status for w in await env.mgr.list(active_only=False)}
    assert statuses[merged_old.id] == "removed" and statuses[merged_new.id] == "merged"
    assert statuses[active.id] == "active"
    assert not Path(merged_old.path).exists() and Path(merged_new.path).exists()
    assert not _has_branch(env, merged_old.branch)
    assert _has_branch(env, abandoned_work.branch)  # unmerged commits are never thrown away
    assert not _has_branch(env, abandoned_empty.branch)
    assert (await env.ctx.events.query(EventFilter(types=["gitops.cleanup"])))[-1].payload["removed"]


async def test_cleanup_handles_missing_directories(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    shutil.rmtree(wt.path)
    report = await env.mgr.cleanup()
    assert report.abandoned == [wt.id] and report.removed == []
    assert (await env.mgr.get(wt.id)).status == "abandoned"
    assert wt.path not in git(env.path, "worktree", "list")

    await env.ctx.store.set("gitops.retention_hours", 0)
    report = await env.mgr.cleanup()
    assert report.removed == [wt.id]
    assert (await env.mgr.get(wt.id)).status == "removed"
    assert not _has_branch(env, wt.branch)
