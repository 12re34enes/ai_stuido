"""Existing sessions: transcript listing (head/tail snapshots) and history replay."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from aistudio.adapters.claude import ClaudeAdapter
from aistudio.adapters.claude.history import (
    count_messages,
    history_payloads,
    parse_snapshot_output,
    project_dir_name,
    prompt_text,
    session_info,
    snapshot_from_text,
)
from aistudio.contracts.agents import (
    FileChanged,
    Message,
    SessionStarted,
    Thinking,
    ToolCall,
    ToolResultEv,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.contracts.common import Location
from aistudio.core.errors import NotFound, ValidationFailed

from .helpers import FIXTURES, LocalTestTransport

SAMPLE_ID = "1b2c3d4e-0000-4000-8000-00000000abcd"
SAMPLE_CWD = "/Users/dev/projects/shop"


def _sample() -> str:
    return (FIXTURES / "session_sample.jsonl").read_text(encoding="utf-8")


def _install(home: Path, text: str, cwd: str, native_id: str) -> Path:
    d = home / ".claude" / "projects" / project_dir_name(cwd)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{native_id}.jsonl"
    path.write_text(text, encoding="utf-8")
    return path


def test_project_dir_name() -> None:
    assert project_dir_name("/home/user/ai_stuido") == "-home-user-ai-stuido"
    long = "/" + "a" * 300
    name = project_dir_name(long)
    assert len(name) == 201 and name.endswith("-")


def test_prompt_text_rules() -> None:
    def user(content: object, **kw: object) -> dict[str, object]:
        return {"type": "user", "message": {"role": "user", "content": content}, **kw}

    assert prompt_text(user("Merhaba")) == "Merhaba"
    assert prompt_text(user([{"type": "text", "text": "  çok\nsatır  "}])) == "çok\nsatır"
    assert prompt_text(user("x", isMeta=True)) is None
    assert prompt_text(user([{"type": "tool_result", "tool_use_id": "t", "content": "x"}])) is None
    assert prompt_text(user("<command-name>/clear</command-name>")) is None
    assert prompt_text(user("<local-command-stdout>ok</local-command-stdout>")) is None
    assert prompt_text(user("[Request interrupted by user]")) is None
    assert prompt_text(user("<bash-input>ls -la</bash-input>")) == "! ls -la"
    assert prompt_text({"type": "assistant"}) is None


def test_history_payloads_from_sample() -> None:
    payloads = history_payloads(_sample(), SAMPLE_ID)
    started = payloads[0]
    assert isinstance(started, SessionStarted)
    assert started.native_id == SAMPLE_ID and started.cwd == SAMPLE_CWD
    assert started.model == "claude-sonnet-4-5" and started.cli_version == "2.1.288"

    turns = [p for p in payloads if isinstance(p, TurnStarted)]
    assert [t.input for t in turns] == [
        "Sepete indirim kodu desteği ekle",
        "Testleri de çalıştır",
        "Tamam, şimdilik bu kadar.",
    ]
    completed = [p for p in payloads if isinstance(p, TurnCompleted)]
    assert [c.status for c in completed] == ["success", "interrupted", "success"]
    assert completed[0].result_text == "İndirim kodu desteği eklendi."
    assert [c.turn_id for c in completed] == [t.turn_id for t in turns]

    first_usage = completed[0].usage
    assert first_usage is not None and first_usage.turns == 4  # msg_a..msg_d
    assert first_usage.output_tokens == 120 + 90 + 60 + 30
    assert first_usage.context_used == 4 + 100 + 12500 + 30
    assert any(isinstance(p, Usage) for p in payloads)

    calls = [p for p in payloads if isinstance(p, ToolCall)]
    assert [c.tool for c in calls] == ["Read", "Edit", "Write", "Bash"]
    assert calls[1].summary == "src/cart.ts düzenleniyor"
    results = {p.call_id: p for p in payloads if isinstance(p, ToolResultEv)}
    assert results["toolu_bash"].is_error and results["toolu_bash"].exit_code == 1
    changes = [p for p in payloads if isinstance(p, FileChanged)]
    assert [(c.path, c.change) for c in changes] == [("src/cart.ts", "modify"), ("src/discount.ts", "add")]
    assert changes[0].diff is not None and "+export function total(items, discount = 0) {" in changes[0].diff
    assert changes[1].diff is not None and "+export const CODES" in changes[1].diff

    texts = [p.text for p in payloads if isinstance(p, Message)]
    assert texts == ["Sepet modülüne bakıyorum.", "İndirim kodu desteği eklendi.", "Anlaşıldı."]
    assert [p.text for p in payloads if isinstance(p, Thinking)] == ["Önce sepet modülünü okumalıyım."]
    # every payload type is one the event log knows
    from aistudio.contracts.agents import PAYLOAD_EVENT_TYPE

    assert all(type(p) in PAYLOAD_EVENT_TYPE for p in payloads)


def test_history_tolerates_garbage() -> None:
    text = 'not json\n{"type":"user"\n' + _sample() + "\n{broken\n[]\n"
    payloads = history_payloads(text, SAMPLE_ID)
    assert len([p for p in payloads if isinstance(p, TurnStarted)]) == 3
    assert history_payloads("", SAMPLE_ID) == []
    assert history_payloads('{"type":"summary","summary":"x"}\n', SAMPLE_ID) == []


def test_session_info_from_snapshot() -> None:
    snap = snapshot_from_text(f"/h/.claude/projects/x/{SAMPLE_ID}.jsonl", _sample(), mtime=1791000000.0)
    info = session_info(snap, location=Location.local())
    assert info is not None
    assert info.native_id == SAMPLE_ID and info.cwd == SAMPLE_CWD
    assert info.title == "Sepete indirim kodu desteği"  # summary record wins over the first prompt
    assert info.model == "claude-sonnet-4-5"
    assert info.branch == "main"  # latest branch
    assert info.message_count == count_messages(_sample())[0] + count_messages(_sample())[1] == 6
    assert info.created_at is not None and info.created_at.isoformat().startswith("2026-09-30T10:00:00")
    assert info.updated_at is not None and info.updated_at.timestamp() == 1791000000.0

    titled = (
        _sample() + json.dumps({"type": "custom-title", "customTitle": "İndirim işi", "sessionId": SAMPLE_ID}) + "\n"
    )
    info2 = session_info(snapshot_from_text("/p/s.jsonl", titled), location=Location.remote("h1"))
    assert info2 is not None and info2.title == "İndirim işi" and info2.location.host_id == "h1"

    sidechain = '{"isSidechain":true,"type":"user","message":{"content":"x"}}\n'
    assert session_info(snapshot_from_text("/p/a.jsonl", sidechain), location=Location.local()) is None
    assert session_info(snapshot_from_text("/p/b.jsonl", ""), location=Location.local()) is None


def test_parse_snapshot_output() -> None:
    m = "@@M@@"
    out = (
        f"junk\n{m} FILE /a/1.jsonl\nHEAD1\n{m} TAIL\nTAIL1\n{m} COUNT 2 3\n"
        f"{m} FILE /a/2.jsonl\n\n{m} TAIL\n\n{m} COUNT 0 0\n"
    )
    snaps = parse_snapshot_output(out, m)
    assert [(s.path, s.head, s.tail, s.counts) for s in snaps] == [
        ("/a/1.jsonl", "HEAD1", "TAIL1", (2, 3)),
        ("/a/2.jsonl", "", "", (0, 0)),
    ]


@pytest.mark.skipif(shutil.which("sh") is None or shutil.which("awk") is None, reason="needs POSIX sh/awk")
async def test_list_native_sessions_via_shell(tmp_path: Path) -> None:
    home = tmp_path / "home"
    path = _install(home, _sample(), SAMPLE_CWD, SAMPLE_ID)
    other_id = "22222222-0000-4000-8000-000000000002"
    other = _install(
        home,
        '{"type":"user","message":{"role":"user","content":"Başka proje"},"cwd":"/srv/api","sessionId":"x",'
        '"timestamp":"2026-10-01T09:00:00Z","gitBranch":"dev"}\n',
        "/srv/api",
        other_id,
    )
    _install(
        home,
        '{"isSidechain":true,"type":"user","message":{"content":"s"}}\n',
        "/srv/api",
        "33333333-0000-4000-8000-000000000003",
    )
    _install(home, "", "/srv/api", "44444444-0000-4000-8000-000000000004")
    os.utime(path, (1790000000, 1790000000))
    os.utime(other, (1790000500, 1790000500))
    # a subagent transcript must not be listed
    sub = path.parent / SAMPLE_ID / "subagents"
    sub.mkdir(parents=True)
    (sub / "agent-x.jsonl").write_text('{"type":"user","message":{"content":"sub"}}\n')

    adapter = ClaudeAdapter(binary="claude", base_env={})
    transport = LocalTestTransport(home=str(home))
    sessions = await adapter.list_native_sessions(transport)
    assert [s.native_id for s in sessions] == [other_id, SAMPLE_ID]  # newest first
    assert sessions[0].title == "Başka proje" and sessions[0].branch == "dev" and sessions[0].message_count == 1
    assert sessions[1].file_path == str(path) and sessions[1].message_count == 6
    assert not sessions[1].running

    only_shop = await adapter.list_native_sessions(transport, cwd=SAMPLE_CWD + "/")
    assert [s.native_id for s in only_shop] == [SAMPLE_ID]
    assert await adapter.list_native_sessions(transport, cwd="/nowhere") == []
    assert len(await adapter.list_native_sessions(transport, limit=1)) == 1


async def test_list_native_sessions_falls_back_to_reading_files(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _install(home, _sample(), SAMPLE_CWD, SAMPLE_ID)

    class NoShell(LocalTestTransport):
        async def run(self, argv: list[str], **kw: object):  # type: ignore[override]
            raise OSError("no shell here")

    adapter = ClaudeAdapter(binary="claude", base_env={})
    sessions = await adapter.list_native_sessions(NoShell(home=str(home)))
    assert len(sessions) == 1 and sessions[0].message_count == 6 and sessions[0].title == "Sepete indirim kodu desteği"


async def test_list_uses_config_dir_and_empty(tmp_path: Path) -> None:
    adapter = ClaudeAdapter(binary="claude", config_dir=str(tmp_path / "cfg"))
    assert await adapter.list_native_sessions(LocalTestTransport(home=str(tmp_path))) == []
    env_adapter = ClaudeAdapter(binary="claude", base_env={"CLAUDE_CONFIG_DIR": str(tmp_path / "cfg2")})
    d = tmp_path / "cfg2" / "projects" / project_dir_name(SAMPLE_CWD)
    d.mkdir(parents=True)
    (d / f"{SAMPLE_ID}.jsonl").write_text(_sample(), encoding="utf-8")
    found = await env_adapter.list_native_sessions(LocalTestTransport(home=str(tmp_path)))
    assert [s.native_id for s in found] == [SAMPLE_ID]


async def test_read_native_history(tmp_path: Path) -> None:
    home = tmp_path / "home"
    _install(home, _sample(), SAMPLE_CWD, SAMPLE_ID)
    adapter = ClaudeAdapter(binary="claude", base_env={})
    transport = LocalTestTransport(home=str(home))
    by_cwd = await adapter.read_native_history(transport, SAMPLE_ID, cwd=SAMPLE_CWD)
    anywhere = await adapter.read_native_history(transport, SAMPLE_ID)
    assert by_cwd == anywhere and isinstance(by_cwd[0], SessionStarted)
    with pytest.raises(NotFound):
        await adapter.read_native_history(transport, "55555555-0000-4000-8000-000000000005")
    with pytest.raises(ValidationFailed):
        await adapter.read_native_history(transport, "*")
