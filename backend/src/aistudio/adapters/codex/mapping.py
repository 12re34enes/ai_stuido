"""Pure translation between Codex app-server payloads and AI Studio's normalized models."""

from __future__ import annotations

import json
import os
import posixpath
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, ValidationError

from aistudio.adapters.codex import protocol as p
from aistudio.adapters.codex.subagents import CodexSubagents
from aistudio.contracts.agents import (
    AgentEventPayload,
    FileChanged,
    Message,
    NativeSessionInfo,
    PermissionRequest,
    SandboxLevel,
    SessionSpec,
    SessionStarted,
    Thinking,
    ToolCall,
    ToolKind,
    ToolResultEv,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.contracts.common import Location
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolSpec
from aistudio.core.text import truncate

OUTPUT_LIMIT = 64 * 1024
DIFF_LIMIT = 64 * 1024
SUMMARY_LIMIT = 100

SANDBOX_MODES: dict[SandboxLevel, p.SandboxMode] = {
    SandboxLevel.read_only: "read-only",
    SandboxLevel.workspace_write: "workspace-write",
    SandboxLevel.full: "danger-full-access",
}
# "untrusted": Codex auto-runs only its known-safe read-only commands and asks for every other
# command and for every patch, so all of them reach our PermissionHandler (policy engine).
APPROVAL_POLICY: p.ApprovalPolicy = "untrusted"
# thread/list defaults to interactive sources only; include `codex exec` and app-server threads too.
LIST_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"]

# --------------------------------------------------------------------------- session params


def is_advisor(spec: SessionSpec) -> bool:
    return spec.role == "advisor"


def effective_sandbox(spec: SessionSpec) -> SandboxLevel:
    return SandboxLevel.read_only if is_advisor(spec) else spec.boundaries.sandbox


def exposed_tool_specs(specs: Iterable[ToolSpec], spec: SessionSpec) -> list[ToolSpec]:
    """Advisors never get mutating Studio tools."""
    return [s for s in specs if not (s.mutating and is_advisor(spec))]


def dynamic_tools(specs: Iterable[ToolSpec]) -> list[p.DynamicToolFunctionSpec]:
    return [
        p.DynamicToolFunctionSpec(
            name=s.name, description=s.description, input_schema=s.input_schema or {"type": "object"}
        )
        for s in specs
    ]


def thread_config(spec: SessionSpec) -> dict[str, Any]:
    """``config`` overrides (same keys as ~/.codex/config.toml) for thread/start|resume|fork."""
    cfg: dict[str, Any] = {}
    b = spec.boundaries
    if effective_sandbox(spec) == SandboxLevel.workspace_write:
        roots = [d for d in spec.extra_dirs if d]
        cfg["sandbox_workspace_write"] = {"network_access": bool(b.network), "writable_roots": roots}
    if not b.network:
        cfg["web_search"] = "disabled"
    if spec.effort:
        cfg["model_reasoning_effort"] = spec.effort
    if spec.mcp_servers:
        cfg["mcp_servers"] = spec.mcp_servers
    return cfg


def developer_instructions(spec: SessionSpec) -> str | None:
    parts: list[str] = []
    if spec.system_append.strip():
        parts.append(spec.system_append.strip())
    b = spec.boundaries
    rules: list[str] = []
    if is_advisor(spec):
        rules.append("You are an advisor: never modify files or run mutating commands; read, analyze and report.")
    if b.forbidden_paths:
        rules.append("Never read or modify these paths: " + ", ".join(b.forbidden_paths))
    if b.readonly_paths:
        rules.append("You may read but must never modify: " + ", ".join(b.readonly_paths))
    if b.denied_commands:
        rules.append("Never run these commands: " + ", ".join(b.denied_commands))
    if not b.network:
        rules.append("Network access is disabled; do not attempt network operations.")
    if b.remote_access == "none":
        rules.append("Do not connect to remote hosts or databases (no ssh, scp, rsync, psql, mysql).")
    elif b.remote_access != "full":
        rules.append("Touch remote hosts and databases only through the AI Studio tools (remote_exec, db_query).")
    if rules:
        parts.append("AI Studio boundaries:\n- " + "\n- ".join(rules))
    return "\n\n".join(parts) or None


def thread_overrides(spec: SessionSpec) -> dict[str, Any]:
    """Fields shared by ThreadStartParams / ThreadResumeParams / ThreadForkParams."""
    return {
        "model": spec.model,
        "cwd": spec.cwd,
        "approval_policy": APPROVAL_POLICY,
        "approvals_reviewer": "user",
        "sandbox": SANDBOX_MODES[effective_sandbox(spec)],
        "config": thread_config(spec) or None,
        "developer_instructions": developer_instructions(spec),
    }


# --------------------------------------------------------------------------- small helpers

_SHELL_WRAP = re.compile(r"""^(?:\S*/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])(?P<inner>.*)\1$""", re.S)


def unwrap_shell(command: str) -> str:
    m = _SHELL_WRAP.match(command.strip())
    return m.group("inner") if m else command.strip()


def one_line(text: str, limit: int = SUMMARY_LIMIT) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def rel_path(path: str, cwd: str | None) -> str:
    if not path:
        return path
    if cwd and posixpath.isabs(path):
        norm_cwd = cwd.rstrip("/") + "/"
        if path.startswith(norm_cwd):
            return path[len(norm_cwd) :]
    return path


def text_of(value: Any) -> str:
    """Best-effort text from tool results (MCP content lists, dynamic tool content items, JSON)."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        chunks: list[str] = []
        for c in value:
            if isinstance(c, dict) and isinstance(c.get("text"), str):
                chunks.append(c["text"])
            elif isinstance(c, dict) and c.get("type") in ("image", "inputImage"):
                chunks.append("[görsel]")
            else:
                chunks.append(json.dumps(c, ensure_ascii=False))
        return "\n".join(chunks)
    return json.dumps(value, ensure_ascii=False)


def as_args(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {"value": value}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return {} if value is None else {"value": value}


def user_input_text(content: list[dict[str, Any]]) -> str:
    parts: list[str] = []
    for c in content:
        kind = c.get("type")
        if kind == "text" and isinstance(c.get("text"), str):
            parts.append(c["text"])
        elif kind in ("image", "localImage"):
            parts.append("[görsel]")
        elif kind in ("mention", "skill") and c.get("name"):
            parts.append(f"@{c['name']}")
    return "\n".join(parts)


def parse_item(raw: dict[str, Any]) -> p.InModel | None:
    model = p.ITEM_MODELS.get(str(raw.get("type")))
    if model is None:
        return None
    try:
        return model.model_validate(raw)
    except ValidationError:
        return None


# --------------------------------------------------------------------------- Turkish summaries


def command_kind_and_summary(command: str, actions: list[dict[str, Any]] | None) -> tuple[ToolKind, str]:
    acts = [a for a in (actions or []) if isinstance(a, dict)]
    types = {a.get("type") for a in acts}
    if acts and types == {"read"}:
        names = [str(a.get("name") or posixpath.basename(str(a.get("path") or ""))) for a in acts]
        return ToolKind.file_read, one_line(f"{', '.join(n for n in names if n)} okunuyor")
    if acts and types == {"search"}:
        q = next((str(a["query"]) for a in acts if a.get("query")), "")
        return ToolKind.search, one_line(f"Aranıyor: {q}" if q else "Dosyalarda arama yapılıyor")
    if acts and types == {"listFiles"}:
        path = next((str(a["path"]) for a in acts if a.get("path")), "")
        return ToolKind.search, one_line(f"{path} listeleniyor" if path else "Dosyalar listeleniyor")
    return ToolKind.command, one_line(f"{unwrap_shell(command)} çalıştırılıyor")


def change_type(change: p.FileUpdateChange) -> str:
    kind = change.kind.get("type")
    if kind == "add":
        return "add"
    if kind == "delete":
        return "delete"
    if change.kind.get("move_path"):
        return "rename"
    return "modify"


def file_changes_summary(changes: list[p.FileUpdateChange], cwd: str | None, *, request: bool = False) -> str:
    if not changes:
        return "Dosya değişikliği yapmak istiyor" if request else "Dosya değişikliği"
    if len(changes) > 1:
        return f"{len(changes)} dosyada değişiklik yapmak istiyor" if request else f"{len(changes)} dosya düzenleniyor"
    c = changes[0]
    path = rel_path(c.path, cwd)
    kind = change_type(c)
    if kind == "add":
        return f"{path} dosyasını oluşturmak istiyor" if request else f"{path} oluşturuluyor"
    if kind == "delete":
        return f"{path} dosyasını silmek istiyor" if request else f"{path} siliniyor"
    if kind == "rename":
        target = rel_path(str(c.kind.get("move_path")), cwd)
        return f"{path} → {target} taşımak istiyor" if request else f"{path} → {target} taşınıyor"
    return f"{path} dosyasını düzenlemek istiyor" if request else f"{path} düzenleniyor"


_COLLAB_SUMMARY = {
    "spawnAgent": "Alt ajan başlatılıyor",
    "sendInput": "Alt ajana mesaj gönderiliyor",
    "sendMessage": "Alt ajana mesaj gönderiliyor",
    "followupTask": "Alt ajana ek görev veriliyor",
    "resumeAgent": "Alt ajan sürdürülüyor",
    "wait": "Alt ajanlar bekleniyor",
    "closeAgent": "Alt ajan kapatılıyor",
    "interruptAgent": "Alt ajan durduruluyor",
    "listAgents": "Alt ajanlar listeleniyor",
}
_AGENT_STATE_TR = {
    "pendingInit": "başlatılıyor",
    "running": "çalışıyor",
    "interrupted": "durduruldu",
    "completed": "tamamlandı",
    "errored": "hata verdi",
    "shutdown": "kapatıldı",
    "notFound": "bulunamadı",
}


def collab_summary(item: p.CollabAgentToolCallItem) -> str:
    base = _COLLAB_SUMMARY.get(item.tool, f"Alt ajan: {item.tool}")
    if item.tool == "spawnAgent" and item.prompt:
        return one_line(f"{base}: {item.prompt}")
    return one_line(base)


def collab_output(item: p.CollabAgentToolCallItem) -> str:
    """Readable tool output: one line per target agent (status + final message)."""
    lines: list[str] = []
    for tid, state in (item.agents_states or {}).items():
        if not isinstance(state, dict):
            continue
        status = _AGENT_STATE_TR.get(str(state.get("status")), str(state.get("status")))
        message = state.get("message")
        lines.append(f"{tid}: {status}" + (f"\n{message}" if isinstance(message, str) and message else ""))
    if not lines and item.receiver_thread_ids:
        lines = list(item.receiver_thread_ids)
    return "\n".join(lines)


def tag[T: BaseModel](payload: T, subagent_id: str | None) -> T:
    """Mark a payload as produced inside the given sub-agent (no-op for the main thread)."""
    if subagent_id is None or "subagent_id" not in type(payload).model_fields:
        return payload
    return payload.model_copy(update={"subagent_id": subagent_id})


def web_summary(item: p.WebSearchItem) -> str:
    action = item.action or {}
    kind = action.get("type")
    if kind == "openPage" and action.get("url"):
        return one_line(f"Sayfa açılıyor: {action['url']}")
    if kind == "findInPage" and action.get("pattern"):
        return one_line(f"Sayfada aranıyor: {action['pattern']}")
    query = item.query or action.get("query") or ""
    return one_line(f"Web'de aranıyor: {query}" if query else "Web'de arama yapılıyor")


# --------------------------------------------------------------------------- items -> payloads


def tool_call_for(item: p.InModel, cwd: str | None) -> ToolCall | None:
    if isinstance(item, p.CommandExecutionItem):
        kind, summary = command_kind_and_summary(item.command, item.command_actions)
        return ToolCall(
            call_id=item.id,
            tool="shell",
            kind=kind,
            input={"command": item.command, "cwd": item.cwd},
            summary=summary,
        )
    if isinstance(item, p.FileChangeItem):
        return ToolCall(
            call_id=item.id,
            tool="apply_patch",
            kind=ToolKind.file_edit,
            input={"changes": [{"path": rel_path(c.path, cwd), "kind": change_type(c)} for c in item.changes]},
            summary=one_line(file_changes_summary(item.changes, cwd)),
        )
    if isinstance(item, p.McpToolCallItem):
        return ToolCall(
            call_id=item.id,
            tool=f"mcp__{item.server}__{item.tool}",
            kind=ToolKind.mcp,
            input=as_args(item.arguments),
            summary=one_line(f"MCP aracı çağrılıyor: {item.server}/{item.tool}"),
        )
    if isinstance(item, p.DynamicToolCallItem):
        name = f"{item.namespace}.{item.tool}" if item.namespace else item.tool
        return ToolCall(
            call_id=item.id,
            tool=name,
            kind=ToolKind.studio,
            input=as_args(item.arguments),
            summary=one_line(f"Studio aracı çağrılıyor: {name}"),
        )
    if isinstance(item, p.WebSearchItem):
        return ToolCall(
            call_id=item.id,
            tool="web_search",
            kind=ToolKind.web,
            input={"query": item.query},
            summary=web_summary(item),
        )
    if isinstance(item, p.CollabAgentToolCallItem):
        tool_input: dict[str, Any] = {}
        if item.prompt:
            tool_input["prompt"] = truncate(item.prompt, 4000)
        if item.receiver_thread_ids:
            tool_input["receivers"] = list(item.receiver_thread_ids)
        if item.model:
            tool_input["model"] = item.model
        return ToolCall(
            call_id=item.id,
            tool=f"collab__{item.tool}",
            kind=ToolKind.subagent,
            input=tool_input,
            summary=collab_summary(item),
        )
    if isinstance(item, p.ImageViewItem):
        return ToolCall(
            call_id=item.id,
            tool="view_image",
            kind=ToolKind.file_read,
            input={"path": item.path},
            summary=one_line(f"Görsel inceleniyor: {rel_path(item.path, cwd)}"),
        )
    return None


def tool_result_for(item: p.InModel, cwd: str | None, *, streamed_output: str = "") -> list[AgentEventPayload]:
    """ToolResultEv (+ FileChanged for applied patches) for a completed tool item."""
    if isinstance(item, p.CommandExecutionItem):
        output = item.aggregated_output if item.aggregated_output is not None else streamed_output
        if item.status == "declined":
            output = output or "Komut reddedildi."
        failed = item.status in ("failed", "declined") or (item.exit_code not in (None, 0))
        return [
            ToolResultEv(
                call_id=item.id, output=truncate(output, OUTPUT_LIMIT), is_error=failed, exit_code=item.exit_code
            )
        ]
    if isinstance(item, p.FileChangeItem):
        out: list[AgentEventPayload] = []
        applied = item.status == "completed"
        paths = ", ".join(rel_path(c.path, cwd) for c in item.changes)
        if applied:
            msg = f"Uygulandı: {paths}" if paths else "Uygulandı"
        elif item.status == "declined":
            msg = "Dosya değişikliği reddedildi."
        else:
            msg = "Dosya değişikliği uygulanamadı."
        out.append(ToolResultEv(call_id=item.id, output=truncate(msg, OUTPUT_LIMIT), is_error=not applied))
        if applied:
            out.extend(file_changed_events(item.changes, cwd))
        return out
    if isinstance(item, p.McpToolCallItem):
        if item.error:
            return [
                ToolResultEv(
                    call_id=item.id, output=truncate(text_of(item.error.get("message")), OUTPUT_LIMIT), is_error=True
                )
            ]
        content = text_of((item.result or {}).get("content"))
        return [ToolResultEv(call_id=item.id, output=truncate(content, OUTPUT_LIMIT), is_error=item.status == "failed")]
    if isinstance(item, p.DynamicToolCallItem):
        return [
            ToolResultEv(
                call_id=item.id,
                output=truncate(text_of(item.content_items), OUTPUT_LIMIT),
                is_error=item.status == "failed" or item.success is False,
            )
        ]
    if isinstance(item, p.WebSearchItem):
        return [ToolResultEv(call_id=item.id, output=truncate(item.query or "", OUTPUT_LIMIT))]
    if isinstance(item, p.CollabAgentToolCallItem):
        return [
            ToolResultEv(
                call_id=item.id, output=truncate(collab_output(item), OUTPUT_LIMIT), is_error=item.status == "failed"
            )
        ]
    if isinstance(item, p.ImageViewItem):
        return [ToolResultEv(call_id=item.id, output="")]
    return []


def file_changed_events(changes: list[p.FileUpdateChange], cwd: str | None) -> list[FileChanged]:
    out: list[FileChanged] = []
    for c in changes:
        kind = change_type(c)
        diff = truncate(c.diff, DIFF_LIMIT) if c.diff else None
        if kind == "rename":
            out.append(
                FileChanged(
                    path=rel_path(str(c.kind.get("move_path")), cwd),
                    change="rename",
                    diff=diff,
                    old_path=rel_path(c.path, cwd),
                )
            )
        else:
            out.append(FileChanged(path=rel_path(c.path, cwd), change=kind, diff=diff))  # type: ignore[arg-type]
    return out


def reasoning_text(item: p.ReasoningItem) -> str:
    return "\n\n".join(s for s in item.summary if s) or "\n\n".join(s for s in item.content if s)


# --------------------------------------------------------------------------- approvals


def command_permission(params: p.CommandExecutionRequestApprovalParams, request_id: str) -> PermissionRequest:
    command = params.command or ""
    paths = [str(a["path"]) for a in params.command_actions or [] if isinstance(a, dict) and a.get("path")]
    if params.kind == "writeStdin":
        summary = "Çalışan bir komuta girdi göndermek istiyor"
    elif params.network_approval_context:
        host = params.network_approval_context.get("host") or "?"
        summary = f"{host} adresine ağ erişimi istiyor"
    else:
        summary = (
            f"{one_line(unwrap_shell(command))} komutunu çalıştırmak istiyor"
            if command
            else "Komut çalıştırmak istiyor"
        )
    kind, _ = command_kind_and_summary(command, params.command_actions)
    tool_input: dict[str, Any] = {"command": command, "cwd": params.cwd, "kind": params.kind}
    if params.network_approval_context:
        tool_input["network"] = params.network_approval_context
    return PermissionRequest(
        request_id=request_id,
        tool="shell",
        kind=kind,
        input=tool_input,
        summary=summary,
        paths=[rel_path(x, params.cwd) for x in paths],
        command=command or None,
        reason=params.reason,
    )


def file_change_permission(
    params: p.FileChangeRequestApprovalParams, changes: list[p.FileUpdateChange], cwd: str | None, request_id: str
) -> PermissionRequest:
    tool_input: dict[str, Any] = {
        "changes": [
            {"path": rel_path(c.path, cwd), "kind": change_type(c), "diff": truncate(c.diff, 16 * 1024)}
            for c in changes
        ]
    }
    if params.grant_root:
        tool_input["grant_root"] = params.grant_root
    paths: list[str] = []
    for c in changes:
        paths.append(rel_path(c.path, cwd))
        if c.kind.get("move_path"):
            paths.append(rel_path(str(c.kind["move_path"]), cwd))
    summary = file_changes_summary(changes, cwd, request=True)
    if params.grant_root and not changes:
        summary = f"{params.grant_root} altına yazma izni istiyor"
    return PermissionRequest(
        request_id=request_id,
        tool="apply_patch",
        kind=ToolKind.file_edit,
        input=tool_input,
        summary=one_line(summary, 160),
        paths=paths,
        reason=params.reason,
    )


_ACCESS_TR = {"read": "okuma", "write": "yazma", "deny": "yasak"}


def permissions_permission(params: p.PermissionsRequestApprovalParams, request_id: str) -> PermissionRequest:
    perms = params.permissions
    parts: list[str] = []
    paths: list[str] = []
    if perms.network and perms.network.get("enabled"):
        parts.append("ağ erişimi")
    fs = perms.file_system
    if fs:
        if fs.write:
            parts.append("yazma: " + ", ".join(rel_path(x, params.cwd) for x in fs.write))
            paths += fs.write
        if fs.read:
            parts.append("okuma: " + ", ".join(rel_path(x, params.cwd) for x in fs.read))
            paths += fs.read
        for e in fs.entries or []:
            target = e.get("path") or {}
            label = target.get("path") or target.get("pattern") or target.get("value")
            if label:
                parts.append(f"{_ACCESS_TR.get(str(e.get('access')), str(e.get('access')))}: {label}")
    summary = "Ek izin istiyor: " + "; ".join(parts) if parts else "Ek izin istiyor"
    return PermissionRequest(
        request_id=request_id,
        tool="request_permissions",
        kind=ToolKind.other,
        input={"permissions": perms.model_dump(by_alias=True, exclude_none=True), "cwd": params.cwd},
        summary=one_line(summary, 160),
        paths=[rel_path(x, params.cwd) for x in paths],
        reason=params.reason,
    )


def wants_write(params: p.PermissionsRequestApprovalParams) -> bool:
    fs = params.permissions.file_system
    if fs is None:
        return False
    return bool(fs.write) or any(e.get("access") == "write" for e in fs.entries or [])


def granted_permissions(params: p.PermissionsRequestApprovalParams) -> p.GrantedPermissionProfile:
    perms = params.permissions
    fs = perms.file_system.model_dump(by_alias=True, exclude_none=True) if perms.file_system else None
    return p.GrantedPermissionProfile(network=perms.network or None, file_system=fs or None)


# --------------------------------------------------------------------------- usage


def _sub(a: p.TokenUsageBreakdown, b: p.TokenUsageBreakdown) -> p.TokenUsageBreakdown:
    return p.TokenUsageBreakdown(
        total_tokens=max(0, a.total_tokens - b.total_tokens),
        input_tokens=max(0, a.input_tokens - b.input_tokens),
        cached_input_tokens=max(0, a.cached_input_tokens - b.cached_input_tokens),
        cache_write_input_tokens=max(0, a.cache_write_input_tokens - b.cache_write_input_tokens),
        output_tokens=max(0, a.output_tokens - b.output_tokens),
        reasoning_output_tokens=max(0, a.reasoning_output_tokens - b.reasoning_output_tokens),
    )


def turn_base(usage: p.ThreadTokenUsage) -> p.TokenUsageBreakdown:
    """Thread total just before the first model call of a turn (= total - last at first update)."""
    return _sub(usage.total, usage.last)


def usage_since(usage: p.ThreadTokenUsage, base: p.TokenUsageBreakdown) -> Usage:
    """Per-turn usage. ``input_tokens`` excludes cached input (reported as ``cache_read_tokens``)."""
    d = _sub(usage.total, base)
    return Usage(
        input_tokens=max(0, d.input_tokens - d.cached_input_tokens),
        output_tokens=d.output_tokens,
        cache_read_tokens=d.cached_input_tokens,
        cache_write_tokens=d.cache_write_input_tokens,
        reasoning_tokens=d.reasoning_output_tokens,
        context_used=usage.last.total_tokens or None,
        context_window=usage.model_context_window,
    )


# --------------------------------------------------------------------------- limits

_WINDOW_NAMES = {300: ("five_hour", "5 saat"), 10080: ("seven_day", "Haftalık")}
_DEFAULT_LIMIT_IDS = {None, "", "codex"}


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_") or "x"


def limit_windows(
    snapshot: p.RateLimitSnapshot,
    *,
    source: str = "event",
    observed_at: datetime | None = None,
) -> list[LimitWindow]:
    """Map a Codex rate-limit snapshot to LimitWindows.

    Windows of 300 / 10080 minutes become ``five_hour`` / ``seven_day``; anything else keeps
    ``primary`` / ``secondary``. Buckets other than the default ``codex`` one get a suffix.
    ``rateLimitReachedType`` marks the fullest window exhausted even below 100 %.
    """
    now = observed_at or datetime.now(UTC)
    suffix_id = None if snapshot.limit_id in _DEFAULT_LIMIT_IDS else snapshot.limit_id
    out: list[LimitWindow] = []
    for slot, label_tr, win in (
        ("primary", "Birincil", snapshot.primary),
        ("secondary", "İkincil", snapshot.secondary),
    ):
        if win is None:
            continue
        name, label = _WINDOW_NAMES.get(win.window_duration_mins or -1, (slot, label_tr))
        if suffix_id:
            name = f"{name}_{_slug(suffix_id)}"
            label = f"{label} ({snapshot.limit_name or suffix_id})"
        used = max(0.0, min(100.0, float(win.used_percent)))
        status = "exhausted" if used >= 100 else "warning" if used >= 80 else "ok"
        out.append(
            LimitWindow(
                provider="codex",
                window=name,
                label=label,
                used_percent=used,
                resets_at=datetime.fromtimestamp(win.resets_at, UTC) if win.resets_at else None,
                window_minutes=win.window_duration_mins,
                status=status,
                source=source,  # type: ignore[arg-type]
                observed_at=now,
            )
        )
    if snapshot.rate_limit_reached_type and out and not any(w.status == "exhausted" for w in out):
        fullest = max(out, key=lambda w: w.used_percent)
        fullest.status = "exhausted"
    return out


def limit_windows_from_read(
    resp: p.GetAccountRateLimitsResponse, *, observed_at: datetime | None = None
) -> list[LimitWindow]:
    now = observed_at or datetime.now(UTC)
    windows = limit_windows(resp.rate_limits, source="probe", observed_at=now)
    seen = {w.window for w in windows}
    for limit_id, snap in sorted((resp.rate_limits_by_limit_id or {}).items()):
        if snap.limit_id is None:
            snap = snap.model_copy(update={"limit_id": limit_id})
        for w in limit_windows(snap, source="probe", observed_at=now):
            if w.window not in seen:
                seen.add(w.window)
                windows.append(w)
    return windows


# --------------------------------------------------------------------------- discovery / history


def ts(value: int | None) -> datetime | None:
    return datetime.fromtimestamp(value, UTC) if value else None


def native_session_info(thread: p.Thread, location: Location) -> NativeSessionInfo:
    title = thread.name or (one_line(thread.preview, 120) if thread.preview else None)
    return NativeSessionInfo(
        provider="codex",
        native_id=thread.id,
        location=location,
        cwd=thread.cwd,
        title=title,
        model=thread.model,
        branch=thread.git_info.branch if thread.git_info else None,
        created_at=ts(thread.created_at),
        updated_at=ts(thread.updated_at),
        file_path=thread.path,
        running=bool(thread.status and thread.status.type == "active"),
    )


TURN_STATUS = {"completed": "success", "interrupted": "interrupted", "failed": "error", "inProgress": "interrupted"}


def turn_status(turn: p.Turn) -> str:
    return TURN_STATUS.get(turn.status, "error")


@dataclass
class SubThreadHistory:
    """A sub-agent thread read for history import (``thread/read`` + ``thread/turns/list``)."""

    thread: p.Thread | None
    turns: list[p.Turn] = field(default_factory=list)


def subagent_thread_ids(turns: Iterable[p.Turn]) -> list[str]:
    """Sub-agent threads spawned in these turns (collab spawns and v2 activity markers)."""
    seen: dict[str, None] = {}
    for turn in turns:
        for raw in turn.items:
            if not isinstance(raw, dict):
                continue
            item = parse_item(raw)
            if isinstance(item, p.CollabAgentToolCallItem) and item.tool == "spawnAgent":
                for tid in item.receiver_thread_ids:
                    seen.setdefault(tid, None)
            elif isinstance(item, p.SubAgentActivityItem) and item.kind == "started":
                seen.setdefault(item.agent_thread_id, None)
    return list(seen)


class _HistoryReplay:
    def __init__(self, thread: p.Thread, subthreads: Mapping[str, SubThreadHistory]) -> None:
        self.cwd = thread.cwd
        self.subs = CodexSubagents(thread.id)
        self.subthreads = subthreads
        self.replayed: set[str] = set()

    def items(
        self, items: list[dict[str, Any]], sid: str | None, *, skip: dict[str, Any] | None = None
    ) -> tuple[list[AgentEventPayload], str | None, str | None]:
        """Payloads of finished items (+ final / last agent message) of one turn."""
        out: list[AgentEventPayload] = []
        final_text: str | None = None
        last_text: str | None = None
        thread_id = sid or self.subs.main_thread_id
        for raw in items:
            if raw is skip:
                continue
            item = parse_item(raw)
            if isinstance(item, p.UserMessageItem):
                out.append(tag(Message(message_id=item.id, role="user", text=user_input_text(item.content)), sid))
            elif isinstance(item, p.AgentMessageItem):
                out.append(tag(Message(message_id=item.id, text=item.text), sid))
                last_text = item.text
                if item.phase == "final_answer":
                    final_text = item.text
                if sid:
                    self.subs.note_text(sid, item.text)
            elif isinstance(item, p.ReasoningItem):
                text = reasoning_text(item)
                if text:
                    out.append(tag(Thinking(message_id=item.id, text=text), sid))
            elif isinstance(item, p.PlanItem):
                out.append(tag(Thinking(message_id=item.id, text=item.text), sid))
            elif isinstance(item, p.SubAgentActivityItem):
                out += self.subs.activity(item, thread_id)
                if item.kind == "started":
                    out += self.thread(item.agent_thread_id)
            elif item is not None:
                call = tool_call_for(item, self.cwd)
                if call is not None:
                    out.append(tag(call, sid))
                    out.extend(tag(x, sid) for x in tool_result_for(item, self.cwd))
                if isinstance(item, p.CollabAgentToolCallItem):
                    if item.tool == "spawnAgent":
                        self.subs.collab_started(item, thread_id)
                    out += self.subs.collab_completed(item, thread_id)
                    if item.tool == "spawnAgent":
                        for tid in item.receiver_thread_ids:
                            out += self.thread(tid)
        return out, final_text, last_text

    def thread(self, thread_id: str) -> list[AgentEventPayload]:
        """A sub-agent thread's own turns, tagged with its id (nested spawns recurse)."""
        hist = self.subthreads.get(thread_id)
        if hist is None or thread_id in self.replayed:
            return []
        self.replayed.add(thread_id)
        out: list[AgentEventPayload] = []
        if hist.thread is not None:
            out += self.subs.enrich(thread_id, hist.thread)
        for index, turn in enumerate(hist.turns):
            out += self.subs.turn_started(thread_id)
            items = [i for i in turn.items if isinstance(i, dict)]
            prompt = next((i for i in items if i.get("type") == "userMessage"), None) if index == 0 else None
            payloads, final_text, last_text = self.items(items, thread_id, skip=prompt)
            out += payloads
            if turn.status != "inProgress":
                out += self.subs.turn_completed(thread_id, turn.status, final_text or last_text)
        return out


def history_payloads(
    thread: p.Thread, turns: list[p.Turn], subthreads: Mapping[str, SubThreadHistory] | None = None
) -> list[AgentEventPayload]:
    """Replayable normalized payloads for an existing thread (no deltas, no status changes).
    Sub-agents spawned in it become SubagentStarted / tagged payloads / SubagentCompleted; their
    own turns are included when ``subthreads`` has them."""
    cwd = thread.cwd
    replay = _HistoryReplay(thread, subthreads or {})
    out: list[AgentEventPayload] = [
        SessionStarted(native_id=thread.id, model=thread.model, cwd=cwd, cli_version=thread.cli_version)
    ]
    for turn in turns:
        items = [i for i in turn.items if isinstance(i, dict)]
        first_user = next((i for i in items if i.get("type") == "userMessage"), None)
        input_text = user_input_text(first_user.get("content") or []) if first_user else ""
        out.append(TurnStarted(turn_id=turn.id, input=input_text))
        payloads, final_text, last_text = replay.items(items, None, skip=first_user)
        out += payloads
        status = turn_status(turn)
        out.append(
            TurnCompleted(
                turn_id=turn.id,
                status=status,  # type: ignore[arg-type]
                result_text=final_text or last_text,
                usage=Usage(duration_ms=turn.duration_ms) if turn.duration_ms is not None else None,
                error=turn.error.message if turn.error else None,
            )
        )
    out += replay.subs.finish_all("interrupted")  # their end was never recorded
    return out


def parse_version(text: str) -> tuple[int, int, int] | None:
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def version_from_user_agent(user_agent: str) -> str | None:
    """``aistudio/0.160.0 (Ubuntu 24.4.0; x86_64) linux (aistudio; 0.1.0)`` -> ``0.160.0``."""
    m = re.match(r"^[^/\s]+/(\d+\.\d+\.\d+\S*)", user_agent)
    return m.group(1) if m else None


def is_compatible(version: tuple[int, int, int]) -> bool:
    return p.TESTED_MIN <= version < p.TESTED_MAX_EXCLUSIVE


def env_path_with(binary: str, path_value: str | None) -> str:
    """PATH with the binary's directory first (npm-installed codex needs ``node`` next to it)."""
    directory = posixpath.dirname(binary) if posixpath.isabs(binary) else ""
    current = path_value or os.defpath
    if not directory or directory in current.split(":"):
        return current
    return f"{directory}:{current}"
