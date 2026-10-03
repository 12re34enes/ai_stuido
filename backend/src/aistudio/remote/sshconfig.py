"""Minimal OpenSSH client config parser for importing hosts (spec §12).

Supports ``Host`` blocks with patterns and negation, ``Include`` (globs, relative to
``~/.ssh``), first-value-wins semantics including ``Host *`` defaults, and the options we
import: HostName, User, Port, IdentityFile, ProxyJump. ``Match`` blocks are skipped (they
cannot be evaluated without connecting).
"""

from __future__ import annotations

import fnmatch
import getpass
import glob
import shlex
from dataclasses import dataclass, field
from pathlib import Path

_WANTED = {"hostname", "user", "port", "identityfile", "proxyjump"}


@dataclass
class SshConfigEntry:
    alias: str
    hostname: str
    user: str | None = None
    port: int = 22
    identity_file: str | None = None
    proxy_jump: str | None = None  # first hop only: "alias" or "[user@]host[:port]"


@dataclass
class _Block:
    patterns: list[str] | None  # None = applies to every host (options before the first Host)
    match: bool = False
    options: list[tuple[str, str]] = field(default_factory=list)


def _split(line: str) -> tuple[str, str] | None:
    line = line.strip()
    if not line or line.startswith("#"):
        return None
    if "=" in line.split(None, 1)[0]:
        key, _, value = line.partition("=")
    else:
        parts = line.split(None, 1)
        key, value = parts[0], (parts[1] if len(parts) > 1 else "")
    key, value = key.strip().lower(), value.strip().lstrip("=").strip()
    if len(value) >= 2 and value[0] == value[-1] == '"':
        value = value[1:-1]
    return key, value


def _parse(text: str, base_dir: Path, blocks: list[_Block], depth: int) -> None:
    current = blocks[-1]
    for raw in text.splitlines():
        parsed = _split(raw)
        if parsed is None:
            continue
        key, value = parsed
        if key == "host":
            try:
                patterns = shlex.split(value)
            except ValueError:
                patterns = value.split()
            current = _Block(patterns=patterns)
            blocks.append(current)
        elif key == "match":
            current = _Block(patterns=[], match=True)
            blocks.append(current)
        elif key == "include" and depth < 5:
            for item in value.split():
                pattern = str(Path(item).expanduser())
                if not Path(pattern).is_absolute():
                    pattern = str(base_dir / pattern)
                for path in sorted(glob.glob(pattern)):
                    try:
                        content = Path(path).read_text(errors="replace")
                    except OSError:
                        continue
                    _parse(content, base_dir, blocks, depth + 1)
            current = blocks[-1]
        elif key in _WANTED:
            current.options.append((key, value))


def _matches(alias: str, patterns: list[str]) -> bool:
    positive = False
    for p in patterns:
        negated = p.startswith("!")
        if fnmatch.fnmatchcase(alias.lower(), p.lstrip("!").lower()):
            if negated:
                return False
            positive = True
    return positive


def _is_concrete(pattern: str) -> bool:
    return not any(c in pattern for c in "*?!")


def _expand(value: str, *, alias: str, hostname: str, user: str | None, home: Path) -> str:
    local_user = _local_user()
    out = []
    i = 0
    while i < len(value):
        c = value[i]
        if c == "%" and i + 1 < len(value):
            token = value[i + 1]
            out.append(
                {
                    "%": "%",
                    "d": str(home),
                    "u": local_user,
                    "h": hostname,
                    "n": alias,
                    "r": user or local_user,
                }.get(token, "%" + token)
            )
            i += 2
            continue
        out.append(c)
        i += 1
    expanded = "".join(out)
    if expanded == "~" or expanded.startswith("~/"):
        expanded = str(home) + expanded[1:]
    return expanded


def _local_user() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return "root"


def parse_ssh_config(text: str, *, base_dir: Path | None = None, home: Path | None = None) -> list[SshConfigEntry]:
    """Return one entry per concrete ``Host`` alias, in file order."""
    home = home or Path.home()
    base_dir = base_dir or home / ".ssh"
    blocks: list[_Block] = [_Block(patterns=None)]
    _parse(text, base_dir, blocks, 0)
    aliases: list[str] = []
    for b in blocks:
        if b.patterns and not b.match:
            for p in b.patterns:
                if _is_concrete(p) and p not in aliases:
                    aliases.append(p)
    entries: list[SshConfigEntry] = []
    for alias in aliases:
        opts: dict[str, str] = {}
        for b in blocks:
            if b.match:
                continue
            if b.patterns is not None and not _matches(alias, b.patterns):
                continue
            for key, value in b.options:
                opts.setdefault(key, value)
        hostname = opts.get("hostname", alias).replace("%h", alias)
        user = opts.get("user")
        try:
            port = int(opts.get("port", "22"))
        except ValueError:
            port = 22
        identity = opts.get("identityfile")
        if identity:
            identity = _expand(identity, alias=alias, hostname=hostname, user=user, home=home)
        raw_jump = opts.get("proxyjump")
        jump = raw_jump.split(",")[0].strip() if raw_jump and raw_jump.lower() != "none" else None
        entries.append(
            SshConfigEntry(
                alias=alias, hostname=hostname, user=user, port=port, identity_file=identity, proxy_jump=jump
            )
        )
    return entries


def parse_jump(spec: str) -> tuple[str | None, str, int]:
    """``[user@]host[:port]`` -> (user, host, port). IPv6 may be bracketed: ``[::1]:2222``."""
    user: str | None = None
    if "@" in spec:
        user, _, spec = spec.rpartition("@")
    port = 22
    if spec.startswith("["):
        host, _, rest = spec[1:].partition("]")
        if rest.startswith(":") and rest[1:].isdigit():
            port = int(rest[1:])
        return user, host, port
    if spec.count(":") == 1:
        host, _, p = spec.partition(":")
        if p.isdigit():
            return user, host, int(p)
    return user, spec, port
