"""Normalizer, tool metadata and diff helpers."""

from __future__ import annotations

from typing import Any

import pytest

from aistudio.adapters.claude.normalize import (
    ClaudeNormalizer,
    build_usage,
    content_text,
    context_window,
    diff_for_new_file,
    file_change,
)
from aistudio.adapters.claude.toolinfo import permission_summary, rel_path, tool_kind, tool_paths, tool_summary
from aistudio.contracts.agents import (
    AgentErrorEv,
    AgentState,
    FileChanged,
    Message,
    MessageDelta,
    SubagentStarted,
    ToolCall,
    ToolKind,
    ToolResultEv,
)


@pytest.mark.parametrize(
    ("name", "kind"),
    [
        ("Bash", ToolKind.command),
        ("Read", ToolKind.file_read),
        ("Edit", ToolKind.file_edit),
        ("Write", ToolKind.file_edit),
        ("MultiEdit", ToolKind.file_edit),
        ("NotebookEdit", ToolKind.file_edit),
        ("Grep", ToolKind.search),
        ("Glob", ToolKind.search),
        ("WebFetch", ToolKind.web),
        ("WebSearch", ToolKind.web),
        ("mcp__studio__memory_read", ToolKind.studio),
        ("mcp__github__create_issue", ToolKind.mcp),
        ("Task", ToolKind.subagent),
        ("Agent", ToolKind.subagent),
        ("TodoWrite", ToolKind.other),
    ],
)
def test_tool_kind(name: str, kind: ToolKind) -> None:
    assert tool_kind(name) == kind


def test_summaries_are_turkish_and_short() -> None:
    cwd = "/repo"
    assert tool_summary("Bash", {"command": "npm test"}, cwd) == "`npm test` çalıştırılıyor"
    assert tool_summary("Bash", {"command": "echo a\necho b"}, cwd) == "`echo a …` çalıştırılıyor"
    long_cmd = "x" * 200
    assert len(tool_summary("Bash", {"command": long_cmd}, cwd)) < 100
    assert tool_summary("Edit", {"file_path": "/repo/src/app.ts"}, cwd) == "src/app.ts düzenleniyor"
    assert tool_summary("Write", {"file_path": "/elsewhere/x.md"}, cwd) == "/elsewhere/x.md yazılıyor"
    assert tool_summary("Read", {"file_path": "/repo/a.py"}, cwd) == "a.py okunuyor"
    assert tool_summary("Grep", {"pattern": "TODO"}, cwd) == '"TODO" aranıyor'
    assert tool_summary("WebSearch", {"query": "pydantic"}, cwd) == 'Web\'de "pydantic" aranıyor'
    assert tool_summary("mcp__studio__memory_read", {}, cwd) == "Studio aracı kullanılıyor: memory_read"
    assert tool_summary("mcp__gh__pr", {}, cwd) == "MCP aracı kullanılıyor: gh/pr"
    assert tool_summary("Task", {"description": "Kodu incele"}, cwd) == "Alt ajan çalışıyor: Kodu incele"
    assert permission_summary("Edit", {"file_path": "/repo/src/x.ts"}, cwd) == "src/x.ts dosyasını düzenlemek istiyor"
    assert permission_summary("WebFetch", {"url": "https://example.com"}, cwd) == (
        "https://example.com adresine erişmek istiyor"
    )
    assert permission_summary("Unknown", {"host": "pypi.org"}, cwd) == "pypi.org adresine ağ bağlantısı açmak istiyor"


def test_paths() -> None:
    assert rel_path("/repo", "/repo") == "."
    assert rel_path("/repo2/x", "/repo") == "/repo2/x"
    assert rel_path("rel/x", "/repo") == "rel/x"
    paths = tool_paths(
        "MultiEdit", {"file_path": "/repo/a.ts", "edits": [{"file_path": "/repo/b.ts"}, "junk"]}, "/repo"
    )
    assert paths == ["a.ts", "b.ts"]


def test_content_text() -> None:
    assert content_text("x") == "x"
    assert content_text([{"type": "text", "text": "a"}, {"type": "image"}, {"type": "text", "text": "b"}]) == (
        "a\n[görsel]\nb"
    )
    assert content_text(None) == ""


def test_file_change_variants() -> None:
    cwd = "/repo"
    created = file_change(
        "Write",
        {"file_path": "/repo/n.txt", "content": "a\nb\n"},
        {"type": "create", "filePath": "/repo/n.txt", "content": "a\nb\n", "structuredPatch": [], "originalFile": None},
        cwd,
        is_error=False,
    )
    assert created == FileChanged(path="n.txt", change="add", diff=diff_for_new_file("n.txt", "a\nb\n"))
    assert created is not None and "+a" in (created.diff or "") and "@@ -0,0 +1,2 @@" in (created.diff or "")

    updated = file_change(
        "Write",
        {"file_path": "/repo/n.txt"},
        {
            "type": "update",
            "filePath": "/repo/n.txt",
            "structuredPatch": [{"oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1, "lines": ["-a", "+b"]}],
        },
        cwd,
        is_error=False,
    )
    assert updated is not None and updated.change == "modify"
    assert updated.diff == "--- a/n.txt\n+++ b/n.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n"

    # no structured output: still report the touched file, without diff
    bare = file_change("Edit", {"file_path": "/repo/a.py"}, None, cwd, is_error=False)
    assert bare == FileChanged(path="a.py", change="modify")
    assert file_change("Edit", {"file_path": "/repo/a.py"}, None, cwd, is_error=True) is None
    assert file_change("Bash", {"command": "touch x"}, None, cwd, is_error=False) is None
    notebook = file_change("NotebookEdit", {"notebook_path": "/repo/n.ipynb"}, {}, cwd, is_error=False)
    assert notebook is not None and notebook.path == "n.ipynb"


def _stream(event: dict[str, Any], parent: str | None = None) -> dict[str, Any]:
    return {"type": "stream_event", "event": event, "parent_tool_use_id": parent}


def test_stream_and_final_frames_share_ids() -> None:
    n = ClaudeNormalizer("/repo")
    n.stream_event(
        _stream({"type": "message_start", "message": {"id": "m1", "usage": {"input_tokens": 100, "output_tokens": 1}}})
    )
    start = n.stream_event(_stream({"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}))
    assert start.state == AgentState.responding
    d = n.stream_event(
        _stream({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Merhaba"}})
    )
    assert d.payloads == [MessageDelta(message_id="m1:0", text="Merhaba")]
    n.stream_event(
        _stream(
            {
                "type": "content_block_start",
                "index": 1,
                "content_block": {"type": "tool_use", "id": "t1", "name": "Bash"},
            }
        )
    )
    n.stream_event(_stream({"type": "message_delta", "usage": {"output_tokens": 50}}))
    assert n.context_used == 150
    # subagent stream ignored
    assert (
        n.stream_event(
            _stream({"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}, "x")
        ).state
        is None
    )

    # final frames: tool_use block first must still map to index 1, text to index 0
    tool = n.assistant(
        {
            "type": "assistant",
            "message": {
                "id": "m1",
                "model": "claude-x",
                "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}}],
            },
            "parent_tool_use_id": None,
        }
    )
    assert isinstance(tool.payloads[0], ToolCall) and tool.state == AgentState.running_tool
    text = n.assistant(
        {
            "type": "assistant",
            "message": {"id": "m1", "model": "claude-x", "content": [{"type": "text", "text": "Merhaba"}]},
            "parent_tool_use_id": None,
        }
    )
    assert text.payloads == [Message(message_id="m1:0", text="Merhaba")]
    assert n.model == "claude-x" and n.pending_main_tools == 1

    res = n.user(
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "x" * 70000}],
            },
            "parent_tool_use_id": None,
        }
    )
    tr = res.payloads[0]
    assert isinstance(tr, ToolResultEv) and tr.exit_code == 0 and len(tr.output) <= 64 * 1024
    assert res.state == AgentState.thinking and n.pending_main_tools == 0


def test_frames_without_streaming_get_sequential_ids() -> None:
    n = ClaudeNormalizer(None)
    a = n.assistant({"message": {"id": "m9", "content": [{"type": "text", "text": "a"}]}, "parent_tool_use_id": None})
    b = n.assistant({"message": {"id": "m9", "content": [{"type": "text", "text": "b"}]}, "parent_tool_use_id": None})
    assert [p.message_id for p in a.payloads + b.payloads if isinstance(p, Message)] == ["m9:0", "m9:1"]


def test_subagent_frames_are_tagged_and_never_change_state() -> None:
    n = ClaudeNormalizer("/repo")
    out = n.assistant(
        {
            "message": {
                "id": "s1",
                "content": [
                    {"type": "text", "text": "subagent says"},
                    {"type": "tool_use", "id": "t9", "name": "Edit", "input": {"file_path": "/repo/z.py"}},
                ],
            },
            "parent_tool_use_id": "toolu_task",
            "subagent_type": "Explore",
        }
    )
    # unknown spawner (e.g. a resumed process): the subagent is announced lazily
    assert [type(p) for p in out.payloads] == [SubagentStarted, Message, ToolCall] and out.state is None
    started = out.payloads[0]
    assert isinstance(started, SubagentStarted) and started.subagent_id == "toolu_task" and started.name == "Explore"
    assert all(getattr(p, "subagent_id", None) == "toolu_task" for p in out.payloads)
    res = n.user(
        {
            "message": {"content": [{"type": "tool_result", "tool_use_id": "t9", "content": "ok"}]},
            "parent_tool_use_id": "toolu_task",
            "tool_use_result": {"filePath": "/repo/z.py", "structuredPatch": []},
        }
    )
    assert [type(p) for p in res.payloads] == [ToolResultEv, FileChanged] and res.state is None
    assert all(getattr(p, "subagent_id", None) == "toolu_task" for p in res.payloads)
    assert n.pending_main_tools == 0


def test_bash_exit_code_and_api_error() -> None:
    n = ClaudeNormalizer(None)
    n.assistant({"message": {"id": "m", "content": [{"type": "tool_use", "id": "b", "name": "Bash", "input": {}}]}})
    res = n.user(
        {
            "message": {
                "content": [
                    {"type": "tool_result", "tool_use_id": "b", "is_error": True, "content": "boom\nExit code 2"}
                ]
            }
        }
    )
    tr = res.payloads[0]
    assert isinstance(tr, ToolResultEv) and tr.exit_code == 2 and tr.is_error
    err = n.assistant(
        {"error": "authentication_failed", "message": {"id": "e", "content": [{"type": "text", "text": "401"}]}}
    )
    assert isinstance(err.payloads[0], AgentErrorEv) and "claude auth login" in err.payloads[0].message


def test_usage_and_context_window() -> None:
    usage = build_usage(
        {
            "usage": {
                "input_tokens": 1,
                "output_tokens": 2,
                "cache_read_input_tokens": 3,
                "cache_creation_input_tokens": 4,
            },
            "modelUsage": {
                "claude-a": {"contextWindow": 1000000, "outputTokens": 5},
                "claude-haiku": {"contextWindow": 200000, "outputTokens": 1},
            },
            "duration_ms": 10,
            "num_turns": 2,
        },
        model=None,
        context_used=77,
        cost_delta=0.5,
    )
    assert (usage.input_tokens, usage.output_tokens, usage.cache_read_tokens, usage.cache_write_tokens) == (1, 2, 3, 4)
    assert usage.context_window == 1000000 and usage.context_used == 77 and usage.turns == 2
    assert context_window({"claude-b": {"contextWindow": 5}}, "claude-b[1m]") == 5
    assert context_window({}, "x") is None
