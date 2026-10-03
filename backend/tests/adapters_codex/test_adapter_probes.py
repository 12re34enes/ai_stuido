"""health, read_limits, list_native_sessions, read_native_history through the fake CLI."""

from __future__ import annotations

import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest

from aistudio.adapters.codex import CodexAdapter
from aistudio.contracts.agents import (
    FileChanged,
    Message,
    SessionStarted,
    Thinking,
    ToolCall,
    ToolKind,
    ToolResultEv,
    TurnCompleted,
    TurnStarted,
)
from aistudio.contracts.common import Location
from aistudio.core.errors import NotFound, Unavailable

from .conftest import FIXTURES, MakeHarness, load_scenario
from .local_transport import LocalTestTransport

TID = "019a7a10-0000-7000-8000-00000000b001"


# --------------------------------------------------------------------------- health


async def test_health_ok(make_harness: MakeHarness) -> None:
    h = make_harness("queue")
    health = await h.adapter.health(h.transport)
    assert health.installed and health.version == "0.160.0"
    assert health.compatible is True and health.logged_in is True
    assert health.tested_range == ">=0.160,<0.170"
    assert health.binary is not None and health.binary.endswith("fake_app_server.py")
    assert health.message is None


async def test_health_not_logged_in_and_incompatible(make_harness: MakeHarness) -> None:
    data = load_scenario("queue")
    data.update(login="none", version="0.171.2")
    h = make_harness(data)
    health = await h.adapter.health(h.transport)
    assert health.installed and health.version == "0.171.2"
    assert health.compatible is False and health.logged_in is False
    assert health.message is not None
    assert "test edilen aralığın" in health.message and "codex login" in health.message


async def test_health_api_key_login_warns(make_harness: MakeHarness) -> None:
    data = load_scenario("queue")
    data["login"] = "apikey"
    h = make_harness(data)
    health = await h.adapter.health(h.transport)
    assert health.logged_in is True
    assert health.message is not None and "ChatGPT" in health.message


async def test_health_not_installed(tmp_path: Path) -> None:
    class NoCodex(LocalTestTransport):
        async def which(self, binary: str) -> str | None:
            return None

    adapter = CodexAdapter(base_env={"PATH": "/nonexistent"})
    transport = NoCodex(home_dir=str(tmp_path))
    health = await adapter.health(transport)
    assert health.installed is False
    assert health.message is not None and "npm install -g @openai/codex" in health.message
    assert await adapter.read_limits(transport) == []
    assert await adapter.list_native_sessions(transport) == []  # no CLI and no rollout files
    with pytest.raises(Unavailable):
        await adapter.read_native_history(transport, TID)


async def test_health_finds_candidate_install_paths(tmp_path: Path) -> None:
    home = tmp_path / "home"
    (home / ".local" / "bin").mkdir(parents=True)
    fake = home / ".local" / "bin" / "codex"
    fake.write_text(
        "#!/bin/sh\n[ \"$1\" = \"--version\" ] && echo 'codex-cli 0.165.1' && exit 0\necho 'Logged in using ChatGPT'\n"
    )
    fake.chmod(0o755)

    class NoWhich(LocalTestTransport):
        async def which(self, binary: str) -> str | None:
            return None

    adapter = CodexAdapter(base_env={"PATH": "/usr/bin:/bin"})
    health = await adapter.health(NoWhich(home_dir=str(home)))
    assert health.installed and health.binary == str(fake)
    assert health.version == "0.165.1" and health.compatible and health.logged_in


# --------------------------------------------------------------------------- limits / account


async def test_read_limits_maps_all_buckets(make_harness: MakeHarness) -> None:
    h = make_harness("history")
    windows = await h.adapter.read_limits(h.transport)
    by_name = {w.window: w for w in windows}
    assert set(by_name) == {"five_hour", "seven_day", "primary_codex_other"}
    five = by_name["five_hour"]
    assert five.used_percent == 42 and five.source == "probe" and five.status == "ok"
    assert five.resets_at == datetime.fromtimestamp(1791030000, UTC)
    assert by_name["seven_day"].status == "warning"
    other = by_name["primary_codex_other"]
    assert other.label == "Birincil (GPT-5.5 Pro)" and other.status == "exhausted" and other.window_minutes == 60
    (req,) = h.sent("account/rateLimits/read")
    assert req["params"] == {"excludeResetCreditDetails": True}
    # the probe process is gone
    assert all(p._p.returncode is not None for p in h.transport.processes)


async def test_read_limits_without_login_is_empty(make_harness: MakeHarness) -> None:
    data = load_scenario("history")
    data["login"] = "none"
    h = make_harness(data)
    assert await h.adapter.read_limits(h.transport) == []


async def test_read_account(make_harness: MakeHarness) -> None:
    h = make_harness("queue")
    account = await h.adapter.read_account(h.transport)
    assert account is not None and account.account is not None and account.account.type == "chatgpt"
    data = load_scenario("queue")
    data["login"] = "none"
    h2 = make_harness(data)
    account2 = await h2.adapter.read_account(h2.transport)
    assert account2 is not None and account2.account is None and account2.requires_openai_auth


# --------------------------------------------------------------------------- discovery


async def test_list_native_sessions_paginates_and_maps(make_harness: MakeHarness) -> None:
    h = make_harness("history")
    sessions = await h.adapter.list_native_sessions(h.transport)
    assert [s.native_id for s in sessions] == [
        TID,
        "019a7a10-0000-7000-8000-00000000b002",
        "019a7a10-0000-7000-8000-00000000b003",
    ]
    first, second, _ = sessions
    assert first.provider == "codex" and first.location == Location.local()
    assert first.title == "Testleri düzelt" and first.branch == "main" and first.model == "gpt-5.5"
    assert first.cwd == "/Users/dev/proj" and first.updated_at == datetime.fromtimestamp(1790000300, UTC)
    assert first.file_path and first.file_path.endswith(f"{TID}.jsonl")
    assert second.title == "README işi"  # thread name wins over the preview
    calls = h.sent("thread/list")
    assert len(calls) == 2  # pageSize 2 -> two pages
    assert calls[0]["params"]["sourceKinds"] == ["cli", "vscode", "exec", "appServer"]
    assert calls[0]["params"]["sortKey"] == "updated_at"
    assert calls[1]["params"]["cursor"] == "2"


async def test_list_native_sessions_cwd_filter_and_limit(make_harness: MakeHarness) -> None:
    h = make_harness("history")
    in_proj = await h.adapter.list_native_sessions(h.transport, cwd="/Users/dev/proj")
    assert {s.cwd for s in in_proj} == {"/Users/dev/proj"} and len(in_proj) == 2
    assert h.sent("thread/list")[0]["params"]["cwd"] == "/Users/dev/proj"
    one = await h.adapter.list_native_sessions(h.transport, limit=1)
    assert len(one) == 1


async def test_list_native_sessions_falls_back_to_rollout_files(make_harness: MakeHarness, tmp_path: Path) -> None:
    h = make_harness({"failStart": "boom"})
    sessions_dir = tmp_path / "home" / ".codex" / "sessions"
    shutil.copytree(FIXTURES / "rollouts", sessions_dir)
    found = await h.adapter.list_native_sessions(h.transport)
    assert [s.native_id for s in found] == [
        "019a7a10-0000-7000-8000-00000000d002",
        "019a7a10-0000-7000-8000-00000000d001",
    ]
    proj = await h.adapter.list_native_sessions(h.transport, cwd="/Users/dev/proj")
    (info,) = proj
    assert info.title == "Login sayfasını düzelt" and info.message_count == 3
    assert info.model == "gpt-5.5" and info.branch == "main"
    assert info.created_at == datetime(2026, 10, 1, 9, 0, tzinfo=UTC)
    assert info.updated_at == datetime(2026, 10, 1, 9, 0, 12, tzinfo=UTC)
    assert info.file_path is not None and info.file_path.startswith(str(sessions_dir))


async def test_list_native_sessions_remote_location(make_harness: MakeHarness) -> None:
    h = make_harness("history")
    h.transport.kind = "ssh"
    h.transport.host_id = "host_1"
    sessions = await h.adapter.list_native_sessions(h.transport, limit=1)
    assert sessions[0].location == Location.remote("host_1")


# --------------------------------------------------------------------------- history


async def test_read_native_history_converts_turns(make_harness: MakeHarness) -> None:
    h = make_harness("history")
    payloads = await h.adapter.read_native_history(h.transport, TID)
    assert isinstance(payloads[0], SessionStarted) and payloads[0].native_id == TID
    assert payloads[0].cwd == "/Users/dev/proj" and payloads[0].cli_version == "0.160.0"

    turns = [p for p in payloads if isinstance(p, TurnStarted)]
    assert [t.input for t in turns] == ["Testleri düzelt", "Devam et", "Bir daha dene"]
    calls = [p for p in payloads if isinstance(p, ToolCall)]
    assert [(c.call_id, c.kind) for c in calls] == [
        ("c1", ToolKind.command),
        ("c2", ToolKind.file_read),
        ("p1", ToolKind.file_edit),
        ("m1", ToolKind.mcp),
        ("d1", ToolKind.studio),
        ("w1", ToolKind.web),
    ]
    assert calls[0].summary == "pytest -q çalıştırılıyor"
    assert calls[1].summary == "app.py okunuyor"
    assert calls[3].tool == "mcp__docs__search"
    assert calls[5].summary == "Web'de aranıyor: pytest fixtures"
    results = {p.call_id: p for p in payloads if isinstance(p, ToolResultEv)}
    assert results["c1"].is_error and results["c1"].exit_code == 1 and results["c1"].output == "1 failed"
    assert results["m1"].output == "docs result" and results["d1"].output == "memory text"
    changes = [(c.path, c.change, c.old_path) for c in payloads if isinstance(c, FileChanged)]
    assert changes == [("src/app.py", "modify", None), ("new.txt", "rename", "old.txt"), ("tmp.log", "delete", None)]
    assert [p.text for p in payloads if isinstance(p, Thinking)] == ["Önce testleri çalıştırayım"]
    msgs = [(m.role, m.text) for m in payloads if isinstance(m, Message)]
    assert msgs == [("assistant", "Düzelttim."), ("user", "Sadece src klasörü"), ("assistant", "Durdum.")]
    done = [p for p in payloads if isinstance(p, TurnCompleted)]
    assert [d.status for d in done] == ["success", "interrupted", "error"]
    assert done[0].result_text == "Düzelttim." and done[0].usage is not None and done[0].usage.duration_ms == 60000
    assert done[2].error == "You've hit your usage limit."
    # pagination over thread/turns/list (pageSize 2)
    pages = h.sent("thread/turns/list")
    assert len(pages) == 2 and pages[0]["params"]["itemsView"] == "full"
    assert pages[0]["params"]["sortDirection"] == "asc"
    assert h.sent("thread/read")[0]["params"] == {"threadId": TID, "includeTurns": False}


async def test_read_native_history_unknown_thread(make_harness: MakeHarness) -> None:
    h = make_harness("history")
    with pytest.raises(NotFound):
        await h.adapter.read_native_history(h.transport, "019a0000-0000-7000-8000-000000000000")


async def test_read_native_history_when_cli_fails(make_harness: MakeHarness) -> None:
    h = make_harness({"failStart": "boom"})
    with pytest.raises(Unavailable):
        await h.adapter.read_native_history(h.transport, TID)
