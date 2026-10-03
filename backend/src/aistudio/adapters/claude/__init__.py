"""Claude Code adapter (stream-json + SDK control protocol). See ``PROTOCOL.md``."""

from aistudio.adapters.claude.adapter import ClaudeAdapter
from aistudio.adapters.claude.config import LaunchOptions
from aistudio.adapters.claude.session import ClaudeControlError, ClaudeSession

__all__ = ["ClaudeAdapter", "ClaudeControlError", "ClaudeSession", "LaunchOptions"]
