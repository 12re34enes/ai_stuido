from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
from gitops_helpers import APP_PY, Env, commit, git, write

from aistudio.core.errors import NotFound, ValidationFailed
from aistudio.core.events import EventFilter
from aistudio.gitops.git import DiffLimits


async def test_create_layout_branch_and_event(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id, label="Claude Yazar", run_id="run_1")
    root = env.ctx.settings.paths.worktrees
    assert wt.path == str(root / "deneme-alani" / "manual" / "claude-yazar-1")
    assert wt.branch == "aistudio/manual/claude-yazar-1"
    assert wt.base_ref == "main"
    assert wt.base_sha == git(env.path, "rev-parse", "main")
    assert wt.status == "active" and wt.location.kind == "local"
    assert Path(wt.path, "src/app.py").read_text() == APP_PY
    assert git(wt.path, "rev-parse", "--abbrev-ref", "HEAD") == wt.branch
    # the user's checkout is untouched
    assert git(env.path, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    assert git(env.path, "status", "--porcelain") == ""

    assert (await env.mgr.get(wt.id)).branch == wt.branch
    assert [w.id for w in await env.mgr.list(run_id="run_1")] == [wt.id]
    events = await env.ctx.events.query(EventFilter(types=["gitops.worktree.created"]))
    assert events[-1].payload["worktree_id"] == wt.id

    second = await env.mgr.create(env.repo.id, label="Claude Yazar")
    assert second.branch.endswith("claude-yazar-2")


async def test_create_names_are_unique_under_concurrency(env: Env) -> None:
    # No FlowEngine registered: the task part falls back to "task-<last 6 id chars>".
    wts = await asyncio.gather(
        *(env.mgr.create(env.repo.id, label="codex", task_id="task_01ABCDEFGH") for _ in range(4))
    )
    assert sorted(w.branch for w in wts) == [f"aistudio/task-cdefgh/codex-{n}" for n in (1, 2, 3, 4)]
    assert len({w.path for w in wts}) == 4


async def test_create_skips_existing_branch_names(env: Env) -> None:
    git(env.path, "branch", "aistudio/manual/agent-1")
    wt = await env.mgr.create(env.repo.id)
    assert wt.branch == "aistudio/manual/agent-2"


async def test_create_from_base_ref_and_errors(env: Env) -> None:
    git(env.path, "checkout", "-q", "-b", "feature")
    write(env.path, "feature.txt", "f\n")
    feature_sha = commit(env.path, "feature work")
    git(env.path, "checkout", "-q", "main")

    wt = await env.mgr.create(env.repo.id, base_ref="feature")
    assert wt.base_sha == feature_sha and wt.base_ref == "feature"
    assert Path(wt.path, "feature.txt").exists()

    with pytest.raises(ValidationFailed):
        await env.mgr.create(env.repo.id, base_ref="does-not-exist")
    with pytest.raises(ValidationFailed):
        await env.mgr.create(env.repo.id, base_ref="--output=/tmp/x")
    with pytest.raises(NotFound):
        await env.mgr.get("wt_missing")


async def test_changed_files_covers_all_kinds(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    assert await env.mgr.changed_files(wt.id) == []
    write(wt.path, "committed.txt", "c\n")
    commit(wt.path, "agent commit")
    write(wt.path, "staged.txt", "s\n")
    git(wt.path, "add", "staged.txt")
    write(wt.path, "src/app.py", APP_PY + "more\n")  # unstaged
    write(wt.path, "untracked/new.txt", "u\n")
    write(wt.path, "debug.log", "ignored\n")
    write(wt.path, "node_modules/pkg/index.js", "ignored\n")
    git(wt.path, "mv", "README.md", "README2.md")  # rename counts as both paths
    assert await env.mgr.changed_files(wt.id) == [
        "README.md",
        "README2.md",
        "committed.txt",
        "src/app.py",
        "staged.txt",
        "untracked/new.txt",
    ]
    # nothing touched the real index beyond what the "agent" did
    assert "untracked/new.txt" not in git(wt.path, "diff", "--cached", "--name-only")


async def test_diff_renames_binary_untracked_and_head(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    clean = await env.mgr.diff(wt.id)
    assert clean.files == [] and clean.head == wt.base_sha

    git(wt.path, "mv", "src/app.py", "src/main.py")
    write(wt.path, "src/main.py", APP_PY.replace("line 5\n", "line five\n"))
    write(wt.path, "logo.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00binary")
    write(wt.path, "notes.md", "a\nb\n")
    commit(wt.path, "rename + binary")
    head = git(wt.path, "rev-parse", "HEAD")
    write(wt.path, "untracked.txt", "new\n")

    d = await env.mgr.diff(wt.id)
    assert d.base == wt.base_sha
    assert d.head != head  # working state includes the untracked file -> snapshot tree id
    by_path = {f.path: f for f in d.files}
    assert set(by_path) == {"src/main.py", "logo.png", "notes.md", "untracked.txt"}
    ren = by_path["src/main.py"]
    assert ren.status == "renamed" and ren.old_path == "src/app.py"
    assert (ren.additions, ren.deletions) == (1, 1)
    assert ren.patch is not None and "+line five" in ren.patch and "rename from src/app.py" in ren.patch
    assert by_path["logo.png"].status == "binary" and by_path["logo.png"].patch is None
    assert by_path["notes.md"].status == "added" and by_path["notes.md"].additions == 2
    assert by_path["untracked.txt"].status == "added"
    assert d.additions == 1 + 2 + 1 and d.deletions == 1 and not d.truncated

    os.remove(Path(wt.path, "untracked.txt"))
    committed_only = await env.mgr.diff(wt.id, include_patch=False)
    assert committed_only.head == head
    assert all(f.patch is None for f in committed_only.files)
    # snapshots never leave temp index files behind
    gitdir = git(wt.path, "rev-parse", "--absolute-git-dir")
    assert not [p for p in os.listdir(gitdir) if p.startswith("aistudio-index")]


async def test_diff_truncation_limits(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "big.txt", "".join(f"row {i}\n" for i in range(500)))
    write(wt.path, "a.txt", "small\n")
    write(wt.path, "b.txt", "small too\n")
    env.mgr.diff_limits = DiffLimits(max_file_bytes=2000)
    d = await env.mgr.diff(wt.id)
    by_path = {f.path: f for f in d.files}
    assert d.truncated and by_path["big.txt"].patch is None and by_path["big.txt"].additions == 500
    assert by_path["a.txt"].patch is not None

    env.mgr.diff_limits = DiffLimits(max_files=2)
    d = await env.mgr.diff(wt.id, include_patch=False)
    assert d.truncated and len(d.files) == 2 and d.additions == 502

    env.mgr.diff_limits = DiffLimits(max_total_bytes=150)
    d = await env.mgr.diff(wt.id)
    assert d.truncated and sum(1 for f in d.files if f.patch) < 3

    env.mgr.diff_limits = DiffLimits(max_file_lines=100)
    d = await env.mgr.diff(wt.id)
    assert d.truncated and {f.path for f in d.files if f.patch is None} == {"big.txt"}


async def test_commit_all(env: Env) -> None:
    wt = await env.mgr.create(env.repo.id)
    assert await env.mgr.commit_all(wt.id, "nothing") is None
    write(wt.path, "new.txt", "n\n")
    write(wt.path, "debug.log", "ignored\n")
    sha = await env.mgr.commit_all(wt.id, "Add new file")
    assert sha == git(wt.path, "rev-parse", "HEAD")
    assert git(wt.path, "log", "-1", "--format=%an <%ae>|%s") == "AI Studio <aistudio@localhost>|Add new file"
    assert git(wt.path, "show", "--name-only", "--format=", "HEAD") == "new.txt"
    assert git(wt.path, "status", "--porcelain") == ""
    assert await env.mgr.commit_all(wt.id, "again") is None
    events = await env.ctx.events.query(EventFilter(types=["gitops.worktree.committed"]))
    assert events[-1].payload["sha"] == sha


async def test_commit_all_ignores_hooks_and_signing(env: Env) -> None:
    hook = Path(git(env.path, "rev-parse", "--git-common-dir"))
    hook = (env.path / hook if not hook.is_absolute() else hook) / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\nexit 1\n")
    hook.chmod(0o755)
    git(env.path, "config", "commit.gpgsign", "true")
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "x.txt", "x\n")
    assert await env.mgr.commit_all(wt.id, "with failing hook") is not None
