"""Strict host key checking against the user's ``~/.ssh/known_hosts`` plus an app-managed
``<home>/known_hosts``. Keys are only ever added to the app file, after the user confirmed the
fingerprint (``POST /api/remote/hosts/{id}/trust``)."""

from __future__ import annotations

import os
import threading
from collections.abc import Callable
from pathlib import Path

import asyncssh


def _default_user_file() -> Path:
    return Path.home() / ".ssh" / "known_hosts"


def host_pattern(hostname: str, port: int) -> str:
    return hostname if port == 22 else f"[{hostname}]:{port}"


def fingerprint(key: asyncssh.SSHKey) -> str:
    return key.get_fingerprint("sha256")


def _same_key(a: asyncssh.SSHKey, b: asyncssh.SSHKey) -> bool:
    return a.public_data == b.public_data


class KnownHostsStore:
    def __init__(self, app_file: Path, user_file: Callable[[], Path] = _default_user_file) -> None:
        self.app_file = app_file
        self._user_file = user_file
        self._lock = threading.Lock()

    def files(self) -> list[Path]:
        return [p for p in (self._user_file(), self.app_file) if p.is_file()]

    def load(self) -> asyncssh.SSHKnownHosts:
        chunks: list[str] = []
        for path in self.files():
            try:
                chunks.append(path.read_text(errors="replace"))
            except OSError:
                continue
        return asyncssh.import_known_hosts("\n".join(chunks))

    def trusted(self, hostname: str, port: int, addr: str = "") -> tuple[list[asyncssh.SSHKey], list[asyncssh.SSHKey]]:
        """(trusted host + CA keys, revoked keys) for this host."""
        result = self.load().match(hostname, addr, port if port != 22 else None)
        return [*result[0], *result[1]], list(result[2])

    def is_trusted(self, hostname: str, port: int, key: asyncssh.SSHKey, addr: str = "") -> bool:
        trusted, revoked = self.trusted(hostname, port, addr)
        if any(_same_key(key, r) for r in revoked):
            return False
        return any(_same_key(key, t) for t in trusted)

    def is_revoked(self, hostname: str, port: int, key: asyncssh.SSHKey, addr: str = "") -> bool:
        _, revoked = self.trusted(hostname, port, addr)
        return any(_same_key(key, r) for r in revoked)

    def add(self, hostname: str, port: int, key: asyncssh.SSHKey, *, replace: bool = False) -> None:
        pattern = host_pattern(hostname, port)
        key_text = " ".join(key.export_public_key("openssh").decode().split()[:2])
        line = f"{pattern} {key_text}"
        with self._lock:
            lines: list[str] = []
            if self.app_file.is_file():
                lines = self.app_file.read_text(errors="replace").splitlines()
            if replace:
                lines = [ln for ln in lines if pattern not in (ln.split(None, 1)[0].split(",") if ln.strip() else [])]
            if line not in lines:
                lines.append(line)
            self.app_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.app_file.with_name(self.app_file.name + ".tmp")
            tmp.write_text("\n".join(lines) + "\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.app_file)
