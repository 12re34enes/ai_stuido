"""Repos on SSH hosts go through ``RemoteService.transport(host_id)``. A fake Transport runs the
commands locally so the remote code path is exercised end to end."""

from __future__ import annotations

import glob as globlib
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Literal

import pytest
from gitops_helpers import Env, git, setup_env, write

from aistudio.contracts.remote import RemoteService
from aistudio.contracts.transport import CompletedProcess, Process
from aistudio.core import proc
from aistudio.core.context import AppContext
from aistudio.core.errors import Unavailable


class FakeTransport:
    kind: Literal["local", "ssh"] = "ssh"

    def __init__(self, host_id: str, home: Path) -> None:
        self.host_id: str | None = host_id
        self._home = home
        self.calls: list[list[str]] = []

    async def spawn(self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None) -> Process:
        raise NotImplementedError

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        self.calls.append(argv)
        return await proc.run(argv, cwd=cwd, env=env, timeout=timeout, input=input)

    async def read_file(self, path: str) -> bytes:
        return Path(path).read_bytes()

    async def write_file(self, path: str, data: bytes) -> None:
        Path(path).write_bytes(data)

    async def exists(self, path: str) -> bool:
        return os.path.exists(path)

    async def glob(self, pattern: str) -> list[str]:
        return sorted(globlib.glob(pattern, recursive=True))

    async def home(self) -> str:
        return str(self._home)

    async def which(self, binary: str) -> str | None:
        return None


class FakeRemote:
    def __init__(self, transport: FakeTransport) -> None:
        self.t = transport

    async def transport(self, host_id: str) -> FakeTransport:
        assert host_id == self.t.host_id
        return self.t


@pytest.fixture
async def remote_env(ctx: AppContext, repo_path: Path, tmp_path: Path) -> AsyncIterator[tuple[Env, FakeTransport]]:
    transport = FakeTransport("host_1", tmp_path / "remote-home")
    ctx.services.register(RemoteService, FakeRemote(transport))  # type: ignore[type-abstract,arg-type]
    gm, env = await setup_env(ctx, repo_path, host_id="host_1")
    try:
        yield env, transport
    finally:
        await gm.stop()


async def test_remote_worktree_lifecycle(remote_env: tuple[Env, FakeTransport], tmp_path: Path) -> None:
    env, transport = remote_env
    git(env.path, "checkout", "-q", "-b", "dev")
    wt = await env.mgr.create(env.repo.id, label="codex")
    assert wt.location.kind == "remote" and wt.location.host_id == "host_1"
    assert wt.path == str(tmp_path / "remote-home" / ".aistudio/worktrees/deneme-alani/manual/codex-1")
    assert transport.calls and all(c[0] in ("env", "cp", "rm") for c in transport.calls)
    assert any("git" in c for c in transport.calls)

    write(wt.path, "remote.txt", "hello\n")
    assert await env.mgr.changed_files(wt.id) == ["remote.txt"]
    diff = await env.mgr.diff(wt.id)
    assert [f.path for f in diff.files] == ["remote.txt"] and diff.files[0].patch

    cp = await env.mgr.checkpoint(run_id=None, node_id=None, label="uzak", worktree_ids=[wt.id])
    sha = await env.mgr.commit_all(wt.id, "Remote work")
    assert sha and git(wt.path, "log", "-1", "--format=%an") == "AI Studio"
    write(wt.path, "later.txt", "later\n")
    await env.mgr.restore(cp.id)
    assert not Path(wt.path, "later.txt").exists() and Path(wt.path, "remote.txt").exists()
    assert git(wt.path, "rev-parse", "HEAD") == wt.base_sha

    await env.mgr.commit_all(wt.id, "Remote work again")
    preview = await env.mgr.merge_preview(wt.id)
    assert preview.clean
    env.mgr._versions["host_1"] = (2, 39, 0)  # cherry-pick through the git<2.40 fallback remotely too
    result = await env.mgr.merge(wt.id, strategy="cherry_pick")
    assert result.merged and git(env.path, "show", "main:remote.txt") == "hello"

    code, out = await env.mgr.run_command(wt.id, "echo uzak; echo hata >&2; exit 4")
    assert code == 4 and "uzak" in out and "hata" in out

    await env.mgr.remove(wt.id)
    assert not Path(wt.path).exists()


async def test_remote_repo_without_remote_service(ctx: AppContext, repo_path: Path) -> None:
    gm, env = await setup_env(ctx, repo_path, host_id="host_x")
    try:
        with pytest.raises(Unavailable):
            await env.mgr.create(env.repo.id)
    finally:
        await gm.stop()
