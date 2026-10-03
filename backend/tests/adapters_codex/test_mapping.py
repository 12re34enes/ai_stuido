"""Unit tests for the pure Codex <-> normalized mappings."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from aistudio.adapters.codex import mapping as m
from aistudio.adapters.codex import protocol as p
from aistudio.contracts.agents import Boundaries, SandboxLevel, SessionSpec, ToolKind
from aistudio.contracts.tools import ToolSpec

NOW = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)


def snap(primary: tuple[float, int | None] | None, secondary: tuple[float, int | None] | None = None, **kw: object):
    def win(v: tuple[float, int | None] | None) -> p.RateLimitWindow | None:
        return p.RateLimitWindow(used_percent=v[0], window_duration_mins=v[1], resets_at=1791030000) if v else None

    return p.RateLimitSnapshot(primary=win(primary), secondary=win(secondary), **kw)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- limits


def test_limit_windows_known_durations() -> None:
    windows = m.limit_windows(snap((12.5, 300), (80, 10080)), observed_at=NOW)
    five, week = windows
    assert (five.window, five.label, five.status, five.window_minutes) == ("five_hour", "5 saat", "ok", 300)
    assert (week.window, week.label, week.status) == ("seven_day", "Haftalık", "warning")
    assert five.provider == "codex" and five.source == "event" and five.observed_at == NOW
    assert five.resets_at == datetime.fromtimestamp(1791030000, UTC)


def test_limit_windows_unknown_durations_keep_slot_names() -> None:
    windows = m.limit_windows(snap((100, 60), (5, None)), observed_at=NOW)
    assert [(w.window, w.label, w.status) for w in windows] == [
        ("primary", "Birincil", "exhausted"),
        ("secondary", "İkincil", "ok"),
    ]


def test_limit_windows_reached_type_marks_fullest_window() -> None:
    windows = m.limit_windows(snap((70, 300), (95, 10080), rate_limit_reached_type="rate_limit_reached"))
    assert [w.status for w in windows] == ["ok", "exhausted"]


def test_limit_windows_clamp_and_empty() -> None:
    assert m.limit_windows(snap(None)) == []
    (w,) = m.limit_windows(snap((140, 300)))
    assert w.used_percent == 100 and w.status == "exhausted"


def test_limit_windows_non_default_bucket_suffix() -> None:
    (w,) = m.limit_windows(snap((50, 10080), limit_id="codex_bengal", limit_name="GPT Pro"))
    assert w.window == "seven_day_codex_bengal" and w.label == "Haftalık (GPT Pro)"


# --------------------------------------------------------------------------- session params


def _spec(**kw: object) -> SessionSpec:
    return SessionSpec(provider="codex", cwd="/w", **kw)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("level", "mode"),
    [
        (SandboxLevel.read_only, "read-only"),
        (SandboxLevel.workspace_write, "workspace-write"),
        (SandboxLevel.full, "danger-full-access"),
    ],
)
def test_sandbox_mapping(level: SandboxLevel, mode: str) -> None:
    o = m.thread_overrides(_spec(boundaries=Boundaries(sandbox=level)))
    assert o["sandbox"] == mode and o["approval_policy"] == "untrusted" and o["approvals_reviewer"] == "user"


def test_advisor_forces_read_only_and_filters_mutating_tools() -> None:
    spec = _spec(role="advisor", boundaries=Boundaries(sandbox=SandboxLevel.full))
    assert m.thread_overrides(spec)["sandbox"] == "read-only"
    specs = [ToolSpec(name="a", description=""), ToolSpec(name="b", description="", mutating=True)]
    assert [s.name for s in m.exposed_tool_specs(specs, spec)] == ["a"]
    assert [s.name for s in m.exposed_tool_specs(specs, _spec())] == ["a", "b"]


def test_thread_config() -> None:
    cfg = m.thread_config(_spec(effort="low", mcp_servers={"docs": {"url": "http://localhost:1"}}))
    assert cfg == {
        "sandbox_workspace_write": {"network_access": True, "writable_roots": []},
        "model_reasoning_effort": "low",
        "mcp_servers": {"docs": {"url": "http://localhost:1"}},
    }
    cfg2 = m.thread_config(_spec(boundaries=Boundaries(network=False, sandbox=SandboxLevel.read_only)))
    assert cfg2 == {"web_search": "disabled"}


def test_developer_instructions() -> None:
    assert m.developer_instructions(_spec(boundaries=Boundaries(remote_access="full"))) is None
    text = m.developer_instructions(_spec(system_append="  Hafıza  ", boundaries=Boundaries(remote_access="read")))
    assert text is not None and text.startswith("Hafıza\n\nAI Studio boundaries:")
    assert "remote_exec" in text


def test_dynamic_tools() -> None:
    (t,) = m.dynamic_tools([ToolSpec(name="x", description="d", input_schema={})])
    assert t.wire() == {"type": "function", "name": "x", "description": "d", "inputSchema": {"type": "object"}}


# --------------------------------------------------------------------------- summaries


@pytest.mark.parametrize(
    ("command", "actions", "kind", "summary"),
    [
        ("/bin/zsh -lc 'npm test'", [{"type": "unknown", "command": "npm test"}], ToolKind.command,
         "npm test çalıştırılıyor"),
        ('bash -lc "ls -la"', [{"type": "listFiles", "command": "ls -la", "path": "src"}], ToolKind.search,
         "src listeleniyor"),
        ("rg foo", [{"type": "search", "command": "rg foo", "query": "foo", "path": None}], ToolKind.search,
         "Aranıyor: foo"),
        ("cat a.py b.py", [{"type": "read", "command": "cat a.py", "name": "a.py", "path": "/w/a.py"},
                           {"type": "read", "command": "cat b.py", "name": "b.py", "path": "/w/b.py"}],
         ToolKind.file_read, "a.py, b.py okunuyor"),
        ("git status", None, ToolKind.command, "git status çalıştırılıyor"),
    ],
)  # fmt: skip
def test_command_summaries(command: str, actions: list | None, kind: ToolKind, summary: str) -> None:
    assert m.command_kind_and_summary(command, actions) == (kind, summary)


def test_one_line_truncates() -> None:
    assert m.one_line("a\n  b") == "a b"
    long = m.one_line("x" * 300)
    assert len(long) == m.SUMMARY_LIMIT and long.endswith("…")


def _change(path: str, kind: dict) -> p.FileUpdateChange:
    return p.FileUpdateChange(path=path, kind=kind, diff="")


@pytest.mark.parametrize(
    ("kind", "progress", "asking"),
    [
        ({"type": "add"}, "a.txt oluşturuluyor", "a.txt dosyasını oluşturmak istiyor"),
        ({"type": "delete"}, "a.txt siliniyor", "a.txt dosyasını silmek istiyor"),
        ({"type": "update", "move_path": None}, "a.txt düzenleniyor", "a.txt dosyasını düzenlemek istiyor"),
        ({"type": "update", "move_path": "/w/b.txt"}, "a.txt → b.txt taşınıyor", "a.txt → b.txt taşımak istiyor"),
    ],
)
def test_file_change_summaries(kind: dict, progress: str, asking: str) -> None:
    changes = [_change("/w/a.txt", kind)]
    assert m.file_changes_summary(changes, "/w") == progress
    assert m.file_changes_summary(changes, "/w", request=True) == asking


def test_permission_builders() -> None:
    net = p.CommandExecutionRequestApprovalParams(
        thread_id="t", turn_id="u", item_id="i", network_approval_context={"host": "pypi.org", "protocol": "https"}
    )
    req = m.command_permission(net, "i#1")
    assert req.summary == "pypi.org adresine ağ erişimi istiyor" and req.command is None
    stdin = p.CommandExecutionRequestApprovalParams(thread_id="t", turn_id="u", item_id="i", kind="writeStdin")
    assert m.command_permission(stdin, "x").summary == "Çalışan bir komuta girdi göndermek istiyor"

    fc = p.FileChangeRequestApprovalParams(thread_id="t", turn_id="u", item_id="i", grant_root="/w/out")
    req2 = m.file_change_permission(fc, [], "/w", "i#2")
    assert req2.summary == "/w/out altına yazma izni istiyor" and req2.input["grant_root"] == "/w/out"

    perm = p.PermissionsRequestApprovalParams.model_validate(
        {
            "threadId": "t",
            "turnId": "u",
            "itemId": "i",
            "cwd": "/w",
            "permissions": {
                "network": None,
                "fileSystem": {
                    "read": ["/w/docs"],
                    "write": None,
                    "entries": [{"path": {"type": "glob_pattern", "pattern": "**/*.md"}, "access": "write"}],
                },
            },
        }
    )
    req3 = m.permissions_permission(perm, "i#3")
    assert req3.summary == "Ek izin istiyor: okuma: docs; yazma: **/*.md"
    assert m.wants_write(perm) is True
    granted = m.granted_permissions(perm).wire()
    assert granted == {"fileSystem": perm.permissions.file_system.model_dump(by_alias=True, exclude_none=True)}  # type: ignore[union-attr]


# --------------------------------------------------------------------------- usage / versions / misc


def test_usage_since_turn_base() -> None:
    def br(i: int, c: int, o: int, r: int) -> p.TokenUsageBreakdown:
        return p.TokenUsageBreakdown(
            total_tokens=i + o, input_tokens=i, cached_input_tokens=c, output_tokens=o, reasoning_output_tokens=r
        )

    first = p.ThreadTokenUsage(
        total=br(10_000, 4_000, 900, 300), last=br(3_000, 1_000, 200, 50), model_context_window=1000
    )
    base = m.turn_base(first)
    assert (base.input_tokens, base.cached_input_tokens, base.output_tokens) == (7_000, 3_000, 700)
    later = p.ThreadTokenUsage(total=br(14_000, 6_000, 1_400, 500), last=br(4_000, 2_000, 500, 200))
    u = m.usage_since(later, base)
    assert u.cache_read_tokens == 3_000
    assert u.input_tokens == (14_000 - 7_000) - 3_000
    assert u.output_tokens == 700 and u.reasoning_tokens == 500 - (300 - 50)
    assert u.context_used == 4_500 and u.context_window is None


@pytest.mark.parametrize(
    ("text", "version", "ok"),
    [
        ("codex-cli 0.160.0", (0, 160, 0), True),
        ("codex-cli 0.169.9-alpha.1", (0, 169, 9), True),
        ("codex-cli 0.170.0", (0, 170, 0), False),
        ("codex-cli 0.159.4", (0, 159, 4), False),
    ],
)
def test_versions(text: str, version: tuple[int, int, int], ok: bool) -> None:
    parsed = m.parse_version(text)
    assert parsed == version
    assert m.is_compatible(version) is ok


def test_version_from_user_agent_and_path() -> None:
    assert m.version_from_user_agent("aistudio/0.160.0 (Mac OS 26.0; arm64) vscode") == "0.160.0"
    assert m.version_from_user_agent("garbage") is None
    assert m.parse_version("no version") is None
    assert m.env_path_with("/opt/homebrew/bin/codex", "/usr/bin:/bin") == "/opt/homebrew/bin:/usr/bin:/bin"
    assert m.env_path_with("/usr/bin/codex", "/usr/bin:/bin") == "/usr/bin:/bin"
    assert m.env_path_with("codex", "/usr/bin") == "/usr/bin"


def test_helpers() -> None:
    assert m.unwrap_shell("/bin/bash -lc 'echo hi'") == "echo hi"
    assert m.unwrap_shell("npm test") == "npm test"
    assert m.rel_path("/w/src/a.py", "/w") == "src/a.py"
    assert m.rel_path("/other/a.py", "/w") == "/other/a.py"
    assert m.as_args('{"a": 1}') == {"a": 1}
    assert m.as_args("plain") == {"value": "plain"}
    assert m.as_args([1]) == {"value": [1]}
    assert m.as_args(None) == {}
    assert m.text_of([{"type": "text", "text": "a"}, {"type": "image"}, {"x": 1}]) == 'a\n[görsel]\n{"x": 1}'
    assert (
        m.user_input_text([{"type": "text", "text": "hi"}, {"type": "localImage", "path": "/a.png"}]) == "hi\n[görsel]"
    )
    assert m.parse_item({"type": "commandExecution", "id": "x"}) is None  # invalid shape
    assert m.parse_item({"type": "somethingNew", "id": "x"}) is None


def test_large_outputs_are_truncated() -> None:
    item = p.CommandExecutionItem(
        id="c",
        command="yes",
        cwd="/w",
        status="completed",
        command_actions=[],
        aggregated_output="y" * 200_000,
        exit_code=0,
    )
    (res,) = m.tool_result_for(item, "/w")
    assert len(res.output) <= m.OUTPUT_LIMIT  # type: ignore[union-attr]
    assert res.output.endswith("[kısaltıldı]")  # type: ignore[union-attr]
