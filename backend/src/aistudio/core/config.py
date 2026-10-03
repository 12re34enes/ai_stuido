"""Runtime configuration and on-disk layout.

All state lives under one data directory. On macOS that is
``~/Library/Application Support/AI Studio``; it can be overridden with the
``AISTUDIO_HOME`` environment variable (used by tests and ``make dev``).
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

APP_NAME = "AI Studio"
DEFAULT_PORT = 0  # 0 = pick a free port; the chosen port is written to runtime.json


def default_home() -> Path:
    override = os.environ.get("AISTUDIO_HOME")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "aistudio"


@dataclass(frozen=True)
class Paths:
    home: Path

    @property
    def db(self) -> Path:
        return self.home / "studio.db"

    @property
    def runtime_file(self) -> Path:
        """Written by studiod at startup: {"port": int, "pid": int}. The token is NOT stored here."""
        return self.home / "runtime.json"

    @property
    def workspaces(self) -> Path:
        return self.home / "workspaces"

    def workspace_dir(self, slug: str) -> Path:
        return self.workspaces / slug

    def memory_dir(self, slug: str) -> Path:
        return self.workspace_dir(slug) / "memory"

    @property
    def worktrees(self) -> Path:
        return self.home / "worktrees"

    @property
    def checkpoints(self) -> Path:
        return self.home / "checkpoints"

    @property
    def backups(self) -> Path:
        return self.home / "backups"

    @property
    def logs(self) -> Path:
        return self.home / "logs"

    @property
    def blobs(self) -> Path:
        """Large payloads (long command output, screenshots) referenced from events."""
        return self.home / "blobs"

    def ensure(self) -> None:
        for p in (self.home, self.workspaces, self.worktrees, self.checkpoints, self.backups, self.logs, self.blobs):
            p.mkdir(parents=True, exist_ok=True)


@dataclass(frozen=True)
class Settings:
    paths: Paths
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    dev: bool = False
    # Fixed token for development only (``make dev``); production uses a Keychain-held token.
    dev_token: str | None = None
    allowed_origins: tuple[str, ...] = field(
        default=("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost")
    )

    @classmethod
    def from_env(cls) -> Settings:
        dev = os.environ.get("AISTUDIO_DEV") == "1"
        origins: tuple[str, ...] = ("tauri://localhost", "http://tauri.localhost", "https://tauri.localhost")
        if dev:
            origins = (*origins, "http://localhost:1420", "http://127.0.0.1:1420")
        return cls(
            paths=Paths(default_home()),
            port=int(os.environ.get("AISTUDIO_PORT", DEFAULT_PORT)),
            dev=dev,
            dev_token=os.environ.get("AISTUDIO_DEV_TOKEN") if dev else None,
            allowed_origins=origins,
        )
