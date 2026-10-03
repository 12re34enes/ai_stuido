"""Agent processes must never see the SSH agent or cloud credentials (spec §8, layer 4).

Adapters build the CLI environment from the transport's scrubbed base; this guards the seam
between the agents module (LocalTransport) and both adapters.
"""

from __future__ import annotations

import pytest

from aistudio.adapters.claude.adapter import ClaudeAdapter
from aistudio.adapters.codex.adapter import CodexAdapter
from aistudio.agents.transport_local import LocalTransport

LEAKY = {
    "SSH_AUTH_SOCK": "/private/tmp/com.apple.launchd.x/Listeners",
    "AWS_SECRET_ACCESS_KEY": "x" * 12,
    "GITHUB_TOKEN": "y" * 12,
    "DATABASE_URL": "postgres://u:p@h/db",
    "ANTHROPIC_API_KEY": "z" * 12,
    "OPENAI_API_KEY": "w" * 12,
}


@pytest.fixture
def leaky_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for k, v in LEAKY.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.corp:3128")


def test_claude_env_is_scrubbed(leaky_env: None) -> None:
    transport = LocalTransport()
    _, env = ClaudeAdapter()._command(transport, ["claude", "-p"], {"EXTRA": "1"})
    assert env is not None
    assert not set(LEAKY) & set(env)
    assert env["EXTRA"] == "1"
    assert env["HTTPS_PROXY"] == "http://proxy.corp:3128"


async def test_codex_env_is_scrubbed(leaky_env: None) -> None:
    transport = LocalTransport()
    env = await CodexAdapter()._env(transport, ["/usr/local/bin/codex", "app-server"], {"EXTRA": "1"})
    assert env is not None
    assert not set(LEAKY) & set(env)
    assert env["EXTRA"] == "1"
    assert env["HTTPS_PROXY"] == "http://proxy.corp:3128"
