from __future__ import annotations

import asyncio
import os
import random
import string
import time
from pathlib import Path

import pytest
from gitops_helpers import Env, commit, git, git_rc, write

from aistudio.core.errors import Conflict, ValidationFailed
from aistudio.core.events import EventFilter


def _bare_remote(env: Env) -> Path:
    bare = env.path.parent / "remote.git"
    git(env.path.parent, "init", "-q", "--bare", str(bare))
    git(env.path, "remote", "add", "origin", str(bare))
    return bare


# --------------------------------------------------------------------------- push


async def test_push_own_branch_sets_upstream(env: Env) -> None:
    bare = _bare_remote(env)
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "a.txt", "a\n")
    head = commit(wt.path, "work")
    await env.mgr.push(wt.id)
    assert git(bare, "rev-parse", f"refs/heads/{wt.branch}") == head
    assert git(env.path, "config", f"branch.{wt.branch}.remote") == "origin"
    ev = (await env.ctx.events.query(EventFilter(types=["gitops.worktree.pushed"])))[-1]
    assert ev.payload["ref"] == f"refs/heads/{wt.branch}"


async def test_push_to_remote_branch_and_rejection(env: Env) -> None:
    bare = _bare_remote(env)
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "a.txt", "a\n")
    head = commit(wt.path, "work")
    await env.mgr.push(wt.id, remote_branch="feature/pr-12")
    assert git(bare, "rev-parse", "refs/heads/feature/pr-12") == head
    await env.mgr.push(wt.id, remote_branch="refs/heads/feature/pr-12")  # up to date: fine

    # Someone else pushes to the PR branch: our non-fast-forward push is refused.
    other = env.path.parent / "other"
    git(env.path.parent, "clone", "-q", str(bare), str(other))
    git(other, "checkout", "-q", "feature/pr-12")
    write(other, "b.txt", "b\n")
    commit(other, "someone else")
    git(other, "push", "-q", "origin", "feature/pr-12")
    write(wt.path, "c.txt", "c\n")
    commit(wt.path, "more work")
    with pytest.raises(Conflict) as exc:
        await env.mgr.push(wt.id, remote_branch="feature/pr-12")
    assert "reddedildi" in exc.value.message

    with pytest.raises(ValidationFailed):
        await env.mgr.push(wt.id, remote="--upload-pack=evil")
    with pytest.raises(ValidationFailed):  # URLs / unknown remotes are refused
        await env.mgr.push(wt.id, remote=str(env.path.parent / "elsewhere.git"))
    with pytest.raises(ValidationFailed):
        await env.mgr.push(wt.id, remote_branch="bad..name")


# --------------------------------------------------------------------------- remove


async def test_remove_dirty_requires_force_and_keeps_unmerged_branch(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "a.txt", "a\n")
    commit(wt.path, "work")
    write(wt.path, "dirty.txt", "uncommitted\n")
    with pytest.raises(Conflict):
        await env.mgr.remove(wt.id)
    assert Path(wt.path).exists()
    await env.mgr.remove(wt.id, force=True)
    assert not Path(wt.path).exists()
    assert (await env.mgr.get(wt.id)).status == "removed"
    assert git_rc(env.path, "show-ref", "--verify", f"refs/heads/{wt.branch}") == 0  # agent work preserved
    await env.mgr.remove(wt.id)  # idempotent
    with pytest.raises(Conflict):
        await env.mgr.changed_files(wt.id)
    ev = (await env.ctx.events.query(EventFilter(types=["gitops.worktree.removed"])))[-1]
    assert ev.payload["branch_deleted"] is False


async def test_remove_merged_deletes_branch_and_checkpoint_refs(env: Env) -> None:
    git(env.path, "checkout", "-q", "-b", "dev")
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "a.txt", "a\n")
    commit(wt.path, "work")
    cp = await env.mgr.checkpoint(run_id=None, node_id=None, label="before merge", worktree_ids=[wt.id])
    assert (await env.mgr.merge(wt.id)).merged
    await env.mgr.remove(wt.id)
    assert git_rc(env.path, "show-ref", "--verify", f"refs/heads/{wt.branch}") != 0
    assert git_rc(env.path, "show-ref", "--verify", f"refs/aistudio/checkpoints/{cp.id}/{wt.id}") != 0
    assert "a.txt" in git(env.path, "ls-tree", "--name-only", "main")  # merged work stays on main


async def test_remove_explicit_branch_delete_and_missing_directory(env: Env) -> None:
    import shutil

    wt = await env.mgr.create(env.repo.id)
    shutil.rmtree(wt.path)  # user deleted the directory by hand
    await env.mgr.remove(wt.id, delete_branch=True)
    assert (await env.mgr.get(wt.id)).status == "removed"
    assert git_rc(env.path, "show-ref", "--verify", f"refs/heads/{wt.branch}") != 0
    assert wt.path not in git(env.path, "worktree", "list")


async def test_abandon(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    assert (await env.mgr.abandon(wt.id)).status == "abandoned"
    assert await env.mgr.list() == []
    assert [w.id for w in await env.mgr.list(active_only=False)] == [wt.id]


# --------------------------------------------------------------------------- run_command


async def test_run_command_exit_code_cwd_and_combined_output(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    code, out = await env.mgr.run_command(wt.id, "pwd; echo out; echo err >&2; exit 3")
    assert code == 3
    lines = out.splitlines()  # a login shell's profile may print lines of its own first
    assert os.path.realpath(wt.path) in {os.path.realpath(line) for line in lines if line.startswith("/")}
    assert "out" in lines and "err" in lines
    ok, _ = await env.mgr.run_command(wt.id, "test -f src/app.py")
    assert ok == 0


async def test_run_command_timeout_kills_process_tree(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    marker = Path(wt.path, "late.txt")
    started = time.monotonic()
    # Generous margins: a login shell under heavy CPU load can take well over 0.3 s to print.
    code, out = await env.mgr.run_command(wt.id, "echo started; (sleep 4; touch late.txt) & sleep 60", timeout=2.0)
    assert code == 124
    assert "started" in out and "durduruldu" in out
    assert time.monotonic() - started < 15
    await asyncio.sleep(4.5)
    assert not marker.exists()  # the background child was killed with the group


async def test_run_command_masks_and_truncates(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    wt = await env.mgr.create(env.repo.id)
    known = "s3cr3t-" + "value-123"
    env.ctx.masker.add_secret(known)
    rng = random.Random(42)
    token = "ghp_" + "".join(rng.choice(string.ascii_letters + string.digits) for _ in range(36))
    code, out = await env.mgr.run_command(wt.id, f"echo {known}; echo {token}")
    assert code == 0 and known not in out and token not in out and out.count("[gizli]") == 2

    env.mgr.max_command_output = 1000
    code, out = await env.mgr.run_command(wt.id, "seq 1 100000")
    assert code == 0 and len(out) <= 1000 and out.rstrip().endswith("100000") and "kısaltıldı" in out

    monkeypatch.setenv("SSH_AUTH_SOCK", "/tmp/agent.sock")
    _, out = await env.mgr.run_command(wt.id, 'echo "[$SSH_AUTH_SOCK]"')
    assert "[]" in out
