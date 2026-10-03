from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from gitfakes import GH_TOKEN, FakeClock, FakeEngine, make_repo

from aistudio.contracts.workspaces import Repo
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict, ValidationFailed
from aistudio.core.events import EventFilter
from aistudio.git_hosting.github import GitHubClient
from aistudio.git_hosting.http import RateLimited
from aistudio.git_hosting.logs import TRUNCATED_HEAD
from aistudio.git_hosting.models import GitAccountCreate, IssueTaskBody
from aistudio.git_hosting.service import GitHostingServiceImpl

API = "https://api.github.com"
REPO = f"{API}/repos/acme/widgets"


@pytest.fixture
def gh() -> Any:
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{API}/user").respond(
            200, json={"login": "octo", "name": "Octo Cat"}, headers={"x-oauth-scopes": "repo, read:user"}
        )
        yield mock


@pytest.fixture
async def repo(gh_ctx: AppContext, git_repo: Path) -> Repo:
    return await make_repo(gh_ctx, git_repo, "git@github.com:acme/widgets.git")


@pytest.fixture
async def account(hosting: GitHostingServiceImpl, gh: Any) -> Any:
    return await hosting.add_account(GitAccountCreate(kind="github", token=GH_TOKEN))


# --------------------------------------------------------------------------- accounts


async def test_add_account_validates_and_stores_token(
    hosting: GitHostingServiceImpl, gh_ctx: AppContext, gh: Any
) -> None:
    acc = await hosting.add_account(GitAccountCreate(kind="github", token=f"  {GH_TOKEN} "))
    assert acc.username == "octo"
    assert acc.api_url == API and acc.web_url == "https://github.com"
    assert acc.scopes == ["repo", "read:user"]
    assert acc.name == "octo@github.com"
    assert gh.calls.last.request.headers["authorization"] == f"Bearer {GH_TOKEN}"
    assert gh_ctx.secrets.get(f"git/{acc.id}/token") == GH_TOKEN
    assert [a.id for a in await hosting.list_accounts()] == [acc.id]
    with pytest.raises(Conflict, match="zaten ekli"):
        await hosting.add_account(GitAccountCreate(kind="github", token=GH_TOKEN))
    # The token never appears in the event log.
    events = await gh_ctx.events.query(EventFilter(types=["git.account_added"]))
    assert events and GH_TOKEN not in json.dumps([e.payload for e in events])


async def test_add_account_rejects_bad_token_in_turkish(hosting: GitHostingServiceImpl) -> None:
    with respx.mock() as mock:
        mock.get(f"{API}/user").respond(401, json={"message": "Bad credentials"})
        with pytest.raises(ValidationFailed, match="Belirteç geçersiz veya süresi dolmuş"):
            await hosting.add_account(GitAccountCreate(kind="github", token=GH_TOKEN))
    with respx.mock() as mock:
        mock.get("https://ghe.example.com/api/v3/user").mock(side_effect=httpx.ConnectError("boom"))
        with pytest.raises(ValidationFailed, match="sunucusuna ulaşılamadı"):
            await hosting.add_account(GitAccountCreate(kind="github", token=GH_TOKEN, api_url="ghe.example.com"))
    assert await hosting.list_accounts() == []


async def test_delete_account_removes_secret(hosting: GitHostingServiceImpl, gh_ctx: AppContext, account: Any) -> None:
    await hosting.delete_account(account.id)
    assert await hosting.list_accounts() == []
    assert gh_ctx.secrets.get(f"git/{account.id}/token") is None


async def test_repo_info_resolves_slug(hosting: GitHostingServiceImpl, repo: Repo, account: Any) -> None:
    info = await hosting.repo_info(repo.id)
    assert (info.kind, info.slug, info.account_id, info.web_url) == (
        "github",
        "acme/widgets",
        account.id,
        "https://github.com/acme/widgets",
    )


async def test_repo_without_account_has_turkish_error(hosting: GitHostingServiceImpl, repo: Repo) -> None:
    from aistudio.core.errors import NotFound

    with pytest.raises(NotFound, match=r"github\.com için bağlı bir GitHub/GitLab hesabı yok"):
        await hosting.repo_info(repo.id)


# --------------------------------------------------------------------------- pull requests


async def test_open_pr_fills_repo_template(
    hosting: GitHostingServiceImpl, gh_ctx: AppContext, repo: Repo, account: Any, gh: Any
) -> None:
    tpl = Path(repo.path) / ".github" / "PULL_REQUEST_TEMPLATE.md"
    tpl.parent.mkdir()
    tpl.write_text("## Özet\n<!-- Ne değişti? -->\n\n## Test planı\n- [ ] Birim testleri\n")
    route = gh.post(f"{REPO}/pulls").respond(
        201,
        json={
            "number": 42,
            "html_url": "https://github.com/acme/widgets/pull/42",
            "title": "Ödeme akışını düzelt",
            "head": {"ref": "aistudio/fix"},
            "base": {"ref": "main"},
            "draft": False,
        },
    )
    ref = await hosting.open_pull_request(
        repo.id, head="aistudio/fix", base="", title="Ödeme akışını düzelt", body="Para birimi yuvarlaması düzeltildi."
    )
    assert (ref.number, ref.base, ref.url) == (42, "main", "https://github.com/acme/widgets/pull/42")
    sent = json.loads(route.calls.last.request.content)
    assert sent["base"] == "main" and sent["head"] == "aistudio/fix" and sent["draft"] is False
    assert sent["body"].startswith("## Özet\n\nPara birimi yuvarlaması düzeltildi.")
    assert "<!-- Ne değişti? -->" not in sent["body"]
    assert "## Test planı\n- [ ] Birim testleri" in sent["body"]
    events = await gh_ctx.events.query(EventFilter(types=["pr.opened"]))
    assert events[-1].payload["number"] == 42 and events[-1].payload["template_used"] is True


async def test_open_pr_conflict_message(hosting: GitHostingServiceImpl, repo: Repo, account: Any, gh: Any) -> None:
    gh.post(f"{REPO}/pulls").respond(
        422,
        json={
            "message": "Validation Failed",
            "errors": [{"message": "A pull request already exists for acme:aistudio/fix."}],
        },
    )
    with pytest.raises(Conflict, match="zaten açık bir PR var"):
        await hosting.open_pull_request(repo.id, head="aistudio/fix", base="main", title="x", body="")


def _pr_json(**over: Any) -> dict[str, Any]:
    pr = {
        "number": 7,
        "html_url": "https://github.com/acme/widgets/pull/7",
        "title": "Yeni özellik",
        "state": "open",
        "merged": False,
        "draft": False,
        "mergeable": False,
        "mergeable_state": "dirty",
        "updated_at": "2026-10-03T08:00:00Z",
        "head": {"ref": "feature", "sha": "abc123", "repo": {"full_name": "acme/widgets"}},
        "base": {"ref": "main", "repo": {"full_name": "acme/widgets"}},
    }
    pr.update(over)
    return pr


def _mock_status_routes(gh: Any, *, etag: bool = False) -> dict[str, Any]:
    def with_etag(tag: str, payload: Any) -> Any:
        def handler(request: httpx.Request) -> httpx.Response:
            if etag and request.headers.get("if-none-match") == tag:
                return httpx.Response(304, headers={"etag": tag})
            return httpx.Response(200, json=payload, headers={"etag": tag} if etag else {})

        return handler

    routes = {
        "pr": gh.get(f"{REPO}/pulls/7").mock(side_effect=with_etag('"pr1"', _pr_json())),
        "checks": gh.get(f"{REPO}/commits/abc123/check-runs").mock(
            side_effect=with_etag(
                '"cr1"',
                {
                    "total_count": 3,
                    "check_runs": [
                        {
                            "id": 111,
                            "name": "test",
                            "status": "completed",
                            "conclusion": "failure",
                            "html_url": "https://github.com/acme/widgets/actions/runs/1/job/111",
                            "app": {"slug": "github-actions"},
                        },
                        {
                            "id": 222,
                            "name": "codecov",
                            "status": "completed",
                            "conclusion": "success",
                            "app": {"slug": "codecov"},
                        },
                        {"id": 333, "name": "lint", "status": "in_progress", "app": {"slug": "github-actions"}},
                    ],
                },
            )
        ),
        "status": gh.get(f"{REPO}/commits/abc123/status").mock(
            side_effect=with_etag(
                '"st1"',
                {
                    "state": "failure",
                    "statuses": [
                        {"context": "ci/circleci", "state": "error", "target_url": "https://circleci.example/1"},
                        {"context": "deploy/preview", "state": "pending"},
                    ],
                },
            )
        ),
        "graphql": gh.post(f"{API}/graphql").respond(
            200,
            json={
                "data": {
                    "repository": {
                        "pullRequest": {
                            "reviewDecision": "CHANGES_REQUESTED",
                            "reviewThreads": {
                                "nodes": [
                                    {
                                        "id": "T_resolved",
                                        "isResolved": True,
                                        "path": "a.py",
                                        "line": 1,
                                        "comments": {
                                            "nodes": [
                                                {
                                                    "databaseId": 1,
                                                    "body": "eski",
                                                    "createdAt": "2026-10-01T10:00:00Z",
                                                    "author": {"login": "rev"},
                                                }
                                            ]
                                        },
                                    },
                                    {
                                        "id": "T_open",
                                        "isResolved": False,
                                        "path": "pay.py",
                                        "line": 12,
                                        "comments": {
                                            "nodes": [
                                                {
                                                    "databaseId": 101,
                                                    "author": {"login": "rev"},
                                                    "body": "Burada yuvarlama hatası var.",
                                                    "createdAt": "2026-10-03T07:00:00Z",
                                                    "path": "pay.py",
                                                    "line": 12,
                                                },
                                                {
                                                    "databaseId": 102,
                                                    "author": {"login": "rev"},
                                                    "body": "Bir de test ekle.",
                                                    "createdAt": "2026-10-03T07:05:00Z",
                                                    "path": "pay.py",
                                                    "line": 12,
                                                },
                                            ]
                                        },
                                    },
                                ]
                            },
                            "latestReviews": {
                                "nodes": [
                                    {
                                        "databaseId": 900,
                                        "author": {"login": "rev"},
                                        "body": "Genel olarak iyi ama testler eksik.",
                                        "state": "CHANGES_REQUESTED",
                                        "submittedAt": "2026-10-03T07:06:00Z",
                                    },
                                    {"databaseId": 901, "author": {"login": "x"}, "body": "", "state": "COMMENTED"},
                                ]
                            },
                        }
                    }
                }
            },
        ),
    }
    return routes


async def test_pr_status_aggregates_checks_reviews_and_conflicts(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gh: Any
) -> None:
    _mock_status_routes(gh)
    st = await hosting.pr_status(repo.id, 7)
    assert st.state == "open" and st.head_sha == "abc123"
    assert st.has_conflicts is True and st.mergeable is False
    assert st.ref.head == "feature" and st.ref.base == "main" and st.ref.repo_id == repo.id
    by_name = {c.name: c for c in st.checks}
    assert by_name["test"].conclusion == "failure" and by_name["test"].job_id == "111"
    assert by_name["codecov"].job_id is None
    assert by_name["lint"].status == "in_progress" and by_name["lint"].conclusion is None
    assert by_name["ci/circleci"].conclusion == "failure"
    assert by_name["deploy/preview"].status == "in_progress"
    assert st.review_decision == "changes_requested"
    ids = [(c.id, c.thread_id) for c in st.unresolved_comments]
    assert ids == [("101", "T_open"), ("102", "T_open"), ("review:900", None)]
    assert st.unresolved_comments[0].path == "pay.py" and st.unresolved_comments[0].line == 12


async def test_etag_revalidation_returns_cached_status(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gh: Any
) -> None:
    routes = _mock_status_routes(gh, etag=True)
    first = await hosting.pr_status(repo.id, 7)
    second = await hosting.pr_status(repo.id, 7)
    assert second == first
    assert routes["pr"].calls.last.request.headers["if-none-match"] == '"pr1"'
    assert routes["checks"].calls.last.request.headers["if-none-match"] == '"cr1"'
    assert routes["status"].calls.last.request.headers["if-none-match"] == '"st1"'
    # PR unchanged (304) -> review threads are not re-read through GraphQL.
    assert routes["graphql"].call_count == 1
    client = (await hosting.resolve(repo.id)).client
    assert isinstance(client, GitHubClient) and client.api.not_modified == 3


async def test_job_log_follows_redirect_strips_and_masks(
    hosting: GitHostingServiceImpl, gh_ctx: AppContext, repo: Repo, account: Any, gh: Any
) -> None:
    leaked = "-".join(["deploy", "key", "zz", "998877"])
    gh_ctx.masker.add_secret(leaked)
    body = "\n".join(
        [f"2026-10-03T08:00:{i:02d}.1234567Z step {i}" for i in range(50)]
        + [
            "2026-10-03T08:01:00.0000000Z \x1b[31mFAILED\x1b[0m tests/test_pay.py::test_round",
            f"2026-10-03T08:01:01.0000000Z using {leaked}",
        ]
    )
    gh.get(f"{REPO}/actions/jobs/111/logs").respond(302, headers={"location": "https://logs.example.net/job/111"})
    blob = gh.get("https://logs.example.net/job/111").respond(200, text=body)
    text = await hosting.job_log(repo.id, "111", max_chars=200)
    assert text.startswith(TRUNCATED_HEAD)
    assert "FAILED tests/test_pay.py::test_round" in text
    assert "\x1b[" not in text and "2026-10-03T08" not in text
    assert leaked not in text and "[gizli]" in text
    assert len(text) <= 200
    # The token is not forwarded to the log storage host.
    assert "authorization" not in blob.calls.last.request.headers


async def test_reply_and_resolve_thread(hosting: GitHostingServiceImpl, repo: Repo, account: Any, gh: Any) -> None:
    reply = gh.post(f"{REPO}/pulls/7/comments/101/replies").respond(201, json={"id": 555})
    conv = gh.post(f"{REPO}/issues/7/comments").respond(201, json={"id": 556})
    gql = gh.post(f"{API}/graphql").respond(
        200, json={"data": {"resolveReviewThread": {"thread": {"id": "T_open", "isResolved": True}}}}
    )
    assert await hosting.reply_to_comment(repo.id, 7, "101", "Düzeltildi.") == "555"
    assert json.loads(reply.calls.last.request.content) == {"body": "Düzeltildi."}
    assert await hosting.reply_to_comment(repo.id, 7, "review:900", "Testleri ekledim.") == "556"
    assert conv.called
    await hosting.resolve_thread(repo.id, 7, "T_open")
    assert json.loads(gql.calls.last.request.content)["variables"] == {"id": "T_open"}


# --------------------------------------------------------------------------- actions


async def test_workflow_dispatch_and_run_status(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gh: Any, clock: FakeClock
) -> None:
    dispatch = gh.post(f"{REPO}/actions/workflows/deploy.yml/dispatches").respond(204)
    gh.get(f"{REPO}/actions/workflows/deploy.yml/runs").respond(
        200, json={"workflow_runs": [{"id": 999, "created_at": clock.now.isoformat()}]}
    )
    gh.get(f"{REPO}/actions/runs/999").respond(
        200,
        json={"id": 999, "name": "Deploy", "status": "completed", "conclusion": "success", "html_url": "https://x/999"},
    )
    run_id = await hosting.trigger_pipeline(repo.id, ref="main", workflow="deploy.yml", variables={"env": "test"})
    assert run_id == "999"
    assert json.loads(dispatch.calls.last.request.content) == {"ref": "main", "inputs": {"env": "test"}}
    status = await hosting.pipeline_status(repo.id, run_id)
    assert (status.name, status.status, status.conclusion) == ("Deploy", "completed", "success")
    with pytest.raises(ValidationFailed, match="workflow dosyası"):
        await hosting.trigger_pipeline(repo.id, ref="main")


async def test_workflow_dispatch_pending_run_id(gh_ctx: AppContext, git_repo: Path, gh: Any, clock: FakeClock) -> None:
    def factory(kind: Any, api_url: str, token: str) -> GitHubClient:
        return GitHubClient(api_url=api_url, token=token, masker=gh_ctx.masker, clock=clock, dispatch_lookup_attempts=1)

    svc = GitHostingServiceImpl(gh_ctx, client_factory=factory, clock=clock)
    repo = await make_repo(gh_ctx, git_repo, "https://github.com/acme/widgets.git")
    await svc.add_account(GitAccountCreate(kind="github", token=GH_TOKEN))
    gh.post(f"{REPO}/actions/workflows/deploy.yml/dispatches").respond(204)
    gh.get(f"{REPO}/actions/workflows/deploy.yml/runs").respond(200, json={"workflow_runs": []})
    run_id = await svc.trigger_pipeline(repo.id, ref="main", workflow="deploy.yml")
    assert run_id.startswith("pending:deploy.yml:main:")
    status = await svc.pipeline_status(repo.id, run_id)
    assert status.status == "queued"
    await svc.aclose()


# --------------------------------------------------------------------------- issues


async def test_issues_list_and_issue_to_task(
    hosting: GitHostingServiceImpl, gh_ctx: AppContext, repo: Repo, account: Any, gh: Any, engine: FakeEngine
) -> None:
    issue = {
        "number": 12,
        "title": "Fatura PDF'i bozuk",
        "body": "Türkçe karakterler PDF'te görünmüyor.",
        "state": "open",
        "html_url": "https://github.com/acme/widgets/issues/12",
        "user": {"login": "musteri"},
        "labels": [{"name": "bug"}],
        "comments": 3,
    }
    gh.get(f"{REPO}/issues").respond(
        200, json=[issue, {"number": 13, "title": "PR", "html_url": "x", "pull_request": {}}]
    )
    gh.get(f"{REPO}/issues/12").respond(200, json=issue)
    issues = await hosting.list_issues(repo.id)
    assert [(i.number, i.labels, i.author) for i in issues] == [(12, ["bug"], "musteri")]
    task = await hosting.issue_to_task(repo.id, 12, IssueTaskBody(start=False))
    req = engine.created[-1]
    assert task.source == "issue" and req.source == "issue"
    assert req.source_ref == {"repo_id": repo.id, "issue": 12, "url": issue["html_url"]}
    assert req.title == "#12 Fatura PDF'i bozuk" and req.repo_ids == [repo.id] and req.start is False
    assert "Türkçe karakterler PDF'te görünmüyor." in req.prompt and "Etiketler: bug" in req.prompt
    events = await gh_ctx.events.query(EventFilter(types=["git.issue_task_created"]))
    assert events[-1].task_id == task.id


# --------------------------------------------------------------------------- rate limits


async def test_secondary_rate_limit_backs_off_without_calling_api(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gh: Any, clock: FakeClock
) -> None:
    route = gh.get(f"{REPO}/pulls").respond(
        403, json={"message": "You have exceeded a secondary rate limit."}, headers={"retry-after": "60"}
    )
    with pytest.raises(RateLimited) as info:
        await hosting.list_pulls(repo.id)
    assert "istek sınırına ulaşıldı" in info.value.message
    assert info.value.retry_at == clock.now + timedelta(seconds=60)
    with pytest.raises(RateLimited):
        await hosting.list_pulls(repo.id)
    assert route.call_count == 1  # fail fast during the backoff window
    clock.advance(61)
    route.respond(200, json=[])
    assert await hosting.list_pulls(repo.id) == []


async def test_primary_rate_limit_exhaustion_blocks_until_reset(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gh: Any, clock: FakeClock
) -> None:
    reset = int(clock.now.timestamp()) + 120
    gh.get(f"{REPO}/pulls").respond(
        200, json=[], headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": str(reset)}
    )
    assert await hosting.list_pulls(repo.id) == []
    with pytest.raises(RateLimited):
        await hosting.list_pulls(repo.id)
