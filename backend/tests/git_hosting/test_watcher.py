from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from gitfakes import (
    GH_TOKEN,
    FakeClock,
    FakeEngine,
    FakeHostingClient,
    comment,
    failing,
    make_repo,
    passing,
)

from aistudio.contracts.flows import GateKind, GitNodeConfig, NodeKind
from aistudio.contracts.git_hosting import CheckRun
from aistudio.contracts.tools import ToolContext
from aistudio.contracts.workspaces import Repo
from aistudio.core.context import AppContext
from aistudio.core.events import Event, EventFilter, Severity
from aistudio.git_hosting.http import RateLimited
from aistudio.git_hosting.models import GitAccountCreate
from aistudio.git_hosting.service import GitHostingServiceImpl
from aistudio.git_hosting.tools import PrCommentReplyTool


@dataclass
class Env:
    ctx: AppContext
    svc: GitHostingServiceImpl
    fake: FakeHostingClient
    engine: FakeEngine
    repo: Repo
    watch_id: str
    clock: FakeClock

    async def poll(self) -> None:
        await self.svc.watcher.poll(self.watch_id)

    async def events(self, type_: str) -> list[Event]:
        return await self.ctx.events.query(EventFilter(types=[type_]))


@pytest.fixture
async def env(gh_ctx: AppContext, git_repo: Path, clock: FakeClock, engine: FakeEngine) -> Any:
    fake = FakeHostingClient(clock)
    svc = GitHostingServiceImpl(gh_ctx, client_factory=lambda kind, api, token: fake, clock=clock)
    repo = await make_repo(gh_ctx, git_repo, "https://github.com/acme/widgets.git")
    await svc.add_account(GitAccountCreate(kind="github", token=GH_TOKEN))
    await gh_ctx.store.set("git.review_settle_seconds", 0)
    fake.set_pr()
    info = await svc.watcher.watch(repo.id, 7, task_id="task_origin", autofix=True)
    yield Env(gh_ctx, svc, fake, engine, repo, info.id, clock)
    await svc.aclose()


async def test_ci_failure_creates_exactly_one_fix_task(env: Env) -> None:
    env.fake.logs["11"] = "collected 3 items\nE   AssertionError: 0.1 + 0.2 != 0.3\n"
    env.fake.set_pr(sha="sha1", checks=[failing("test", "11"), passing("lint")])
    for _ in range(3):
        await env.poll()
    assert len(env.engine.created) == 1
    req = env.engine.created[0]
    assert req.source == "pr_watch"
    assert req.source_ref is not None
    assert req.source_ref["repo_id"] == env.repo.id and req.source_ref["pr"] == 7
    assert req.source_ref["kind"] == "ci" and req.source_ref["head_sha"] == "sha1"
    assert req.base_ref == "feature" and req.repo_ids == [env.repo.id]
    assert req.inputs["push_branch"] == "feature"
    assert [c["name"] for c in req.inputs["failing_checks"]] == ["test"]
    assert "AssertionError" in req.inputs["logs"]["test"] and "AssertionError" in req.prompt
    assert req.title == "PR #7: CI düzeltmesi (test)"
    # Explicit graph: agent(fix) -> build_test -> cross_review -> push onto the PR branch.
    assert req.graph is not None
    kinds = [(n.id, n.kind) for n in req.graph.nodes]
    assert kinds == [
        ("fix", NodeKind.agent),
        ("build", NodeKind.gate),
        ("review", NodeKind.gate),
        ("push", NodeKind.git),
    ]
    gates = [getattr(n.config, "gate", None) for n in req.graph.nodes]
    assert gates[1] == GateKind.build_test and gates[2] == GateKind.cross_review
    push = req.graph.node("push").config
    assert isinstance(push, GitNodeConfig)
    assert push.action == "push" and push.push_branch_template == "{{ input.push_branch }}"
    edges = {(e.source, e.target, e.condition) for e in req.graph.edges}
    assert ("build", "fix", "failed") in edges and ("review", "push", "passed") in edges
    failed = await env.events("pr.ci_failed")
    assert len(failed) == 1
    assert failed[0].severity == Severity.high and failed[0].payload["fix_task_id"] == "task_1"
    assert failed[0].payload["failing_checks"] == ["test"]
    info = await env.svc.watcher.get(env.repo.id, 7)
    assert info.active_task_id == "task_1" and info.fix_task_ids == ["task_1"]


async def test_next_failure_after_fix_and_recovery(env: Env) -> None:
    env.fake.set_pr(sha="sha1", checks=[failing()])
    await env.poll()
    env.engine.set_status("task_1", "completed")
    env.fake.set_pr(sha="sha2", checks=[failing()])  # the fix was pushed but CI still fails
    await env.poll()
    await env.poll()
    assert [r.source_ref["head_sha"] for r in env.engine.created if r.source_ref] == ["sha1", "sha2"]
    env.engine.set_status("task_2", "completed")
    env.fake.set_pr(sha="sha3", checks=[CheckRun(name="test", status="in_progress")])
    await env.poll()
    env.fake.set_pr(sha="sha3", checks=[passing()])
    await env.poll()
    passed = await env.events("pr.ci_passed")
    assert len(passed) == 1 and passed[0].payload["recovered"] is True
    assert len(env.engine.created) == 2


async def test_gives_up_after_max_attempts(env: Env) -> None:
    await env.ctx.store.set("git.autofix_max_attempts", 1)
    env.fake.set_pr(sha="sha1", checks=[failing()])
    await env.poll()
    env.engine.set_status("task_1", "completed")
    env.fake.set_pr(sha="sha2", checks=[failing()])
    await env.poll()
    await env.poll()
    assert len(env.engine.created) == 1
    gave_up = await env.events("pr.autofix_failed")
    assert len(gave_up) == 1
    assert gave_up[0].payload["reason"] == "max_attempts" and gave_up[0].severity == Severity.high


async def test_failed_fix_task_reports_autofix_failure(env: Env) -> None:
    env.fake.set_pr(sha="sha1", checks=[failing()])
    await env.poll()
    env.engine.set_status("task_1", "failed")
    await env.poll()
    events = await env.events("pr.autofix_failed")
    assert [e.payload["reason"] for e in events] == ["task_failed"]
    assert len(env.engine.created) == 1  # same sha: never retried automatically


async def test_ci_settle_waits_for_running_checks(env: Env) -> None:
    env.fake.set_pr(sha="sha1", checks=[failing(), CheckRun(name="e2e", status="in_progress")])
    await env.poll()
    assert env.engine.created == []
    env.clock.advance(301)  # git.ci_settle_seconds
    await env.poll()
    assert len(env.engine.created) == 1


async def test_review_comments_task_then_reply_and_resolve(env: Env) -> None:
    t0 = env.clock.now - timedelta(minutes=5)
    comments = [comment("101", "T1", t0), comment("102", "T1", t0 + timedelta(seconds=30), "Test de ekle.")]
    env.fake.set_pr(sha="sha1", checks=[passing()], comments=comments)
    await env.poll()
    await env.poll()
    assert len(env.engine.created) == 1
    req = env.engine.created[0]
    assert req.source_ref is not None and req.source_ref["kind"] == "review"
    assert [c["id"] for c in req.inputs["comments"]] == ["101", "102"]
    assert "yorum id: 101" in req.prompt and "pr_comment_reply" in req.prompt
    review = await env.events("pr.review")
    assert len(review) == 1 and review[0].payload["comments"] == 2 and review[0].payload["fix_task_id"] == "task_1"

    env.engine.set_status("task_1", "completed")
    env.fake.set_pr(sha="sha2", checks=[passing()], comments=comments)  # pushed
    await env.poll()
    assert env.fake.replies == [("101", "Bu geri bildirim sha2 commit'iyle ele alındı. (AI Studio)", "T1")]
    assert env.fake.resolved == ["T1"]
    # Our own reply showing up in an unresolved thread is never treated as new review input.
    own = comment("7001", "T1", env.clock.now, "Bu geri bildirim sha2 ...")
    env.fake.set_pr(sha="sha2", checks=[passing()], comments=[*comments, own])
    await env.poll()
    assert len(env.engine.created) == 1
    assert len(await env.events("pr.review")) == 1


async def test_review_settle_waits_for_comment_burst(env: Env) -> None:
    await env.ctx.store.set("git.review_settle_seconds", 60)
    env.fake.set_pr(sha="sha1", comments=[comment("201", "T9", env.clock.now)])
    await env.poll()
    assert env.engine.created == []
    assert len(await env.events("pr.review")) == 1  # the user is told right away
    env.clock.advance(61)
    await env.poll()
    assert len(env.engine.created) == 1


async def test_agent_reply_tool_skips_auto_reply(env: Env) -> None:
    t0 = env.clock.now - timedelta(minutes=5)
    comments = [comment("301", "TA", t0), comment("302", "TB", t0)]
    env.fake.set_pr(sha="sha1", comments=comments)
    await env.poll()
    tool = PrCommentReplyTool(env.ctx, env.svc)
    tctx = ToolContext(workspace_id=env.repo.workspace_id, session_id="s1", provider="claude", task_id="task_1")
    result = await tool(tctx, {"comment_id": "302", "body": "Bu davranış bilinçli; ayrıntı README'de."})
    assert not result.is_error and env.fake.replies[-1][0] == "302"
    env.engine.set_status("task_1", "completed")
    env.fake.set_pr(sha="sha2", comments=comments)
    await env.poll()
    auto = [r for r in env.fake.replies if "commit'iyle" in r[1]]
    assert [r[0] for r in auto] == ["301"]
    assert env.fake.resolved == ["TA"]  # the reasoned reply is left for the reviewer to resolve


async def test_conflict_task_once_per_head(env: Env) -> None:
    env.fake.set_pr(sha="sha1", conflicts=True)
    await env.poll()
    await env.poll()
    assert len(env.engine.created) == 1
    req = env.engine.created[0]
    assert req.source_ref is not None and req.source_ref["kind"] == "conflict"
    assert "git merge origin/main" in req.prompt and req.title == "PR #7: main ile çakışmayı çöz"
    assert len(await env.events("pr.conflict")) == 1


async def test_one_fix_task_at_a_time(env: Env) -> None:
    env.fake.set_pr(sha="sha1", checks=[failing()], comments=[comment("401", "T4", env.clock.now)])
    await env.poll()
    assert [r.source_ref["kind"] for r in env.engine.created if r.source_ref] == ["ci"]
    await env.poll()
    assert len(env.engine.created) == 1
    env.engine.set_status("task_1", "completed")
    env.fake.set_pr(sha="sha2", checks=[passing()], comments=[comment("401", "T4", env.clock.now)])
    await env.poll()
    assert [r.source_ref["kind"] for r in env.engine.created if r.source_ref] == ["ci", "review"]


async def test_fork_prs_are_not_autofixed(env: Env) -> None:
    env.fake.set_pr(sha="sha1", checks=[failing()], is_fork=True)
    await env.poll()
    assert env.engine.created == []
    events = await env.events("pr.ci_failed")
    assert events[0].payload["fix_task_id"] is None


async def test_stops_watching_when_merged(env: Env) -> None:
    env.fake.set_pr(sha="sha1", state="merged")
    await env.poll()
    merged = await env.events("pr.merged")
    assert len(merged) == 1 and merged[0].task_id == "task_origin"
    info = await env.svc.watcher.get(env.repo.id, 7)
    assert info.status == "stopped" and info.stop_reason == "merged"
    calls = env.fake.snapshot_calls
    await env.poll()
    assert env.fake.snapshot_calls == calls  # no more polling
    assert await env.svc.list_watches(active_only=True) == []


async def test_closed_and_unwatch(env: Env) -> None:
    await env.svc.unwatch(env.repo.id, 7)
    info = await env.svc.watcher.get(env.repo.id, 7)
    assert info.status == "stopped" and info.stop_reason == "user"
    await env.svc.watch(env.repo.id, 7, task_id=None)
    env.fake.set_pr(state="closed")
    await env.poll()
    assert len(await env.events("pr.closed")) == 1


async def test_rate_limit_reschedules_poll(env: Env) -> None:
    retry_at = env.clock.now + timedelta(minutes=3)
    env.fake.raise_on_snapshot = RateLimited("sınır", retry_at=retry_at)
    await env.poll()
    info = await env.svc.watcher.get(env.repo.id, 7)
    assert info.next_poll_at == retry_at and info.last_error is None


async def test_adaptive_interval(env: Env) -> None:
    env.fake.set_pr(sha="sha1", checks=[CheckRun(name="test", status="queued")])
    await env.poll()
    info = await env.svc.watcher.get(env.repo.id, 7)
    assert info.next_poll_at == env.clock.now + timedelta(seconds=45)
    env.fake.set_pr(sha="sha1", checks=[passing()], updated_at=env.clock.now - timedelta(hours=2))
    await env.poll()
    info = await env.svc.watcher.get(env.repo.id, 7)
    assert info.next_poll_at == env.clock.now + timedelta(seconds=300)


async def test_errors_are_recorded_once(env: Env) -> None:
    from aistudio.core.errors import Unavailable

    env.fake.raise_on_snapshot = Unavailable("GitHub şu anda yanıt vermiyor (HTTP 502).")
    await env.poll()
    await env.poll()
    errors = await env.events("pr.watch_error")
    assert len(errors) == 1
    info = await env.svc.watcher.get(env.repo.id, 7)
    assert info.last_error == "GitHub şu anda yanıt vermiyor (HTTP 502)."


async def test_background_loop_polls_new_watch(env: Env) -> None:
    env.fake.set_pr(sha="sha1", checks=[failing()])
    env.svc.watcher.tick_seconds = 0.01
    runner = asyncio.create_task(env.svc.watcher.run())
    try:
        for _ in range(200):
            if env.engine.created:
                break
            await asyncio.sleep(0.01)
    finally:
        runner.cancel()
        with pytest.raises(asyncio.CancelledError):
            await runner
    assert len(env.engine.created) == 1
