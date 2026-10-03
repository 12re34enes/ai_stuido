"""Launch configuration: argv, ``--settings`` / ``--mcp-config`` JSON and the child environment,
derived from a :class:`SessionSpec` and its :class:`Boundaries` (spec §6, §8 layer 1)."""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from aistudio.adapters.claude.protocol import EFFORT_LEVELS, STUDIO_SERVER
from aistudio.contracts.agents import Boundaries, SandboxLevel, SessionSpec

log = logging.getLogger(__name__)

# Roles that never write: they get the read-only built-in tool set.
READ_ONLY_ROLES: frozenset[str] = frozenset({"advisor"})
READ_ONLY_TOOLS: tuple[str, ...] = ("Read", "Grep", "Glob")
WEB_TOOLS: tuple[str, ...] = ("WebFetch", "WebSearch")
WRITE_TOOLS: tuple[str, ...] = ("Edit", "Write", "MultiEdit", "NotebookEdit", "Bash")
# Tools we always switch off: questions to the user go through the Studio ``ask_user`` tool
# (approval inbox, alert channels) instead of the CLI's own interactive dialog.
ALWAYS_DISALLOWED: tuple[str, ...] = ("AskUserQuestion",)

# Environment variables removed from the child environment. API keys would make the CLI bill
# the API instead of using the user's subscription login; the others are markers of an outer
# Claude Code session (studiod may be started from one during development).
SCRUBBED_ENV: frozenset[str] = frozenset(
    {
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_API_KEY",
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_SESSION_ID",
        "NODE_OPTIONS",
        "DEBUG",
    }
)
# Identifies us as an SDK host (same value the official Python SDK uses).
ENTRYPOINT = "sdk-py"


@dataclass(frozen=True)
class LaunchOptions:
    """Adapter-wide knobs (constructor arguments of ``ClaudeAdapter``)."""

    strict_mcp_config: bool = True  # only our MCP servers + spec.mcp_servers, not the user's
    setting_sources: Sequence[str] | None = None  # None = CLI default (user, project, local)
    studio_tool_timeout_ms: int | None = None  # None = CLI default (very long)
    extra_args: Sequence[str] = field(default_factory=tuple)


def is_read_only(spec: SessionSpec) -> bool:
    return spec.role in READ_ONLY_ROLES or spec.boundaries.sandbox == SandboxLevel.read_only


def _path_pattern(pattern: str) -> str:
    """Boundary globs are gitignore-style relative to the repo root (= the session cwd).
    Claude rules treat ``/x`` as relative to the settings *file*, so anchor with ``./``."""
    pattern = pattern.strip()
    if pattern.startswith("/") and not pattern.startswith("//"):
        return "." + pattern
    return pattern


def _command_rules(pattern: str) -> list[str]:
    """``npm test`` -> ``Bash(npm test)`` + ``Bash(npm test *)`` (the command and any args);
    patterns that already contain ``*`` are used verbatim."""
    pattern = pattern.strip()
    if not pattern:
        return []
    if pattern.startswith("Bash(") and pattern.endswith(")"):
        return [pattern]
    if "*" in pattern:
        return [f"Bash({pattern})"]
    return [f"Bash({pattern})", f"Bash({pattern} *)"]


def _dedupe(items: list[str]) -> list[str]:
    out: list[str] = []
    for item in items:
        if item not in out:
            out.append(item)
    return out


def deny_rules(boundaries: Boundaries, *, read_only: bool) -> list[str]:
    rules: list[str] = []
    for p in boundaries.forbidden_paths:
        pat = _path_pattern(p)
        if pat:
            rules += [f"Read({pat})", f"Edit({pat})", f"Write({pat})"]
    for p in boundaries.readonly_paths:
        pat = _path_pattern(p)
        if pat:
            rules += [f"Edit({pat})", f"Write({pat})"]
    for c in boundaries.denied_commands:
        rules += _command_rules(c)
    if not boundaries.network:
        rules += list(WEB_TOOLS)
    if read_only:
        rules += list(WRITE_TOOLS)
    return _dedupe(rules)


def allow_rules(boundaries: Boundaries, *, read_only: bool) -> list[str]:
    # Studio tools enforce their own approvals (and the ToolHost was bound for this role),
    # so the whole in-process server is auto-allowed.
    rules = [f"mcp__{STUDIO_SERVER}"]
    if not read_only:
        for c in boundaries.allowed_commands:
            rules += _command_rules(c)
    return _dedupe(rules)


def build_settings(boundaries: Boundaries, *, read_only: bool) -> dict[str, Any]:
    """The ``--settings`` JSON. Deny rules always win over allow rules in Claude Code."""
    return {
        "permissions": {
            "allow": allow_rules(boundaries, read_only=read_only),
            "deny": deny_rules(boundaries, read_only=read_only),
        }
    }


def disallowed_tools(boundaries: Boundaries, *, read_only: bool) -> list[str]:
    """Same deny rules again as ``--disallowedTools``: in ``-p`` mode a settings payload that
    fails validation is silently ignored, so the flag is the belt to the settings' braces."""
    return _dedupe([*deny_rules(boundaries, read_only=read_only), *ALWAYS_DISALLOWED])


def build_mcp_config(spec: SessionSpec, options: LaunchOptions) -> dict[str, Any]:
    servers: dict[str, Any] = {}
    for name, cfg in spec.mcp_servers.items():
        if name == STUDIO_SERVER:
            log.warning("ignoring user MCP server named %r (reserved for Studio tools)", name)
            continue
        servers[name] = cfg
    studio: dict[str, Any] = {"type": "sdk", "name": STUDIO_SERVER, "alwaysLoad": True}
    if options.studio_tool_timeout_ms:
        studio["timeout"] = options.studio_tool_timeout_ms
    servers[STUDIO_SERVER] = studio
    return {"mcpServers": servers}


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def build_argv(
    binary: Sequence[str],
    spec: SessionSpec,
    *,
    session_id: str,
    options: LaunchOptions | None = None,
) -> list[str]:
    """Full command line for a new, resumed or forked session.

    ``session_id`` is the native id this process will run under: a fresh UUID for new and
    forked sessions, ``spec.resume_native_id`` for a plain resume.
    """
    options = options or LaunchOptions()
    read_only = is_read_only(spec)
    argv = [
        *binary,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        # Every "ask" decision becomes a can_use_tool control_request to us.
        "--permission-prompt-tool",
        "stdio",
        "--permission-mode",
        "default",
    ]
    if spec.resume_native_id:
        argv += ["--resume", spec.resume_native_id]
        if spec.fork:
            argv += ["--fork-session", "--session-id", session_id]
    else:
        argv += ["--session-id", session_id]
    if spec.model:
        argv += ["--model", spec.model]
    if spec.effort:
        if spec.effort in EFFORT_LEVELS:
            argv += ["--effort", spec.effort]
        else:
            log.warning("ignoring unsupported claude effort level %r", spec.effort)
    if spec.system_append.strip():
        argv += ["--append-system-prompt", spec.system_append]
    for d in spec.extra_dirs:
        argv += ["--add-dir", d]
    argv += ["--mcp-config", _json(build_mcp_config(spec, options))]
    if options.strict_mcp_config:
        argv.append("--strict-mcp-config")
    argv += ["--settings", _json(build_settings(spec.boundaries, read_only=read_only))]
    disallowed = disallowed_tools(spec.boundaries, read_only=read_only)
    if disallowed:
        argv += ["--disallowedTools", ",".join(disallowed)]
    if read_only:
        tools = list(READ_ONLY_TOOLS) + (list(WEB_TOOLS) if spec.boundaries.network else [])
        argv += ["--tools", ",".join(tools)]
    if options.setting_sources is not None:
        argv.append(f"--setting-sources={','.join(options.setting_sources)}")
    argv += list(options.extra_args)
    return argv


def probe_argv(binary: Sequence[str]) -> list[str]:
    """A process that answers control requests only (``get_usage``); never runs a turn and
    never writes a transcript."""
    return [
        *binary,
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--strict-mcp-config",
    ]


def scrub_env(base: Mapping[str, str]) -> dict[str, str]:
    env = {k: v for k, v in base.items() if k not in SCRUBBED_ENV}
    env["CLAUDE_CODE_ENTRYPOINT"] = ENTRYPOINT
    return env
