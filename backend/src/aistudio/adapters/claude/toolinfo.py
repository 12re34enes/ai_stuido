"""Claude Code tool metadata: normalized kind, paths/command extraction and short Turkish
summaries used by ``ToolCall.summary`` and ``PermissionRequest.summary``."""

from __future__ import annotations

import posixpath
from typing import Any

from aistudio.adapters.claude.protocol import STUDIO_SERVER, as_dict, as_list, as_str
from aistudio.contracts.agents import ToolKind

_COMMAND_TOOLS = frozenset({"Bash", "BashOutput", "KillShell", "KillBash", "PowerShell"})
_READ_TOOLS = frozenset({"Read", "NotebookRead"})
_EDIT_TOOLS = frozenset({"Edit", "Write", "MultiEdit", "NotebookEdit"})
_SEARCH_TOOLS = frozenset({"Grep", "Glob", "LS"})
_WEB_TOOLS = frozenset({"WebFetch", "WebSearch"})
_SUBAGENT_TOOLS = frozenset({"Task", "Agent"})

EDIT_TOOLS = _EDIT_TOOLS
STUDIO_PREFIX = f"mcp__{STUDIO_SERVER}__"

_MAX_SUMMARY_ARG = 80


def tool_kind(name: str) -> ToolKind:
    if name in _COMMAND_TOOLS:
        return ToolKind.command
    if name in _READ_TOOLS:
        return ToolKind.file_read
    if name in _EDIT_TOOLS:
        return ToolKind.file_edit
    if name in _SEARCH_TOOLS:
        return ToolKind.search
    if name in _WEB_TOOLS:
        return ToolKind.web
    if name in _SUBAGENT_TOOLS:
        return ToolKind.subagent
    if name.startswith(STUDIO_PREFIX):
        return ToolKind.studio
    if name.startswith("mcp__"):
        return ToolKind.mcp
    return ToolKind.other


def split_mcp_name(name: str) -> tuple[str, str] | None:
    """``mcp__server__tool`` -> ``(server, tool)``."""
    if not name.startswith("mcp__"):
        return None
    rest = name[len("mcp__") :]
    server, sep, tool = rest.partition("__")
    if not sep:
        return None
    return server, tool


def rel_path(path: str, cwd: str | None) -> str:
    """Path relative to ``cwd`` when it lies inside it (POSIX semantics: remote hosts too)."""
    if not path:
        return path
    if cwd and posixpath.isabs(path):
        norm_cwd = posixpath.normpath(cwd)
        norm = posixpath.normpath(path)
        if norm == norm_cwd:
            return "."
        if norm.startswith(norm_cwd.rstrip("/") + "/"):
            return posixpath.relpath(norm, norm_cwd)
    return path


def _first_line(text: str, limit: int = _MAX_SUMMARY_ARG) -> str:
    """First line of ``text``, shortened to ``limit`` chars; "…" marks anything dropped."""
    lines = text.strip().splitlines()
    if not lines:
        return ""
    line = lines[0].rstrip()
    if len(line) > limit:
        return line[: limit - 1] + "…"
    return line + " …" if len(lines) > 1 else line


def tool_paths(name: str, args: dict[str, Any], cwd: str | None) -> list[str]:
    """Files a tool call touches (relative to cwd when possible)."""
    raw: list[str] = []
    for key in ("file_path", "notebook_path", "path"):
        value = as_str(args.get(key))
        if value:
            raw.append(value)
    if name == "MultiEdit":
        for edit in as_list(args.get("edits")):
            value = as_str(as_dict(edit).get("file_path"))
            if value:
                raw.append(value)
    seen: list[str] = []
    for p in raw:
        r = rel_path(p, cwd)
        if r not in seen:
            seen.append(r)
    return seen


def tool_command(name: str, args: dict[str, Any]) -> str | None:
    if name in ("Bash", "PowerShell"):
        return as_str(args.get("command"))
    return None


def _target(name: str, args: dict[str, Any], cwd: str | None) -> str:
    paths = tool_paths(name, args, cwd)
    return paths[0] if paths else "dosya"


def tool_summary(name: str, args: dict[str, Any], cwd: str | None) -> str:
    """Present-progressive Turkish one-liner: "`npm test` çalıştırılıyor"."""
    if name in ("Bash", "PowerShell"):
        desc = as_str(args.get("description"))
        cmd = as_str(args.get("command")) or ""
        if cmd:
            return f"`{_first_line(cmd)}` çalıştırılıyor"
        return f"{desc} çalıştırılıyor" if desc else "Komut çalıştırılıyor"
    if name == "BashOutput":
        return "Arka plan komutunun çıktısı okunuyor"
    if name in ("KillShell", "KillBash"):
        return "Arka plan komutu durduruluyor"
    if name in _READ_TOOLS:
        return f"{_target(name, args, cwd)} okunuyor"
    if name in ("Edit", "MultiEdit"):
        return f"{_target(name, args, cwd)} düzenleniyor"
    if name == "Write":
        return f"{_target(name, args, cwd)} yazılıyor"
    if name == "NotebookEdit":
        return f"{_target(name, args, cwd)} not defteri düzenleniyor"
    if name == "Grep":
        pattern = as_str(args.get("pattern")) or ""
        return f'"{_first_line(pattern, 60)}" aranıyor'
    if name == "Glob":
        pattern = as_str(args.get("pattern")) or ""
        return f"{_first_line(pattern, 60)} dosyaları aranıyor"
    if name == "LS":
        return f"{_target(name, args, cwd)} listeleniyor"
    if name == "WebFetch":
        url = as_str(args.get("url")) or ""
        return f"{_first_line(url)} getiriliyor"
    if name == "WebSearch":
        query = as_str(args.get("query")) or ""
        return f'Web\'de "{_first_line(query, 60)}" aranıyor'
    if name in _SUBAGENT_TOOLS:
        desc = as_str(args.get("description")) or as_str(args.get("subagent_type")) or ""
        return f"Alt ajan çalışıyor: {_first_line(desc, 60)}" if desc else "Alt ajan çalışıyor"
    if name == "TodoWrite":
        return "Yapılacaklar listesi güncelleniyor"
    if name.startswith(STUDIO_PREFIX):
        return f"Studio aracı kullanılıyor: {name[len(STUDIO_PREFIX) :]}"
    mcp = split_mcp_name(name)
    if mcp:
        return f"MCP aracı kullanılıyor: {mcp[0]}/{mcp[1]}"
    return f"{name} aracı kullanılıyor"


def permission_summary(name: str, args: dict[str, Any], cwd: str | None) -> str:
    """Turkish "... istiyor" sentence for permission prompts."""
    if name in ("Bash", "PowerShell"):
        cmd = as_str(args.get("command")) or ""
        return f"`{_first_line(cmd)}` komutunu çalıştırmak istiyor" if cmd else "Bir komut çalıştırmak istiyor"
    if name in _READ_TOOLS:
        return f"{_target(name, args, cwd)} dosyasını okumak istiyor"
    if name in ("Edit", "MultiEdit"):
        return f"{_target(name, args, cwd)} dosyasını düzenlemek istiyor"
    if name == "Write":
        return f"{_target(name, args, cwd)} dosyasını yazmak istiyor"
    if name == "NotebookEdit":
        return f"{_target(name, args, cwd)} not defterini düzenlemek istiyor"
    if name in _SEARCH_TOOLS:
        return "Dosyalarda arama yapmak istiyor"
    if name == "WebFetch":
        url = as_str(args.get("url")) or ""
        return f"{_first_line(url)} adresine erişmek istiyor" if url else "Bir web adresine erişmek istiyor"
    if name == "WebSearch":
        query = as_str(args.get("query")) or ""
        return f'Web\'de "{_first_line(query, 60)}" aramak istiyor'
    if name in _SUBAGENT_TOOLS:
        return "Alt ajan başlatmak istiyor"
    if name.startswith(STUDIO_PREFIX):
        return f"Studio aracını kullanmak istiyor: {name[len(STUDIO_PREFIX) :]}"
    mcp = split_mcp_name(name)
    if mcp:
        return f"MCP aracını kullanmak istiyor: {mcp[0]}/{mcp[1]}"
    host = as_str(args.get("host"))
    if host:  # sandbox network ask
        return f"{host} adresine ağ bağlantısı açmak istiyor"
    return f"{name} aracını kullanmak istiyor"
