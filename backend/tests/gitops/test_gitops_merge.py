from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from gitops_helpers import APP_PY, Env, commit, git, write

from aistudio.contracts.gitops import Worktree
from aistudio.core.errors import Conflict, NotFound, ValidationFailed
from aistudio.core.events import EventFilter


def _edit(base: str, line: str, new: str) -> None:
    p = Path(base, "src/app.py")
    p.write_text(p.read_text().replace(line, new))


async def _agent_work(env: Env, tag: str = "", line: int = 30) -> Worktree:
    """A worktree with two commits: a new file and an edit of one src/app.py line."""
    wt = await env.mgr.create(env.repo.id, label="claude")
    write(wt.path, f"feature{tag}.txt", "feature\n")
    commit(wt.path, "Add feature file")
    _edit(wt.path, f"line {line}\n", "line thirty\n" if line == 30 else f"line edited{tag}\n")
    commit(wt.path, f"Edit line {line}")
    return wt


def _move_user_off_main(env: Env) -> str:
    git(env.path, "checkout", "-q", "-b", "dev")
    return git(env.path, "rev-parse", "HEAD")


def _main_change(env: Env, *, line: str = "line 2\n", new: str = "line two\n") -> str:
    """Advance main without checking it out in the user's repo (via a scratch worktree)."""
    scratch = env.path.parent / "scratch-main"
    if not scratch.exists():
        git(env.path, "worktree", "add", "-q", str(scratch), "main")
    content = Path(scratch, "src/app.py").read_text().replace(line, new)
    write(scratch, "src/app.py", content)
    sha = commit(scratch, f"main: {new.strip()}")
    git(env.path, "worktree", "remove", "--force", str(scratch))
    return sha


async def test_merge_strategy_merge_uses_update_ref(env: Env) -> None:
    dev_head = _move_user_off_main(env)
    main_before = _main_change(env)
    wt = await _agent_work(env)
    branch_tip = git(wt.path, "rev-parse", "HEAD")

    result = await env.mgr.merge(wt.id, strategy="merge")
    assert result.merged and result.conflicts == []
    main = git(env.path, "rev-parse", "main")
    assert main == result.commit_sha
    assert git(env.path, "rev-parse", "main^1") == main_before
    assert git(env.path, "rev-parse", "main^2") == branch_tip
    assert git(env.path, "log", "-1", "--format=%s", "main") == f"Merge branch '{wt.branch}' into main"
    merged_app = git(env.path, "show", "main:src/app.py")
    assert "line two" in merged_app and "line thirty" in merged_app
    # the user's checkout was not touched
    assert git(env.path, "rev-parse", "--abbrev-ref", "HEAD") == "dev"
    assert git(env.path, "rev-parse", "HEAD") == dev_head
    assert git(env.path, "status", "--porcelain") == ""
    assert (await env.mgr.get(wt.id)).status == "merged"
    ev = (await env.ctx.events.query(EventFilter(types=["gitops.worktree.merged"])))[-1]
    assert ev.payload["via"] == "update-ref" and ev.payload["commit_sha"] == main


async def test_merge_strategy_squash(env: Env) -> None:
    _move_user_off_main(env)
    main_before = _main_change(env)
    wt = await _agent_work(env)
    result = await env.mgr.merge(wt.id, strategy="squash")
    assert result.merged
    assert git(env.path, "rev-list", "--parents", "-n", "1", "main").split() == [result.commit_sha, main_before]
    msg = git(env.path, "log", "-1", "--format=%B", "main")
    assert msg.startswith(f"Squash merge of {wt.branch}")
    assert "* Add feature file\n* Edit line 30" in msg
    assert git(env.path, "show", "main:feature.txt") == "feature"

    custom = await _agent_work(env, tag="-2", line=35)
    res2 = await env.mgr.merge(custom.id, strategy="squash", message="Özel mesaj")
    assert res2.merged and git(env.path, "log", "-1", "--format=%s", "main") == "Özel mesaj"


@pytest.mark.parametrize("merge_base_flag", [True, False])
async def test_merge_strategy_cherry_pick(env: Env, merge_base_flag: bool) -> None:
    if not merge_base_flag:  # emulate git 2.38/2.39 (no merge-tree --merge-base)
        env.mgr._versions["local"] = (2, 39, 5)
    _move_user_off_main(env)
    main_before = _main_change(env)
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "feature.txt", "feature\n")
    git(wt.path, "add", "-A")
    git(wt.path, "-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-q", "-m", "First")
    first = git(wt.path, "rev-parse", "HEAD")
    _edit(wt.path, "line 30\n", "line thirty\n")
    second = commit(wt.path, "Second")

    result = await env.mgr.merge(wt.id, strategy="cherry_pick")
    assert result.merged
    log = git(env.path, "log", "--format=%H|%an|%s", f"{main_before}..main").splitlines()
    assert [line.split("|", 1)[1] for line in log] == ["Test|Second", "Agent|First"]
    assert git(env.path, "rev-parse", "main~2") == main_before
    bodies = git(env.path, "log", "--format=%B", f"{main_before}..main")
    assert f"(cherry picked from commit {first})" in bodies and f"(cherry picked from commit {second})" in bodies
    assert "line two" in git(env.path, "show", "main:src/app.py")
    assert git(env.path, "log", "-1", "--format=%cn", "main") == "AI Studio"


async def test_cherry_pick_conflict_reports_and_changes_nothing(env: Env) -> None:
    env.mgr._versions["local"] = (2, 39, 0)
    _move_user_off_main(env)
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "src/app.py", APP_PY.replace("line 2\n", "line deux\n"))
    commit(wt.path, "conflicting")
    main_before = _main_change(env)
    result = await env.mgr.merge(wt.id, strategy="cherry_pick")
    assert not result.merged and result.conflicts == ["src/app.py"]
    assert git(env.path, "rev-parse", "main") == main_before
    assert (await env.mgr.get(wt.id)).status == "active"


async def test_merge_into_checked_out_clean_branch_fast_forwards(env: Env) -> None:
    wt = await _agent_work(env)
    write(env.path, "local-untracked.txt", "user file\n")  # untracked files do not block
    result = await env.mgr.merge(wt.id, strategy="squash")
    assert result.merged
    assert git(env.path, "rev-parse", "HEAD") == result.commit_sha
    assert Path(env.path, "feature.txt").read_text() == "feature\n"
    assert git(env.path, "status", "--porcelain") == "?? local-untracked.txt"
    ev = (await env.ctx.events.query(EventFilter(types=["gitops.worktree.merged"])))[-1]
    assert ev.payload["via"] == "ff-only"


async def test_merge_refuses_when_checked_out_target_is_dirty(env: Env) -> None:
    wt = await _agent_work(env)
    main_before = git(env.path, "rev-parse", "main")
    write(env.path, "README.md", "# user edit in progress\n")
    with pytest.raises(Conflict) as exc:
        await env.mgr.merge(wt.id)
    assert "commit edilmemiş" in exc.value.message and "main" in exc.value.message
    assert git(env.path, "rev-parse", "main") == main_before
    assert Path(env.path, "README.md").read_text() == "# user edit in progress\n"
    assert (await env.mgr.get(wt.id)).status == "active"


async def test_conflicts_reported_by_preview_and_merge(env: Env) -> None:
    _move_user_off_main(env)
    wt = await env.mgr.create(env.repo.id)
    write(wt.path, "src/app.py", APP_PY.replace("line 2\n", "line deux\n"))
    write(wt.path, "ok.txt", "fine\n")
    commit(wt.path, "agent edit")
    main_before = _main_change(env)

    preview = await env.mgr.merge_preview(wt.id)
    assert not preview.clean and preview.conflicts == ["src/app.py"]
    assert preview.target_ref == "main" and preview.target_sha == main_before
    assert preview.diff is not None and {f.path for f in preview.diff.files} == {"src/app.py", "ok.txt"}

    for strategy in ("merge", "squash"):
        result = await env.mgr.merge(wt.id, strategy=strategy)  # type: ignore[arg-type]
        assert not result.merged and result.conflicts == ["src/app.py"] and result.commit_sha is None
    assert git(env.path, "rev-parse", "main") == main_before
    events = await env.ctx.events.query(EventFilter(types=["gitops.merge.conflict"]))
    assert events and events[-1].payload["conflicts"] == ["src/app.py"]


async def test_clean_preview_diff_and_noop_merge(env: Env) -> None:
    _move_user_off_main(env)
    wt = await _agent_work(env)
    preview = await env.mgr.merge_preview(wt.id)
    assert preview.clean and preview.conflicts == []
    assert preview.diff is not None
    assert {f.path for f in preview.diff.files} == {"feature.txt", "src/app.py"}
    first = await env.mgr.merge(wt.id, strategy="merge")
    again = await env.mgr.merge(wt.id, strategy="merge")
    assert again.merged and again.commit_sha == first.commit_sha and again.message
    squash_again = await env.mgr.merge(wt.id, strategy="squash")
    assert squash_again.commit_sha == first.commit_sha


async def test_merge_target_validation(env: Env) -> None:
    wt = await _agent_work(env)
    with pytest.raises(ValidationFailed):
        await env.mgr.merge(wt.id, target_ref="refs/tags/v1")
    with pytest.raises(ValidationFailed):
        await env.mgr.merge(wt.id, target_ref=wt.branch)
    with pytest.raises(NotFound):
        await env.mgr.merge(wt.id, target_ref="nope")
    with pytest.raises(ValidationFailed):
        await env.mgr.merge(wt.id, strategy="rebase")  # type: ignore[arg-type]


async def test_merge_into_other_branch_and_uncommitted_note(env: Env) -> None:
    git(env.path, "branch", "release")
    wt = await _agent_work(env)
    write(wt.path, "scratch.txt", "not committed\n")
    result = await env.mgr.merge(wt.id, target_ref="refs/heads/release", strategy="squash")
    assert result.merged and result.message and "commit edilmemiş" in result.message
    assert git(env.path, "rev-parse", "release") == result.commit_sha
    assert git_show_missing(env, "release", "scratch.txt")


def git_show_missing(env: Env, ref: str, path: str) -> bool:
    import subprocess

    return subprocess.run(["git", "cat-file", "-e", f"{ref}:{path}"], cwd=env.path).returncode != 0


async def test_merge_retries_when_target_moves_concurrently(env: Env, monkeypatch: pytest.MonkeyPatch) -> None:
    _move_user_off_main(env)
    wt = await _agent_work(env)
    original = env.mgr._compute_merge
    calls: list[str] = []

    async def racing(*args: Any, **kwargs: Any) -> Any:
        out = await original(*args, **kwargs)
        if not calls:  # someone else advances main right after our first computation
            calls.append(_main_change(env))
        return out

    monkeypatch.setattr(env.mgr, "_compute_merge", racing)
    result = await env.mgr.merge(wt.id, strategy="merge")
    assert result.merged
    assert git(env.path, "rev-parse", "main^1") == calls[0]
    assert "line two" in git(env.path, "show", "main:src/app.py")
