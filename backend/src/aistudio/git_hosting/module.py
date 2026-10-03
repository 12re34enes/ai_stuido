"""GitHub / GitLab integration module (spec §13).

API (mounted under ``/api/git``)::

    GET    /accounts                                   list accounts
    POST   /accounts                                   add (token validated via the user endpoint)
    POST   /accounts/{id}/verify                       re-validate the token
    DELETE /accounts/{id}
    GET    /accounts/{id}/repos                        repos the account can access
    GET    /watches                                    PR takibi list
    GET    /repos/{repo_id}                            resolved account + slug
    PUT    /repos/{repo_id}/account                    pin an account ({"account_id": null} = auto)
    GET    /repos/{repo_id}/pulls                      open PRs/MRs
    POST   /repos/{repo_id}/pulls                      open a PR/MR (repo template applied)
    GET    /repos/{repo_id}/pulls/{n}                  PR status (checks, reviews, conflicts)
    GET    /repos/{repo_id}/pulls/{n}/watch            watch state
    POST   /repos/{repo_id}/pulls/{n}/watch            start watching   {"autofix": true, "task_id": ...}
    DELETE /repos/{repo_id}/pulls/{n}/watch            stop watching
    POST   /repos/{repo_id}/pulls/{n}/watch/poll       poll now
    POST   /repos/{repo_id}/pulls/{n}/comments/{cid}/reply
    POST   /repos/{repo_id}/pulls/{n}/threads/{tid}/resolve
    GET    /repos/{repo_id}/jobs/{job_id}/log          tail-truncated, masked job log
    GET    /repos/{repo_id}/issues                     open issues
    POST   /repos/{repo_id}/issues/{n}/task            issue -> task
    POST   /repos/{repo_id}/pipelines                  workflow_dispatch / GitLab pipeline
    GET    /repos/{repo_id}/pipelines/{run_id}         pipeline status
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Response

from aistudio.contracts.engine import Task
from aistudio.contracts.git_hosting import CheckRun, GitHostingService, PullRequestRef, PullRequestStatus
from aistudio.contracts.tools import ToolRegistry
from aistudio.core.context import AppContext
from aistudio.core.module import Module
from aistudio.git_hosting import tables as _tables  # noqa: F401  (registers tables)
from aistudio.git_hosting.models import (
    GitAccount,
    GitAccountCreate,
    Issue,
    IssueTaskBody,
    JobLog,
    OpenPullRequestBody,
    PinAccountBody,
    PipelineRunRef,
    PullRequestSummary,
    RemoteRepo,
    ReplyBody,
    RepoHostingInfo,
    TriggerPipelineBody,
    WatchBody,
    WatchInfo,
)
from aistudio.git_hosting.service import SETTINGS_DEFAULTS, GitHostingServiceImpl
from aistudio.git_hosting.tools import PrCommentReplyTool

log = logging.getLogger(__name__)


class GitHostingModule(Module):
    name = "git_hosting"

    def __init__(self) -> None:
        self.svc: GitHostingServiceImpl | None = None

    async def setup(self, ctx: AppContext) -> None:
        for key, value in SETTINGS_DEFAULTS.items():
            ctx.store.declare(key, value)
        self.svc = GitHostingServiceImpl(ctx)
        ctx.services.register(GitHostingService, self.svc)  # type: ignore[type-abstract]
        ctx.services.register(GitHostingServiceImpl, self.svc)
        registry = ctx.services.maybe(ToolRegistry)  # type: ignore[type-abstract]
        if registry is not None:
            registry.register(PrCommentReplyTool(ctx, self.svc))

    async def start(self, ctx: AppContext) -> None:
        assert self.svc is not None
        ctx.spawn(self.svc.watcher.run(), name="git_hosting.pr_watcher")

    async def stop(self) -> None:
        if self.svc is not None:
            await self.svc.aclose()

    def router(self) -> APIRouter:
        r = APIRouter(prefix="/git", tags=["git"])

        def svc() -> GitHostingServiceImpl:
            assert self.svc is not None
            return self.svc

        # ---------------------------------------------------------------- accounts
        @r.get("/accounts", response_model=list[GitAccount])
        async def list_accounts() -> list[GitAccount]:
            return await svc().list_accounts()

        @r.post("/accounts", response_model=GitAccount, status_code=201)
        async def add_account(body: GitAccountCreate) -> GitAccount:
            return await svc().add_account(body)

        @r.post("/accounts/{account_id}/verify", response_model=GitAccount)
        async def verify_account(account_id: str) -> GitAccount:
            return await svc().verify_account(account_id)

        @r.delete("/accounts/{account_id}", status_code=204)
        async def delete_account(account_id: str) -> Response:
            await svc().delete_account(account_id)
            return Response(status_code=204)

        @r.get("/accounts/{account_id}/repos", response_model=list[RemoteRepo])
        async def account_repos(account_id: str, limit: int = 200) -> list[RemoteRepo]:
            return await svc().account_repos(account_id, limit=max(1, min(limit, 1000)))

        @r.get("/watches", response_model=list[WatchInfo])
        async def list_watches(active_only: bool = False) -> list[WatchInfo]:
            return await svc().list_watches(active_only=active_only)

        # ---------------------------------------------------------------- repos
        @r.get("/repos/{repo_id}", response_model=RepoHostingInfo)
        async def repo_info(repo_id: str) -> RepoHostingInfo:
            return await svc().repo_info(repo_id)

        @r.put("/repos/{repo_id}/account", response_model=RepoHostingInfo)
        async def pin_account(repo_id: str, body: PinAccountBody) -> RepoHostingInfo:
            return await svc().pin_account(repo_id, body.account_id)

        @r.get("/repos/{repo_id}/pulls", response_model=list[PullRequestSummary])
        async def list_pulls(repo_id: str, limit: int = 50) -> list[PullRequestSummary]:
            return await svc().list_pulls(repo_id, limit=max(1, min(limit, 100)))

        @r.post("/repos/{repo_id}/pulls", response_model=PullRequestRef, status_code=201)
        async def open_pull(repo_id: str, body: OpenPullRequestBody) -> PullRequestRef:
            return await svc().open_pull_request(
                repo_id, head=body.head, base=body.base or "", title=body.title, body=body.body, draft=body.draft
            )

        @r.get("/repos/{repo_id}/pulls/{number}", response_model=PullRequestStatus)
        async def pull_status(repo_id: str, number: int) -> PullRequestStatus:
            return await svc().pr_status(repo_id, number)

        @r.get("/repos/{repo_id}/pulls/{number}/watch", response_model=WatchInfo)
        async def get_watch(repo_id: str, number: int) -> WatchInfo:
            return await svc().watcher.get(repo_id, number)

        @r.post("/repos/{repo_id}/pulls/{number}/watch", response_model=WatchInfo)
        async def watch(repo_id: str, number: int, body: WatchBody | None = None) -> WatchInfo:
            b = body or WatchBody()
            return await svc().watcher.watch(repo_id, number, task_id=b.task_id, autofix=b.autofix)

        @r.delete("/repos/{repo_id}/pulls/{number}/watch", status_code=204)
        async def unwatch(repo_id: str, number: int) -> Response:
            await svc().unwatch(repo_id, number)
            return Response(status_code=204)

        @r.post("/repos/{repo_id}/pulls/{number}/watch/poll", response_model=WatchInfo)
        async def poll_now(repo_id: str, number: int) -> WatchInfo:
            info = await svc().watcher.get(repo_id, number)
            await svc().watcher.poll(info.id)
            return await svc().watcher.get(repo_id, number)

        @r.post("/repos/{repo_id}/pulls/{number}/comments/{comment_id}/reply")
        async def reply(repo_id: str, number: int, comment_id: str, body: ReplyBody) -> dict[str, str]:
            created = await svc().reply_to_comment(repo_id, number, comment_id, body.body)
            return {"id": created}

        @r.post("/repos/{repo_id}/pulls/{number}/threads/{thread_id}/resolve", status_code=204)
        async def resolve_thread(repo_id: str, number: int, thread_id: str) -> Response:
            await svc().resolve_thread(repo_id, number, thread_id)
            return Response(status_code=204)

        @r.get("/repos/{repo_id}/jobs/{job_id}/log", response_model=JobLog)
        async def job_log(repo_id: str, job_id: str, max_chars: int | None = None) -> JobLog:
            return JobLog(job_id=job_id, log=await svc().job_log(repo_id, job_id, max_chars=max_chars))

        # ---------------------------------------------------------------- issues
        @r.get("/repos/{repo_id}/issues", response_model=list[Issue])
        async def list_issues(repo_id: str, limit: int = 50) -> list[Issue]:
            return await svc().list_issues(repo_id, limit=max(1, min(limit, 200)))

        @r.post("/repos/{repo_id}/issues/{number}/task", response_model=Task, status_code=201)
        async def issue_task(repo_id: str, number: int, body: IssueTaskBody | None = None) -> Task:
            return await svc().issue_to_task(repo_id, number, body)

        # ---------------------------------------------------------------- pipelines
        @r.post("/repos/{repo_id}/pipelines", response_model=PipelineRunRef, status_code=201)
        async def trigger(repo_id: str, body: TriggerPipelineBody) -> PipelineRunRef:
            run_id = await svc().trigger_pipeline(
                repo_id, ref=body.ref, workflow=body.workflow, variables=body.variables
            )
            return PipelineRunRef(run_id=run_id)

        @r.get("/repos/{repo_id}/pipelines/{run_id:path}", response_model=CheckRun)
        async def pipeline_status(repo_id: str, run_id: str) -> CheckRun:
            return await svc().pipeline_status(repo_id, run_id)

        return r


module = GitHostingModule()
