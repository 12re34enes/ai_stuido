"""Adapter-level behaviour: health, limits probe, binary discovery, remote env, module wiring."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Literal

from aistudio.adapters.claude import ClaudeAdapter
from aistudio.adapters.claude.module import ClaudeAdapterModule
from aistudio.agents.registry import AdapterRegistryImpl
from aistudio.contracts.agents import AdapterRegistry, SessionSpec, SessionStarted
from aistudio.contracts.transport import CompletedProcess
from aistudio.core.context import AppContext

from .helpers import FAKE_CLI, FakeToolHost, LocalTestTransport, RecordingSink, ScriptedPermissions, make_adapter


async def test_health_ok(tmp_path: Path) -> None:
    adapter, _ = make_adapter(tmp_path, {})
    health = await adapter.health(LocalTestTransport())
    assert health.installed and health.version == "2.1.288" and health.compatible
    assert health.logged_in is True and health.message is None
    assert health.tested_range == ">=2.1.200,<2.2"
    assert health.binary is not None and str(FAKE_CLI) in health.binary


async def test_health_problems(tmp_path: Path) -> None:
    adapter, _ = make_adapter(
        tmp_path, {"version": "2.3.1 (Claude Code)", "auth": {"loggedIn": False, "authMethod": "none"}}
    )
    health = await adapter.health(LocalTestTransport())
    assert health.version == "2.3.1" and health.compatible is False and health.logged_in is False
    assert health.message is not None
    assert "test edilen aralığın" in health.message and "claude auth login" in health.message

    (tmp_path / "k").mkdir()
    api_key, _ = make_adapter(tmp_path / "k", {"auth": {"loggedIn": True, "authMethod": "api_key"}})
    h2 = await api_key.health(LocalTestTransport())
    assert h2.message is not None and "API anahtarı" in h2.message


async def test_health_not_installed(tmp_path: Path) -> None:
    class Bare(LocalTestTransport):
        async def which(self, binary: str) -> str | None:
            return None

    adapter = ClaudeAdapter()
    health = await adapter.health(Bare(home=str(tmp_path)))
    assert not health.installed and health.message is not None and "bulunamadı" in health.message


async def test_binary_discovery_candidates(tmp_path: Path) -> None:
    local_bin = tmp_path / ".local" / "bin"
    local_bin.mkdir(parents=True)
    fake = local_bin / "claude"
    fake.write_text(
        f"#!{sys.executable}\nimport runpy, sys\nsys.argv[0] = {str(FAKE_CLI)!r}\n"
        f"runpy.run_path({str(FAKE_CLI)!r}, run_name='__main__')\n"
    )
    fake.chmod(0o755)

    class NoPath(LocalTestTransport):
        async def which(self, binary: str) -> str | None:
            return None

    adapter = ClaudeAdapter(base_env={"FAKE_CLAUDE_SCENARIO": str(tmp_path / "s.json")})
    (tmp_path / "s.json").write_text("{}")
    health = await adapter.health(NoPath(home=str(tmp_path)))
    assert health.installed and health.binary == str(fake) and health.version == "2.1.288"


async def test_read_limits_via_get_usage(tmp_path: Path) -> None:
    adapter, log = make_adapter(
        tmp_path,
        {
            "usage_response": {
                "rate_limits_available": True,
                "rate_limits": {
                    "five_hour": {"utilization": 12, "resets_at": "2026-10-03T15:00:00Z"},
                    "seven_day": {"utilization": 55.5, "resets_at": "2026-10-08T00:00:00Z"},
                },
            }
        },
    )
    transport = LocalTestTransport(home=str(tmp_path / "home"))
    windows = await adapter.read_limits(transport)
    assert {w.window: w.used_percent for w in windows} == {"five_hour": 12.0, "seven_day": 55.5}
    argv = transport.spawned[0]
    assert "--no-session-persistence" in argv
    entries = [line for line in log.read_text().splitlines() if '"get_usage"' in line]
    assert entries and '"skip_behaviors": true' in entries[0]


async def test_read_limits_failure_is_empty(tmp_path: Path) -> None:
    adapter, _ = make_adapter(tmp_path, {"startup": {"exit": 1}})
    assert await adapter.read_limits(LocalTestTransport(home=str(tmp_path / "home"))) == []
    missing = ClaudeAdapter(binary=str(tmp_path / "nope"))
    assert await missing.read_limits(LocalTestTransport(home=str(tmp_path))) == []


class _RemoteRecorder:
    """Records spawn/run calls of a pretend SSH transport and delegates to a local one."""

    kind: Literal["local", "ssh"] = "ssh"
    host_id: str | None = "h1"

    def __init__(self, inner: LocalTestTransport) -> None:
        self.inner = inner
        self.spawn_calls: list[tuple[list[str], dict[str, str] | None]] = []
        self.run_calls: list[tuple[list[str], dict[str, str] | None]] = []

    async def spawn(self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None):
        self.spawn_calls.append((argv, env))
        return await self.inner.spawn(argv, cwd=cwd, env=None)

    async def run(self, argv: list[str], *, cwd=None, env=None, timeout=None, input=None) -> CompletedProcess:  # type: ignore[no-untyped-def]
        self.run_calls.append((argv, env))
        return await self.inner.run(argv, cwd=cwd, env=None, timeout=timeout, input=input)

    async def read_file(self, path: str) -> bytes:
        return await self.inner.read_file(path)

    async def write_file(self, path: str, data: bytes) -> None:
        await self.inner.write_file(path, data)

    async def exists(self, path: str) -> bool:
        return await self.inner.exists(path)

    async def glob(self, pattern: str) -> list[str]:
        return await self.inner.glob(pattern)

    async def home(self) -> str:
        return await self.inner.home()

    async def which(self, binary: str) -> str | None:
        return None


async def test_remote_transport_uses_env_prefix(tmp_path: Path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    scenario = tmp_path / "s.json"
    scenario.write_text('{"turns": []}')
    monkeypatch.setenv("FAKE_CLAUDE_SCENARIO", str(scenario))
    adapter = ClaudeAdapter(binary=[sys.executable, str(FAKE_CLI)], init_timeout=15)
    remote = _RemoteRecorder(LocalTestTransport(home=str(tmp_path)))
    sink = RecordingSink()
    session = await adapter.start(
        SessionSpec(provider="claude", cwd=str(tmp_path), env={"FOO": "bar"}),
        transport=remote,
        sink=sink,
        tools=FakeToolHost(),
        permissions=ScriptedPermissions(),
    )
    await session.close()
    argv, env = remote.spawn_calls[0]
    assert env is None
    assert argv[0] == "env" and "-u" in argv and "ANTHROPIC_API_KEY" in argv
    assert "CLAUDE_CODE_ENTRYPOINT=sdk-py" in argv and "FOO=bar" in argv
    assert argv.index("FOO=bar") < argv.index(sys.executable)
    assert sink.of(SessionStarted)

    sessions = await adapter.list_native_sessions(remote)
    assert sessions == []


async def test_module_registers_adapter(ctx: AppContext) -> None:
    registry = AdapterRegistryImpl()
    ctx.services.register(AdapterRegistry, registry)  # type: ignore[type-abstract]
    module = ClaudeAdapterModule()
    await module.setup(ctx)
    adapter = registry.get("claude")
    assert isinstance(adapter, ClaudeAdapter) and adapter is module.adapter
    assert adapter.provider == "claude"


def test_module_is_loaded_by_app(app_ctx) -> None:  # type: ignore[no-untyped-def]
    _client, c, _token = app_ctx
    registry = c.services.get(AdapterRegistry)  # type: ignore[type-abstract]
    assert isinstance(registry.get("claude"), ClaudeAdapter)
