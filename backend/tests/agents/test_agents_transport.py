"""LocalTransport and the scrubbed agent environment."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest

from aistudio.agents.transport_local import LocalTransport, is_sensitive_env_name, scrubbed_env

PY = sys.executable

ECHO_SCRIPT = """
import sys
sys.stderr.write("ready\\n"); sys.stderr.flush()
for line in sys.stdin:
    if line.strip() == "big":
        sys.stdout.write("x" * (5 * 1024 * 1024) + "\\n")
    else:
        sys.stdout.write("echo:" + line)
    sys.stdout.flush()
"""


def transport() -> LocalTransport:
    return LocalTransport(env=scrubbed_env(augment_path=False))


async def test_spawn_readline_write_and_large_lines() -> None:
    t = transport()
    proc = await t.spawn([PY, "-u", "-c", ECHO_SCRIPT])
    assert proc.pid is not None
    await proc.write(b"hello\n")
    assert await proc.readline() == b"echo:hello\n"
    await proc.write(b"big\n")
    line = await proc.readline()
    assert len(line) == 5 * 1024 * 1024 + 1 and line.endswith(b"\n")
    await proc.write("şğü\n".encode())
    assert (await proc.readline()).decode() == "echo:şğü\n"
    await proc.close_stdin()
    assert await proc.readline() == b""
    assert await proc.wait() == 0
    assert b"ready" in await proc.read_stderr()
    await proc.close_stdin()  # idempotent
    with pytest.raises(BrokenPipeError):
        await proc.write(b"late\n")


async def test_partial_last_line_and_cwd(tmp_path: Path) -> None:
    t = transport()
    proc = await t.spawn([PY, "-c", "import os,sys; sys.stdout.write(os.getcwd())"], cwd=str(tmp_path))
    assert os.path.realpath((await proc.readline()).decode()) == os.path.realpath(tmp_path)
    assert await proc.readline() == b""
    assert await proc.wait() == 0


async def test_terminate_and_kill_process_group() -> None:
    t = transport()
    proc = await t.spawn([PY, "-c", "import subprocess,time; subprocess.Popen(['sleep','30']); time.sleep(30)"])
    await asyncio.sleep(0.2)
    await proc.terminate()
    rc = await asyncio.wait_for(proc.wait(), timeout=5)
    assert rc != 0
    await proc.kill()  # already gone: no error
    stubborn = "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)"
    proc2 = await t.spawn([PY, "-c", stubborn])
    await asyncio.sleep(0.2)
    await proc2.kill()
    assert await asyncio.wait_for(proc2.wait(), timeout=5) == -9


async def test_run_basic_input_timeout_and_missing_binary() -> None:
    t = transport()
    r = await t.run([PY, "-c", "import sys; print(sys.stdin.read().upper()); sys.exit(3)"], input=b"abc")
    assert r.returncode == 3 and r.stdout.strip() == "ABC" and r.duration_ms >= 0
    started = asyncio.get_running_loop().time()
    with pytest.raises(TimeoutError):
        await t.run([PY, "-c", "import time; time.sleep(30)"], timeout=0.3)
    assert asyncio.get_running_loop().time() - started < 5
    missing = await t.run(["definitely-not-a-binary-xyz"])
    assert missing.returncode == 127


async def test_run_uses_scrubbed_default_env() -> None:
    env = scrubbed_env({"PATH": os.environ["PATH"], "HOME": "/tmp", "SSH_AUTH_SOCK": "/tmp/agent"}, augment_path=False)
    t = LocalTransport(env=env)
    r = await t.run([PY, "-c", "import os, json; print(json.dumps(sorted(os.environ)))"])
    keys = set(json.loads(r.stdout))
    assert "SSH_AUTH_SOCK" not in keys
    assert {"PATH", "HOME"} <= keys
    explicit = await t.run([PY, "-c", "import os; print(os.environ.get('ONLY'))"], env={"ONLY": "1", **env})
    assert explicit.stdout.strip() == "1"
    assert await t.home() == "/tmp"


def test_scrubbed_env_keeps_only_safe_variables() -> None:
    fake = "x" * 8
    source = {
        "PATH": "/usr/bin:/bin",
        "HOME": "/Users/me",
        "USER": "me",
        "LOGNAME": "me",
        "SHELL": "/bin/zsh",
        "LANG": "tr_TR.UTF-8",
        "LC_ALL": "tr_TR.UTF-8",
        "LC_CTYPE": "UTF-8",
        "TERM": "xterm-256color",
        "TMPDIR": "/var/folders/x",
        "CLAUDE_CONFIG_DIR": "/Users/me/.claude-alt",
        "CODEX_HOME": "/Users/me/.codex",
        "SSH_AUTH_SOCK": "/private/tmp/agent.sock",
        "SSH_AGENT_PID": "123",
        "ANTHROPIC_API_KEY": fake,
        "OPENAI_API_KEY": fake,
        "AWS_ACCESS_KEY_ID": fake,
        "AWS_SECRET_ACCESS_KEY": fake,
        "AWS_PROFILE": "prod",
        "GOOGLE_APPLICATION_CREDENTIALS": "/x.json",
        "AZURE_CLIENT_SECRET": fake,
        "GITHUB_TOKEN": fake,
        "GH_TOKEN": fake,
        "GITLAB_TOKEN": fake,
        "MY_SERVICE_TOKEN": fake,
        "DB_PASSWORD": fake,
        "APP_SECRET": fake,
        "PGPASSWORD": fake,
        "DATABASE_URL": "postgres://u@h/db",
        "KUBECONFIG": "/k",
        "DOCKER_HOST": "tcp://x",
        "LC_SECRET_THING": fake,
        "EDITOR": "vim",
        "NODE_OPTIONS": "--max-old-space-size=4096",
    }
    env = scrubbed_env(source, augment_path=False, extra={"FOO": "1", "NPM_TOKEN": fake, "SSH_AUTH_SOCK": "/s"})
    assert set(env) == {
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "TMPDIR",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "FOO",
    }
    assert env["PATH"] == "/usr/bin:/bin"


def test_scrubbed_env_defaults() -> None:
    env = scrubbed_env({}, augment_path=False)
    assert env["PATH"] and env["HOME"]
    for name in ("GH_TOKEN", "X_API_KEY", "PGHOST", "AWS_REGION", "SSH_AUTH_SOCK", "SLACK_BOT_TOKEN"):
        assert is_sensitive_env_name(name), name
    for name in ("PATH", "LANG", "LC_ALL", "TERM", "HOME"):
        assert not is_sensitive_env_name(name), name


async def test_file_operations_and_glob(tmp_path: Path) -> None:
    t = transport()
    target = tmp_path / "a" / "b" / "c.jsonl"
    await t.write_file(str(target), b'{"x": 1}\n')
    assert await t.read_file(str(target)) == b'{"x": 1}\n'
    assert await t.exists(str(target))
    assert not await t.exists(str(tmp_path / "nope"))
    await t.write_file(str(tmp_path / "a" / "d.jsonl"), b"")
    await t.write_file(str(tmp_path / "e.txt"), b"")
    found = await t.glob(f"{tmp_path}/**/*.jsonl")
    assert found == sorted([str(target), str(tmp_path / "a" / "d.jsonl")])
    assert all(os.path.isabs(p) for p in found)
    assert await t.glob(f"{tmp_path}/none/**/*.x") == []
    await t.write_file(str(target), b"replaced")
    assert await t.read_file(str(target)) == b"replaced"


async def test_which() -> None:
    t = LocalTransport()
    sh = await t.which("sh")
    assert sh is not None and os.path.isabs(sh)
    assert await t.which(sh) == sh
    assert await t.which("definitely-not-a-binary-xyz") is None
    assert await t.which("/nonexistent/bin/tool") is None
    assert t.kind == "local" and t.host_id is None
