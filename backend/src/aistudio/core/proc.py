"""Local subprocess helper for short-lived commands (git, CLIs' --version, ...)."""

from __future__ import annotations

import asyncio
import os
import time

from aistudio.contracts.transport import CompletedProcess


async def run(
    argv: list[str],
    *,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
    timeout: float | None = 120,
    input: bytes | None = None,
) -> CompletedProcess:
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=cwd,
        env=env if env is not None else os.environ.copy(),
        stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(input), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise
    return CompletedProcess(
        argv=argv,
        returncode=proc.returncode if proc.returncode is not None else -1,
        stdout=out.decode(errors="replace"),
        stderr=err.decode(errors="replace"),
        duration_ms=int((time.monotonic() - started) * 1000),
    )


async def git(*args: str, cwd: str, timeout: float | None = 120) -> CompletedProcess:
    env = os.environ.copy()
    env.update({"GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})
    return await run(["git", *args], cwd=cwd, env=env, timeout=timeout)
