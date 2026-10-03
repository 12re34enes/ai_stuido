from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import respx
from gitfakes import GL_TOKEN, make_repo

from aistudio.contracts.workspaces import Repo
from aistudio.core.context import AppContext
from aistudio.core.errors import Conflict
from aistudio.git_hosting.models import GitAccountCreate
from aistudio.git_hosting.service import GitHostingServiceImpl

API = "https://code.example.com/gitlab/api/v4"
PROJECT = f"{API}/projects/platform%2Fpayments%2Fapi"


@pytest.fixture
def gl() -> Any:
    with respx.mock(assert_all_called=False) as mock:
        mock.get(f"{API}/user").respond(200, json={"username": "deniz", "name": "Deniz"})
        mock.get(f"{API}/personal_access_tokens/self").respond(200, json={"scopes": ["api"]})
        yield mock


@pytest.fixture
async def repo(gh_ctx: AppContext, git_repo: Path) -> Repo:
    # SSH remote on a custom port; the server lives under a relative URL root (/gitlab).
    return await make_repo(gh_ctx, git_repo, "ssh://git@code.example.com:2222/platform/payments/api.git")


@pytest.fixture
async def account(hosting: GitHostingServiceImpl, gl: Any) -> Any:
    return await hosting.add_account(
        GitAccountCreate(kind="gitlab", token=GL_TOKEN, api_url="https://code.example.com/gitlab")
    )


async def test_account_and_nested_group_resolution(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gl: Any
) -> None:
    assert account.api_url == API and account.scopes == ["api"]
    assert gl.calls[0].request.headers["private-token"] == GL_TOKEN
    info = await hosting.repo_info(repo.id)
    assert (info.kind, info.slug, info.web_url) == (
        "gitlab",
        "platform/payments/api",
        "https://code.example.com/gitlab/platform/payments/api",
    )


async def test_open_mr_uses_default_template_and_draft(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gl: Any
) -> None:
    tpl_dir = Path(repo.path) / ".gitlab" / "merge_request_templates"
    tpl_dir.mkdir(parents=True)
    (tpl_dir / "Bug.md").write_text("## Hata\n")
    (tpl_dir / "Default.md").write_text("## Açıklama\n\n## Kontrol listesi\n- [ ] Changelog\n")
    route = gl.post(f"{PROJECT}/merge_requests").respond(
        201,
        json={
            "iid": 5,
            "web_url": "https://code.example.com/gitlab/platform/payments/api/-/merge_requests/5",
            "title": "Draft: Kur farkı",
            "source_branch": "aistudio/kur",
            "target_branch": "develop",
            "draft": True,
        },
    )
    ref = await hosting.open_pull_request(
        repo.id, head="aistudio/kur", base="develop", title="Kur farkı", body="Kur farkı hesaplaması.", draft=True
    )
    assert ref.number == 5 and ref.draft is True and ref.base == "develop"
    sent = json.loads(route.calls.last.request.content)
    assert sent["title"] == "Draft: Kur farkı"
    assert sent["source_branch"] == "aistudio/kur" and sent["target_branch"] == "develop"
    assert sent["description"].startswith("## Açıklama\n\nKur farkı hesaplaması.")
    assert "## Kontrol listesi" in sent["description"]
    assert route.calls.last.request.url.raw_path.startswith(b"/gitlab/api/v4/projects/platform%2Fpayments%2Fapi/")


async def test_open_mr_already_exists(hosting: GitHostingServiceImpl, repo: Repo, account: Any, gl: Any) -> None:
    gl.post(f"{PROJECT}/merge_requests").respond(
        409, json={"message": ["Another open merge request already exists for this source branch: !4"]}
    )
    with pytest.raises(Conflict, match="zaten açık bir MR var"):
        await hosting.open_pull_request(repo.id, head="x", base="main", title="t", body="")


async def test_mr_status_jobs_discussions_and_reviews(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gl: Any
) -> None:
    gl.get(f"{PROJECT}/merge_requests/5").respond(
        200,
        json={
            "iid": 5,
            "title": "Kur farkı",
            "state": "opened",
            "sha": "def456",
            "source_branch": "aistudio/kur",
            "target_branch": "develop",
            "web_url": "https://code.example.com/gitlab/platform/payments/api/-/merge_requests/5",
            "has_conflicts": True,
            "detailed_merge_status": "conflict",
            "head_pipeline": {"id": 77, "status": "failed"},
            "source_project_id": 1,
            "target_project_id": 1,
            "updated_at": "2026-10-03T08:00:00Z",
        },
    )
    gl.get(f"{PROJECT}/pipelines/77/jobs").respond(
        200,
        json=[
            {"id": 501, "name": "pytest", "stage": "test", "status": "failed", "web_url": "https://j/501"},
            {"id": 502, "name": "lint", "stage": "test", "status": "success"},
            {"id": 503, "name": "flaky", "stage": "test", "status": "failed", "allow_failure": True},
            {"id": 504, "name": "deploy", "stage": "deploy", "status": "manual"},
            {"id": 505, "name": "build", "stage": "build", "status": "running"},
        ],
    )
    gl.get(f"{PROJECT}/merge_requests/5/discussions").respond(
        200,
        json=[
            {
                "id": "d1",
                "notes": [
                    {
                        "id": 9001,
                        "body": "Burada float kullanma.",
                        "author": {"username": "ayse"},
                        "created_at": "2026-10-03T07:00:00Z",
                        "resolvable": True,
                        "resolved": False,
                        "position": {"new_path": "kur.py", "new_line": 40},
                    },
                    {
                        "id": 9002,
                        "body": "Decimal öneririm.",
                        "author": {"username": "ayse"},
                        "created_at": "2026-10-03T07:01:00Z",
                        "resolvable": True,
                        "resolved": False,
                    },
                ],
            },
            {"id": "d2", "notes": [{"id": 9100, "body": "ok", "resolvable": True, "resolved": True}]},
            {"id": "d3", "notes": [{"id": 9200, "body": "added 1 commit", "system": True}]},
        ],
    )
    gl.get(f"{PROJECT}/merge_requests/5/approvals").respond(200, json={"approved": False, "approvals_left": 1})
    gl.get(f"{PROJECT}/merge_requests/5/reviewers").respond(
        200, json=[{"user": {"username": "ayse"}, "state": "requested_changes"}]
    )
    st = await hosting.pr_status(repo.id, 5)
    assert st.state == "open" and st.head_sha == "def456" and st.has_conflicts is True and st.mergeable is False
    checks = {c.name: c for c in st.checks}
    assert checks["test: pytest"].conclusion == "failure" and checks["test: pytest"].job_id == "501"
    assert checks["test: flaky"].conclusion == "neutral"  # allow_failure never counts as a CI failure
    assert checks["deploy: deploy"].conclusion == "skipped"  # manual jobs do not block
    assert checks["build: build"].status == "in_progress"
    assert [(c.id, c.thread_id, c.path) for c in st.unresolved_comments] == [
        ("9001", "d1", "kur.py"),
        ("9002", "d1", None),
    ]
    assert st.review_decision == "changes_requested"


async def test_job_trace_is_cleaned(hosting: GitHostingServiceImpl, repo: Repo, account: Any, gl: Any) -> None:
    trace = (
        "section_start:1700000000:step_script\r\x1b[0K\x1b[32;1m$ pytest\x1b[0;m\n"
        "progress 10%\rprogress 100%\n"
        "E   AssertionError: 3 != 4\n"
        "section_end:1700000001:step_script\r\x1b[0K"
    )
    gl.get(f"{PROJECT}/jobs/501/trace").respond(200, text=trace)
    text = await hosting.job_log(repo.id, "501")
    assert text == "$ pytest\nprogress 100%\nE   AssertionError: 3 != 4"


async def test_pipeline_trigger_with_variables_and_status(
    hosting: GitHostingServiceImpl, repo: Repo, account: Any, gl: Any
) -> None:
    trigger = gl.post(f"{PROJECT}/pipeline").respond(201, json={"id": 880, "status": "created"})
    gl.get(f"{PROJECT}/pipelines/880").respond(200, json={"id": 880, "status": "running", "web_url": "https://p/880"})
    run_id = await hosting.trigger_pipeline(repo.id, ref="refs/heads/main", variables={"DEPLOY_ENV": "test"})
    assert run_id == "880"
    assert json.loads(trigger.calls.last.request.content) == {
        "ref": "main",
        "variables": [{"key": "DEPLOY_ENV", "value": "test", "variable_type": "env_var"}],
    }
    status = await hosting.pipeline_status(repo.id, run_id)
    assert (status.name, status.status, status.conclusion, status.url) == (
        "Pipeline #880",
        "in_progress",
        None,
        "https://p/880",
    )


async def test_issues_reply_and_resolve(hosting: GitHostingServiceImpl, repo: Repo, account: Any, gl: Any) -> None:
    gl.get(f"{PROJECT}/issues").respond(
        200,
        json=[
            {
                "iid": 3,
                "title": "Kur servisi yavaş",
                "description": "p95 2 sn",
                "state": "opened",
                "web_url": "https://i/3",
                "author": {"username": "ali"},
                "labels": ["performans"],
                "user_notes_count": 2,
            }
        ],
    )
    issues = await hosting.list_issues(repo.id)
    assert [(i.number, i.state, i.labels, i.comments) for i in issues] == [(3, "open", ["performans"], 2)]

    gl.get(f"{PROJECT}/merge_requests/5/discussions").respond(
        200, json=[{"id": "d1", "notes": [{"id": 9001}, {"id": 9002}]}]
    )
    note = gl.post(f"{PROJECT}/merge_requests/5/discussions/d1/notes").respond(201, json={"id": 9300})
    resolve = gl.put(f"{PROJECT}/merge_requests/5/discussions/d1").respond(200, json={"id": "d1"})
    assert await hosting.reply_to_comment(repo.id, 5, "9002", "Decimal'e geçtim.") == "9300"
    assert json.loads(note.calls.last.request.content) == {"body": "Decimal'e geçtim."}
    await hosting.resolve_thread(repo.id, 5, "d1")
    assert resolve.calls.last.request.url.params["resolved"] == "true"
