"""HTTP API under ``/api/gitops``."""

from __future__ import annotations

from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, Field

from aistudio.contracts.gitops import Checkpoint, DiffResult, FileOverlap, MergePreview, MergeResult, Worktree
from aistudio.core.errors import Unavailable
from aistudio.gitops.service import CleanupReport, PairCheck, RepoBranches, WorktreeManagerImpl

WorktreeStatusFilter = Literal["active", "merged", "abandoned", "removed"]


class CreateWorktreeBody(BaseModel):
    repo_id: str
    base_ref: str | None = None
    task_id: str | None = None
    run_id: str | None = None
    label: str = "agent"


class CommitBody(BaseModel):
    message: str = Field(min_length=1)


class CommitResult(BaseModel):
    sha: str | None


class MergeBody(BaseModel):
    target_ref: str | None = None
    strategy: Literal["merge", "squash", "cherry_pick"] = "merge"
    message: str | None = None


class PushBody(BaseModel):
    remote: str = "origin"
    remote_branch: str | None = None


class CheckpointBody(BaseModel):
    run_id: str | None = None
    node_id: str | None = None
    label: str = Field(min_length=1)
    worktree_ids: list[str] = Field(min_length=1)
    workspace_id: str | None = None


def build_router(get_manager: Callable[[], WorktreeManagerImpl | None]) -> APIRouter:
    r = APIRouter(prefix="/gitops", tags=["gitops"])

    def mgr() -> WorktreeManagerImpl:
        m = get_manager()
        if m is None:
            raise Unavailable("Git servisi hazır değil.")
        return m

    # ------------------------------------------------------------------ worktrees
    @r.get("/worktrees", response_model=list[Worktree])
    async def list_worktrees(
        run_id: str | None = None,
        task_id: str | None = None,
        repo_id: str | None = None,
        workspace_id: str | None = None,
        status: list[WorktreeStatusFilter] | None = Query(default=None),  # noqa: B008
        active_only: bool = False,
        limit: int = 500,
    ) -> list[Worktree]:
        statuses: list[str] | None = ["active"] if active_only else (list(status) if status else None)
        return await mgr().query(
            run_id=run_id,
            task_id=task_id,
            repo_id=repo_id,
            workspace_id=workspace_id,
            statuses=statuses,
            limit=max(1, min(limit, 2000)),
        )

    @r.post("/worktrees", response_model=Worktree, status_code=201)
    async def create_worktree(body: CreateWorktreeBody) -> Worktree:
        return await mgr().create(
            body.repo_id, base_ref=body.base_ref, task_id=body.task_id, run_id=body.run_id, label=body.label
        )

    @r.get("/worktrees/{worktree_id}", response_model=Worktree)
    async def get_worktree(worktree_id: str) -> Worktree:
        return await mgr().get(worktree_id)

    @r.get("/worktrees/{worktree_id}/diff", response_model=DiffResult)
    async def worktree_diff(worktree_id: str, include_patch: bool = True) -> DiffResult:
        return await mgr().diff(worktree_id, include_patch=include_patch)

    @r.get("/worktrees/{worktree_id}/changed-files", response_model=list[str])
    async def worktree_changed_files(worktree_id: str) -> list[str]:
        return await mgr().changed_files(worktree_id)

    @r.post("/worktrees/{worktree_id}/commit", response_model=CommitResult)
    async def commit_worktree(worktree_id: str, body: CommitBody) -> CommitResult:
        return CommitResult(sha=await mgr().commit_all(worktree_id, body.message))

    @r.get("/worktrees/{worktree_id}/merge-preview", response_model=MergePreview)
    async def merge_preview(worktree_id: str, target_ref: str | None = None) -> MergePreview:
        return await mgr().merge_preview(worktree_id, target_ref)

    @r.post("/worktrees/{worktree_id}/merge", response_model=MergeResult)
    async def merge_worktree(worktree_id: str, body: MergeBody) -> MergeResult:
        return await mgr().merge(worktree_id, target_ref=body.target_ref, strategy=body.strategy, message=body.message)

    @r.post("/worktrees/{worktree_id}/push", status_code=204)
    async def push_worktree(worktree_id: str, body: PushBody) -> Response:
        await mgr().push(worktree_id, remote=body.remote, remote_branch=body.remote_branch)
        return Response(status_code=204)

    @r.post("/worktrees/{worktree_id}/abandon", response_model=Worktree)
    async def abandon_worktree(worktree_id: str) -> Worktree:
        return await mgr().abandon(worktree_id)

    @r.delete("/worktrees/{worktree_id}", status_code=204)
    async def remove_worktree(worktree_id: str, force: bool = False, delete_branch: bool | None = None) -> Response:
        await mgr().remove(worktree_id, force=force, delete_branch=delete_branch)
        return Response(status_code=204)

    # ------------------------------------------------------------------ conflicts
    @r.get("/overlaps", response_model=list[FileOverlap])
    async def list_overlaps(repo_id: str | None = None) -> list[FileOverlap]:
        items = await mgr().overlaps()
        return [o for o in items if repo_id is None or o.repo_id == repo_id]

    @r.get("/overlaps/check", response_model=PairCheck)
    async def check_pair(a: str, b: str) -> PairCheck:
        return await mgr().check_pair(a, b)

    # ------------------------------------------------------------------ checkpoints
    @r.get("/checkpoints", response_model=list[Checkpoint])
    async def list_checkpoints(
        run_id: str | None = None, workspace_id: str | None = None, limit: int = 200
    ) -> list[Checkpoint]:
        return await mgr().list_checkpoints(run_id=run_id, workspace_id=workspace_id, limit=max(1, min(limit, 1000)))

    @r.post("/checkpoints", response_model=Checkpoint, status_code=201)
    async def create_checkpoint(body: CheckpointBody) -> Checkpoint:
        return await mgr().checkpoint(
            run_id=body.run_id,
            node_id=body.node_id,
            label=body.label,
            worktree_ids=body.worktree_ids,
            workspace_id=body.workspace_id,
        )

    @r.get("/checkpoints/{checkpoint_id}", response_model=Checkpoint)
    async def get_checkpoint(checkpoint_id: str) -> Checkpoint:
        return await mgr().get_checkpoint(checkpoint_id)

    @r.post("/checkpoints/{checkpoint_id}/restore", response_model=Checkpoint)
    async def restore_checkpoint(checkpoint_id: str) -> Checkpoint:
        return await mgr().restore(checkpoint_id)

    # ------------------------------------------------------------------ repos / maintenance
    @r.get("/repos/{repo_id}/branches", response_model=RepoBranches)
    async def repo_branches(repo_id: str, include_aistudio: bool = False) -> RepoBranches:
        return await mgr().branches(repo_id, include_aistudio=include_aistudio)

    @r.post("/cleanup", response_model=CleanupReport)
    async def run_cleanup() -> CleanupReport:
        return await mgr().cleanup()

    return r
