"""Git runner: one small interface over "run git here" for local repos and repos on SSH hosts.

* :class:`LocalGitRunner` runs in studiod's own environment (via :mod:`aistudio.core.proc`), so
  pushes use the user's git credentials.
* :class:`TransportGitRunner` runs through a :class:`~aistudio.contracts.transport.Transport`
  obtained from ``RemoteService.transport(host_id)``.

Everything above this layer (worktrees, diffs, merges, checkpoints) is written once against
:class:`GitRunner`.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import signal
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Protocol

from aistudio.contracts.transport import CompletedProcess, Transport
from aistudio.core import proc
from aistudio.core.errors import NotFound, StudioError, Unavailable
from aistudio.security.masking import Masker

# Identity for every commit studiod itself creates (commit_all, merges, checkpoints).
AISTUDIO_IDENTITY: dict[str, str] = {
    "GIT_AUTHOR_NAME": "AI Studio",
    "GIT_AUTHOR_EMAIL": "aistudio@localhost",
    "GIT_COMMITTER_NAME": "AI Studio",
    "GIT_COMMITTER_EMAIL": "aistudio@localhost",
}

# Non-interactive, machine-readable, never take optional locks (agents work in these trees
# concurrently and must not see index.lock contention caused by our read-only polling).
BASE_ENV: dict[str, str] = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_OPTIONAL_LOCKS": "0",
    "GIT_MERGE_AUTOEDIT": "no",
    "GIT_EDITOR": "true",
    "GIT_PAGER": "cat",
    "LC_ALL": "C",
    "LANG": "C",
}

# Inherited variables that would redirect git to another repository/index.
REPO_LOCATION_ENV: tuple[str, ...] = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
)

# Gate commands run code written by agents: never hand them the SSH agent or studiod's token.
COMMAND_SCRUB_ENV: tuple[str, ...] = (*REPO_LOCATION_ENV, "SSH_AUTH_SOCK", "SSH_AGENT_PID", "AISTUDIO_DEV_TOKEN")

# Per-invocation config: no GPG/SSH signing prompts in a background daemon, no auto-gc inside
# the user's repo, unquoted paths, no colors.
CONFIG_FLAGS: tuple[str, ...] = (
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    "core.quotepath=off",
    "-c",
    "gc.auto=0",
    "-c",
    "color.ui=never",
    "-c",
    "advice.detachedHead=false",
)

TIMEOUT_EXIT_CODE = 124
_STDERR_DETAIL_LIMIT = 4000


class GitCommandError(StudioError):
    status_code = 500
    code = "git_failed"

    def __init__(self, message: str, *, args: list[str], returncode: int | None, stderr: str, stdout: str = "") -> None:
        super().__init__(
            message,
            details={"args": args[:12], "exit_code": returncode, "stderr": stderr[-_STDERR_DETAIL_LIMIT:]},
        )
        self.args_list = args
        self.returncode = returncode
        self.stderr = stderr
        self.stdout = stdout


@dataclass
class ShellResult:
    exit_code: int
    output: str
    timed_out: bool
    duration_ms: int


class GitRunner(Protocol):
    kind: Literal["local", "remote"]
    host_id: str | None

    async def git(
        self,
        *args: str,
        cwd: str,
        env: Mapping[str, str] | None = None,
        input: bytes | None = None,
        timeout: float | None = 120,
        check: bool = True,
    ) -> CompletedProcess:
        """Run ``git <args>``. ``env`` adds variables. Raises :class:`GitCommandError` when
        ``check`` and the exit code is non-zero."""
        ...

    async def shell(self, command: str, *, cwd: str, timeout: float, max_output: int) -> ShellResult:
        """``/bin/sh -lc <command>`` with stdout+stderr combined and tail-truncated (unmasked)."""
        ...

    async def exists(self, path: str) -> bool: ...
    async def copy_file(self, src: str, dst: str) -> bool:
        """Copy ``src`` to ``dst``; False if ``src`` does not exist."""
        ...

    async def remove_file(self, path: str) -> None: ...
    async def remove_tree(self, path: str) -> None: ...
    async def home(self) -> str: ...


def tail(text: str, limit: int, *, marker: str = "… [çıktının başı kısaltıldı]\n") -> str:
    if len(text) <= limit:
        return text
    return marker + text[-max(0, limit - len(marker)) :]


class _RunnerBase:
    def __init__(self, masker: Masker) -> None:
        self._masker = masker

    def _check(self, args: list[str], cp: CompletedProcess, check: bool) -> CompletedProcess:
        if check and cp.returncode != 0:
            sub = next((a for a in args if not a.startswith("-")), "git")
            raise GitCommandError(
                f"Git komutu başarısız oldu (git {sub}).",
                args=args,
                returncode=cp.returncode,
                stderr=self._masker.mask(cp.stderr.strip()),
                stdout=cp.stdout,
            )
        return cp

    def _timeout_error(self, args: list[str], timeout: float | None) -> GitCommandError:
        sub = next((a for a in args if not a.startswith("-")), "git")
        return GitCommandError(
            f"Git komutu zaman aşımına uğradı (git {sub}, {int(timeout or 0)} sn).",
            args=args,
            returncode=None,
            stderr="",
        )


class LocalGitRunner(_RunnerBase):
    kind: Literal["local", "remote"] = "local"
    host_id: str | None = None

    def _env(self, extra: Mapping[str, str] | None) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k not in REPO_LOCATION_ENV}
        env.update(BASE_ENV)
        if extra:
            env.update(extra)
        return env

    async def git(
        self,
        *args: str,
        cwd: str,
        env: Mapping[str, str] | None = None,
        input: bytes | None = None,
        timeout: float | None = 120,
        check: bool = True,
    ) -> CompletedProcess:
        argv = ["git", *CONFIG_FLAGS, *args]
        try:
            cp = await proc.run(argv, cwd=cwd, env=self._env(env), timeout=timeout, input=input)
        except TimeoutError:
            raise self._timeout_error(list(args), timeout) from None
        except (FileNotFoundError, NotADirectoryError):
            if not Path(cwd).is_dir():
                raise NotFound("Klasör bulunamadı.", details={"path": cwd}) from None
            raise Unavailable("git bulunamadı. Lütfen git kurun (2.38 veya üstü).") from None
        return self._check(list(args), cp, check)

    async def shell(self, command: str, *, cwd: str, timeout: float, max_output: int) -> ShellResult:
        if not Path(cwd).is_dir():
            raise NotFound("Klasör bulunamadı.", details={"path": cwd})
        # The user's own environment (PATH, locale, toolchains) minus anything agent code must not get.
        env = {k: v for k, v in os.environ.items() if k not in COMMAND_SCRUB_ENV}
        env["GIT_TERMINAL_PROMPT"] = "0"
        return await _run_shell_local(command, cwd=cwd, env=env, timeout=timeout, max_output=max_output)

    async def exists(self, path: str) -> bool:
        return await asyncio.to_thread(os.path.exists, path)

    async def copy_file(self, src: str, dst: str) -> bool:
        def _copy() -> bool:
            try:
                shutil.copyfile(src, dst)
            except FileNotFoundError:
                return False
            return True

        return await asyncio.to_thread(_copy)

    async def remove_file(self, path: str) -> None:
        def _rm() -> None:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(path)

        await asyncio.to_thread(_rm)

    async def remove_tree(self, path: str) -> None:
        await asyncio.to_thread(shutil.rmtree, path, True)

    async def home(self) -> str:
        return str(Path.home())


async def _run_shell_local(
    command: str, *, cwd: str, env: dict[str, str], timeout: float, max_output: int
) -> ShellResult:
    """Run in its own process group so a timeout kills the whole tree (test runners spawn workers)."""
    started = time.monotonic()
    child = await asyncio.create_subprocess_exec(
        "/bin/sh",
        "-lc",
        command,
        cwd=cwd,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        start_new_session=True,
    )
    buf = bytearray()
    keep = max(1024, max_output * 4)  # bytes; generous so multibyte text survives decoding
    dropped = False

    async def pump() -> None:
        nonlocal dropped
        assert child.stdout is not None
        while chunk := await child.stdout.read(65536):
            buf.extend(chunk)
            if len(buf) > 2 * keep:
                del buf[: len(buf) - keep]
                dropped = True

    def killpg(sig: signal.Signals) -> None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(child.pid, sig)

    pump_task = asyncio.create_task(pump())
    timed_out = False
    try:
        try:
            await asyncio.wait_for(child.wait(), timeout=timeout)
        except TimeoutError:
            timed_out = True
            killpg(signal.SIGTERM)
            try:
                await asyncio.wait_for(child.wait(), timeout=3)
            except TimeoutError:
                killpg(signal.SIGKILL)
                await child.wait()
        # Leftover background children may keep the pipe open: give them a moment, then kill.
        try:
            await asyncio.wait_for(asyncio.shield(pump_task), timeout=2)
        except TimeoutError:
            killpg(signal.SIGKILL)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(asyncio.shield(pump_task), timeout=2)
    except BaseException:
        killpg(signal.SIGKILL)
        raise
    finally:
        if not pump_task.done():
            pump_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pump_task
    text = bytes(buf).decode(errors="replace")
    if dropped:
        text = "… [çıktının başı kısaltıldı]\n" + text
    rc = child.returncode if child.returncode is not None else -1
    if rc < 0:
        rc = 128 + (-rc)
    if timed_out:
        rc = TIMEOUT_EXIT_CODE
        text += f"\n… [komut {timeout:g} sn içinde bitmediği için durduruldu]"
    return ShellResult(
        exit_code=rc,
        output=tail(text, max_output),
        timed_out=timed_out,
        duration_ms=int((time.monotonic() - started) * 1000),
    )


class TransportGitRunner(_RunnerBase):
    """Git on an SSH host. Variables are passed with ``env`` in argv because SSH servers usually
    refuse to forward environment variables."""

    kind: Literal["local", "remote"] = "remote"

    def __init__(self, transport: Transport, masker: Masker, *, host_id: str | None = None) -> None:
        super().__init__(masker)
        self._t = transport
        self.host_id = host_id if host_id is not None else transport.host_id

    @staticmethod
    def _env_prefix(extra: Mapping[str, str] | None) -> list[str]:
        argv = ["env"]
        for key in REPO_LOCATION_ENV:
            if not (extra and key in extra):
                argv += ["-u", key]
        merged = {**BASE_ENV, **(extra or {})}
        argv += [f"{k}={v}" for k, v in merged.items()]
        return argv

    async def git(
        self,
        *args: str,
        cwd: str,
        env: Mapping[str, str] | None = None,
        input: bytes | None = None,
        timeout: float | None = 120,
        check: bool = True,
    ) -> CompletedProcess:
        argv = [*self._env_prefix(env), "git", *CONFIG_FLAGS, *args]
        try:
            cp = await self._t.run(argv, cwd=cwd, timeout=timeout, input=input)
        except TimeoutError:
            raise self._timeout_error(list(args), timeout) from None
        return self._check(list(args), cp, check)

    async def shell(self, command: str, *, cwd: str, timeout: float, max_output: int) -> ShellResult:
        started = time.monotonic()
        argv = ["env", *(x for k in COMMAND_SCRUB_ENV for x in ("-u", k)), "/bin/sh", "-lc", "exec 2>&1\n" + command]
        try:
            cp = await self._t.run(argv, cwd=cwd, timeout=timeout)
        except TimeoutError:
            return ShellResult(
                exit_code=TIMEOUT_EXIT_CODE,
                output=f"… [komut {timeout:g} sn içinde bitmediği için durduruldu]",
                timed_out=True,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
        text = cp.stdout + (("\n" + cp.stderr) if cp.stderr else "")
        return ShellResult(
            exit_code=cp.returncode,
            output=tail(text, max_output),
            timed_out=False,
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    async def exists(self, path: str) -> bool:
        return await self._t.exists(path)

    async def copy_file(self, src: str, dst: str) -> bool:
        cp = await self._t.run(["cp", src, dst], timeout=120)
        return cp.returncode == 0

    async def remove_file(self, path: str) -> None:
        await self._t.run(["rm", "-f", path], timeout=60)

    async def remove_tree(self, path: str) -> None:
        await self._t.run(["rm", "-rf", path], timeout=600)

    async def home(self) -> str:
        return await self._t.home()
