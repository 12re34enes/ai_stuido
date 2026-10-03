"""Worktrees, diffs, merges and checkpoints (spec §7, §18). Implemented in ``aistudio.gitops``."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from aistudio.contracts.common import Location


class Worktree(BaseModel):
    id: str
    repo_id: str
    workspace_id: str
    path: str
    branch: str  # aistudio/<task-slug>/<label>-<n>
    base_ref: str
    base_sha: str
    location: Location = Field(default_factory=Location)
    run_id: str | None = None
    task_id: str | None = None
    label: str | None = None
    status: Literal["active", "merged", "abandoned", "removed"] = "active"
    created_at: datetime


class FileDiff(BaseModel):
    path: str
    old_path: str | None = None
    status: Literal["added", "modified", "deleted", "renamed", "copied", "binary"]
    additions: int = 0
    deletions: int = 0
    patch: str | None = None  # unified diff for this file (None for binary / too large)


class DiffResult(BaseModel):
    base: str
    head: str
    files: list[FileDiff] = Field(default_factory=list)
    additions: int = 0
    deletions: int = 0
    truncated: bool = False


class MergePreview(BaseModel):
    clean: bool
    conflicts: list[str] = Field(default_factory=list)  # conflicting paths
    target_ref: str
    target_sha: str
    diff: DiffResult | None = None


class MergeResult(BaseModel):
    merged: bool
    commit_sha: str | None = None
    conflicts: list[str] = Field(default_factory=list)
    message: str | None = None


class Checkpoint(BaseModel):
    id: str
    run_id: str | None = None
    node_id: str | None = None
    label: str
    refs: dict[str, str] = Field(default_factory=dict)  # worktree_id -> commit sha
    memory_commit: str | None = None
    created_at: datetime


class FileOverlap(BaseModel):
    """Two active worktrees touching the same file (live conflict warning)."""

    path: str
    repo_id: str
    worktree_ids: list[str]
    session_ids: list[str] = Field(default_factory=list)


class WorktreeManager(Protocol):
    async def create(
        self,
        repo_id: str,
        *,
        base_ref: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        label: str = "agent",
        location: Location | None = None,
    ) -> Worktree: ...
    async def get(self, worktree_id: str) -> Worktree: ...
    async def list(self, *, run_id: str | None = None, active_only: bool = True) -> list[Worktree]: ...
    async def changed_files(self, worktree_id: str) -> list[str]:
        """Paths changed vs base (committed + uncommitted + untracked)."""
        ...

    async def diff(self, worktree_id: str, *, include_patch: bool = True) -> DiffResult: ...
    async def commit_all(self, worktree_id: str, message: str) -> str | None:
        """Commit everything in the worktree; returns sha or None if nothing changed."""
        ...

    async def merge_preview(self, worktree_id: str, target_ref: str | None = None) -> MergePreview: ...
    async def merge(
        self,
        worktree_id: str,
        *,
        target_ref: str | None = None,
        strategy: Literal["merge", "squash", "cherry_pick"] = "merge",
        message: str | None = None,
    ) -> MergeResult: ...
    async def push(self, worktree_id: str, *, remote: str = "origin") -> None: ...
    async def remove(self, worktree_id: str, *, force: bool = False) -> None: ...
    async def run_command(self, worktree_id: str, command: str, *, timeout: float = 1800) -> tuple[int, str]:
        """Run a shell command inside the worktree (used by the build/test gate). Returns
        (exit_code, combined masked output)."""
        ...

    async def checkpoint(
        self,
        *,
        run_id: str | None,
        node_id: str | None,
        label: str,
        worktree_ids: list[str],
        workspace_id: str | None = None,
    ) -> Checkpoint: ...
    async def restore(self, checkpoint_id: str) -> Checkpoint: ...
    async def overlaps(self) -> list[FileOverlap]: ...
