"""argv, --settings, --mcp-config and environment generation from SessionSpec/Boundaries."""

from __future__ import annotations

import json

from aistudio.adapters.claude.config import (
    LaunchOptions,
    build_argv,
    build_mcp_config,
    build_settings,
    disallowed_tools,
    is_read_only,
    probe_argv,
    scrub_env,
)
from aistudio.contracts.agents import Boundaries, SandboxLevel, SessionSpec


def _spec(**kw: object) -> SessionSpec:
    return SessionSpec.model_validate({"provider": "claude", "cwd": "/repo", **kw})


def _flag(argv: list[str], flag: str) -> str:
    return argv[argv.index(flag) + 1]


def test_settings_from_boundaries() -> None:
    b = Boundaries(
        forbidden_paths=["secrets/**", "/.env"],
        readonly_paths=["migrations/**"],
        allowed_commands=["npm test", "git status *"],
        denied_commands=["ssh", "rm -rf *"],
        network=False,
    )
    settings = build_settings(b, read_only=False)
    perms = settings["permissions"]
    assert perms["deny"] == [
        "Read(secrets/**)",
        "Edit(secrets/**)",
        "Write(secrets/**)",
        "Read(./.env)",
        "Edit(./.env)",
        "Write(./.env)",
        "Edit(migrations/**)",
        "Write(migrations/**)",
        "Bash(ssh)",
        "Bash(ssh *)",
        "Bash(rm -rf *)",
        "WebFetch",
        "WebSearch",
    ]
    assert perms["allow"] == ["mcp__studio", "Bash(npm test)", "Bash(npm test *)", "Bash(git status *)"]


def test_default_boundaries_only_allow_studio() -> None:
    settings = build_settings(Boundaries(), read_only=False)
    assert settings == {"permissions": {"allow": ["mcp__studio"], "deny": []}}
    assert disallowed_tools(Boundaries(), read_only=False) == ["AskUserQuestion"]


def test_read_only_roles() -> None:
    assert is_read_only(_spec(role="advisor"))
    assert is_read_only(_spec(boundaries={"sandbox": SandboxLevel.read_only}))
    assert not is_read_only(_spec(role="writer"))
    argv = build_argv(["claude"], _spec(role="advisor", boundaries={"allowed_commands": ["make"]}), session_id="s")
    assert _flag(argv, "--tools") == "Read,Grep,Glob,WebFetch,WebSearch"
    settings = json.loads(_flag(argv, "--settings"))
    assert {"Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"} <= set(settings["permissions"]["deny"])
    assert settings["permissions"]["allow"] == ["mcp__studio"]  # no shell allowances for advisors
    disallowed = _flag(argv, "--disallowedTools").split(",")
    assert "Bash" in disallowed and "AskUserQuestion" in disallowed

    offline = build_argv(["claude"], _spec(role="advisor", boundaries={"network": False}), session_id="s")
    assert _flag(offline, "--tools") == "Read,Grep,Glob"


def test_disallowed_tools_keep_commas_inside_rules() -> None:
    b = Boundaries(denied_commands=["curl *"], forbidden_paths=["a,b/**"])
    argv = build_argv(["claude"], _spec(boundaries=b.model_dump()), session_id="s")
    value = _flag(argv, "--disallowedTools")
    assert value.startswith("Read(a,b/**),Edit(a,b/**),Write(a,b/**),Bash(curl *)")


def test_argv_new_resume_fork() -> None:
    new = build_argv(["/bin/claude"], _spec(), session_id="new-id")
    assert new[0] == "/bin/claude" and new[1] == "-p"
    assert _flag(new, "--session-id") == "new-id" and "--resume" not in new
    assert _flag(new, "--input-format") == "stream-json" and _flag(new, "--output-format") == "stream-json"
    assert _flag(new, "--permission-mode") == "default"
    assert "--strict-mcp-config" in new and "--tools" not in new

    resume = build_argv(["claude"], _spec(resume_native_id="old"), session_id="old")
    assert _flag(resume, "--resume") == "old" and "--session-id" not in resume

    fork = build_argv(["claude"], _spec(resume_native_id="old", fork=True), session_id="forked")
    assert _flag(fork, "--resume") == "old" and _flag(fork, "--session-id") == "forked"
    assert "--fork-session" in fork


def test_argv_optional_flags() -> None:
    argv = build_argv(
        ["claude"],
        _spec(model="opus", effort="xhigh", system_append="  ", extra_dirs=["/a", "/b"]),
        session_id="s",
        options=LaunchOptions(strict_mcp_config=False, setting_sources=["project", "local"], extra_args=["--x"]),
    )
    assert _flag(argv, "--model") == "opus" and _flag(argv, "--effort") == "xhigh"
    assert "--append-system-prompt" not in argv  # blank memory is not passed
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "--add-dir"] == ["/a", "/b"]
    assert "--strict-mcp-config" not in argv
    assert "--setting-sources=project,local" in argv and argv[-1] == "--x"
    bad = build_argv(["claude"], _spec(effort="turbo"), session_id="s")
    assert "--effort" not in bad


def test_mcp_config_declares_studio_sdk_server() -> None:
    spec = _spec(
        mcp_servers={"github": {"type": "stdio", "command": "gh-mcp"}, "studio": {"type": "stdio", "command": "x"}}
    )
    cfg = build_mcp_config(spec, LaunchOptions(studio_tool_timeout_ms=600000))
    assert cfg["mcpServers"]["github"] == {"type": "stdio", "command": "gh-mcp"}
    assert cfg["mcpServers"]["studio"] == {"type": "sdk", "name": "studio", "alwaysLoad": True, "timeout": 600000}
    argv = build_argv(["claude"], spec, session_id="s")
    assert json.loads(_flag(argv, "--mcp-config"))["mcpServers"]["studio"]["type"] == "sdk"


def test_scrub_env() -> None:
    env = scrub_env(
        {
            "PATH": "/bin",
            "HOME": "/h",
            "ANTHROPIC_API_KEY": "x",
            "ANTHROPIC_AUTH_TOKEN": "y",
            "CLAUDECODE": "1",
            "CLAUDE_CODE_ENTRYPOINT": "cli",
            "CLAUDE_CODE_OAUTH_TOKEN": "kept-subscription-token",
        }
    )
    assert env == {
        "PATH": "/bin",
        "HOME": "/h",
        "CLAUDE_CODE_OAUTH_TOKEN": "kept-subscription-token",
        "CLAUDE_CODE_ENTRYPOINT": "sdk-py",
    }


def test_probe_argv_never_persists() -> None:
    argv = probe_argv(["claude"])
    assert "--no-session-persistence" in argv and "--include-partial-messages" not in argv
