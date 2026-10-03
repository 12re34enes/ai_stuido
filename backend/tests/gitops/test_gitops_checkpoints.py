from __future__ import annotations

import os
from pathlib import Path

import pytest
from gitops_helpers import Env, commit, git, write

from aistudio.contracts.memory import MemoryService
from aistudio.core.errors import Conflict, NotFound
from aistudio.core.events import ET, EventFilter


class FakeMemory:
    def __init__(self) -> None:
        self.commit = "a1b2c3d4" * 5
        self.restored: list[tuple[str, str]] = []

    async def head(self, workspace_id: str) -> str | None:
        return self.commit

    async def restore(self, workspace_id: str, commit: str) -> None:
        self.restored.append((workspace_id, commit))


def _files(root: str) -> set[str]:
    out: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for f in filenames:
            if f != ".git":
                out.add(os.path.relpath(os.path.join(dirpath, f), root))
    return out


async def test_checkpoint_restore_round_trip(env: Env) -> None:
    memory = FakeMemory()
    env.ctx.services.register(MemoryService, memory)  # type: ignore[type-abstract]
    wt = await env.mgr.create(env.repo.id, run_id="run_9")
    write(wt.path, "del.txt", "to be deleted\n")
    write(wt.path, "kept.txt", "v1\n")
    c1 = commit(wt.path, "c1")
    # Uncommitted state at checkpoint time.
    write(wt.path, "README.md", "# modified, unstaged\n")
    write(wt.path, "staged.txt", "staged\n")
    git(wt.path, "add", "staged.txt")
    write(wt.path, "untracked.txt", "untracked v1\n")
    os.remove(Path(wt.path, "del.txt"))
    write(wt.path, "debug.log", "ignored\n")
    write(wt.path, "node_modules/pkg/index.js", "dep\n")
    index_before = git(wt.path, "diff", "--cached", "--name-only")

    cp = await env.mgr.checkpoint(run_id="run_9", node_id="dev", label="Geliştirme sonrası", worktree_ids=[wt.id])
    snap = cp.refs[wt.id]
    assert git(env.path, "rev-parse", f"refs/aistudio/checkpoints/{cp.id}/{wt.id}") == snap
    assert git(env.path, "rev-parse", f"{snap}^") == c1
    assert set(git(env.path, "ls-tree", "-r", "--name-only", snap).splitlines()) == {
        ".gitignore",
        "README.md",
        "kept.txt",
        "src/app.py",
        "staged.txt",
        "untracked.txt",
    }
    assert cp.memory_commit == memory.commit
    # checkpointing touched neither HEAD nor the index
    assert git(wt.path, "rev-parse", "HEAD") == c1
    assert git(wt.path, "diff", "--cached", "--name-only") == index_before
    ev = (await env.ctx.events.query(EventFilter(types=[ET.CHECKPOINT_CREATED])))[-1]
    assert ev.run_id == "run_9" and ev.payload["checkpoint_id"] == cp.id and ev.workspace_id == env.ws.id

    # Work continues after the checkpoint: commits, edits, new files, deletions.
    write(wt.path, "kept.txt", "v2\n")
    write(wt.path, "untracked.txt", "untracked v2\n")
    commit(wt.path, "c2")
    write(wt.path, "later.txt", "created later\n")
    write(wt.path, "later.log", "ignored later\n")
    os.remove(Path(wt.path, "README.md"))

    restored = await env.mgr.restore(cp.id)
    assert restored.id == cp.id
    assert git(wt.path, "rev-parse", "HEAD") == c1
    assert git(wt.path, "rev-parse", f"refs/heads/{wt.branch}") == c1
    assert git(wt.path, "diff", "--cached", "--name-only") == ""  # index == HEAD, changes unstaged
    assert Path(wt.path, "README.md").read_text() == "# modified, unstaged\n"
    assert Path(wt.path, "kept.txt").read_text() == "v1\n"
    assert Path(wt.path, "untracked.txt").read_text() == "untracked v1\n"
    assert Path(wt.path, "staged.txt").read_text() == "staged\n"
    assert not Path(wt.path, "del.txt").exists()
    assert not Path(wt.path, "later.txt").exists()
    # ignored files survive a restore
    assert {"debug.log", "later.log", "node_modules/pkg/index.js"} <= _files(wt.path)
    assert memory.restored == [(env.ws.id, memory.commit)]
    assert (await env.ctx.events.query(EventFilter(types=["gitops.checkpoint.restored"])))[-1].run_id == "run_9"

    assert [c.id for c in await env.mgr.list_checkpoints(run_id="run_9")] == [cp.id]
    assert (await env.mgr.get_checkpoint(cp.id)).label == "Geliştirme sonrası"


async def test_checkpoint_multiple_worktrees_and_reactivates_merged(env: Env) -> None:
    git(env.path, "checkout", "-q", "-b", "dev")
    a = await env.mgr.create(env.repo.id, label="claude")
    b = await env.mgr.create(env.repo.id, label="codex")
    write(a.path, "a.txt", "a\n")
    a1 = commit(a.path, "a1")
    write(b.path, "b.txt", "b\n")
    cp = await env.mgr.checkpoint(run_id=None, node_id=None, label="iki", worktree_ids=[a.id, b.id, a.id])
    assert set(cp.refs) == {a.id, b.id} and cp.memory_commit is None
    write(a.path, "a2.txt", "a2\n")
    commit(a.path, "a2")
    assert (await env.mgr.merge(a.id)).merged
    write(b.path, "b.txt", "changed\n")

    await env.mgr.restore(cp.id)
    assert git(a.path, "rev-parse", "HEAD") == a1 and not Path(a.path, "a2.txt").exists()
    assert Path(b.path, "b.txt").read_text() == "b\n"
    assert (await env.mgr.get(a.id)).status == "active"
    # the target branch the merge already moved is never rewritten by a restore
    assert "a2.txt" in git(env.path, "ls-tree", "--name-only", "main")


async def test_restore_errors(env: Env) -> None:
    with pytest.raises(NotFound):
        await env.mgr.restore("cp_missing")
    wt = await env.mgr.create(env.repo.id)
    cp = await env.mgr.checkpoint(run_id=None, node_id=None, label="x", worktree_ids=[wt.id])
    await env.mgr.remove(wt.id, force=True)
    with pytest.raises(Conflict):
        await env.mgr.restore(cp.id)
    with pytest.raises(Conflict):
        await env.mgr.checkpoint(run_id=None, node_id=None, label="y", worktree_ids=[wt.id])
