"""Parse git remote URLs and match them to hosting accounts.

Supported forms::

    https://github.com/owner/repo(.git)          http(s) with optional user:token@ and port
    git@github.com:owner/repo.git                scp-like ssh
    ssh://git@gitlab.example.com:2222/group/sub/project.git
    git://host/owner/repo.git

GitLab paths may have nested groups (``group/sub/project``). GitHub paths are exactly
``owner/repo``. Self-hosted GitLab under a relative URL root (``https://host/gitlab/...``) is
matched against the account's server address.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlsplit

from aistudio.contracts.git_hosting import HostingKind
from aistudio.core.errors import ValidationFailed

_SCP_RE = re.compile(r"^(?:(?P<user>[^@/\s]+)@)?(?P<host>[A-Za-z0-9.\-]+):(?P<path>[^\s]+)$")
_ALLOWED_SCHEMES = frozenset({"http", "https", "ssh", "git", "git+ssh", "ssh+git"})
# Hosts that serve the same repos under another name (SSH over 443 and friends).
_HOST_ALIASES = {
    "ssh.github.com": "github.com",
    "www.github.com": "github.com",
    "altssh.gitlab.com": "gitlab.com",
    "www.gitlab.com": "gitlab.com",
}


@dataclass(frozen=True)
class RemoteLocation:
    scheme: str  # https | http | ssh | git | scp
    host: str  # lowercase, without port
    port: int | None
    path: str  # "owner/repo" or "group/sub/project" (no .git, no surrounding slashes)

    @property
    def segments(self) -> list[str]:
        return self.path.split("/")


def _clean_path(path: str) -> str:
    path = path.strip().strip("/")
    if path.endswith(".git"):
        path = path[:-4]
    segments = [s for s in path.split("/") if s]
    if any(s in (".", "..") for s in segments):
        return ""
    return "/".join(segments)


def parse_remote_url(url: str | None) -> RemoteLocation | None:
    """Return the host and repository path of a git remote URL, or ``None`` if unsupported."""
    if not url:
        return None
    url = url.strip()
    if "://" in url:
        parts = urlsplit(url)
        scheme = parts.scheme.lower()
        if scheme not in _ALLOWED_SCHEMES:
            return None
        host = (parts.hostname or "").lower()
        try:
            port = parts.port
        except ValueError:
            return None
        path = parts.path
        if scheme in ("git+ssh", "ssh+git"):
            scheme = "ssh"
    else:
        m = _SCP_RE.match(url)
        if m is None or "/" in m["host"]:
            return None
        scheme, host, port, path = "scp", m["host"].lower(), None, m["path"]
    path = _clean_path(path)
    if not host or not path or "/" not in path:
        return None
    return RemoteLocation(scheme=scheme, host=_HOST_ALIASES.get(host, host), port=port, path=path)


# --------------------------------------------------------------------------- accounts


def normalize_api_url(kind: HostingKind, raw: str | None) -> tuple[str, str]:
    """Return ``(api_url, web_url)`` from a server address or API URL typed by the user."""
    value = (raw or "").strip().rstrip("/")
    if not value:
        return (
            ("https://api.github.com", "https://github.com")
            if kind == "github"
            else (
                "https://gitlab.com/api/v4",
                "https://gitlab.com",
            )
        )
    if "://" not in value:
        value = "https://" + value
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValidationFailed("Geçersiz sunucu adresi.", details={"api_url": raw})
    host = parts.hostname.lower()
    netloc = parts.netloc.lower().rsplit("@", 1)[-1]
    path = parts.path.rstrip("/")
    if kind == "github":
        if host in ("github.com", "api.github.com", "www.github.com"):
            return "https://api.github.com", "https://github.com"
        base_path = path[: -len("/api/v3")] if path.endswith("/api/v3") else path
        web = f"{parts.scheme}://{netloc}{base_path}"
        return f"{web}/api/v3", web
    base_path = path[: -len("/api/v4")] if path.endswith("/api/v4") else path
    web = f"{parts.scheme}://{netloc}{base_path}"
    return f"{web}/api/v4", web


class AccountLike(Protocol):
    @property
    def kind(self) -> HostingKind: ...
    @property
    def web_url(self) -> str: ...


def web_host_and_prefix(web_url: str) -> tuple[str, str]:
    parts = urlsplit(web_url)
    return (parts.hostname or "").lower(), parts.path.strip("/")


def slug_for_account(loc: RemoteLocation, account: AccountLike) -> str | None:
    """The repo slug if ``loc`` belongs to ``account``'s server, else ``None``."""
    host, prefix = web_host_and_prefix(account.web_url)
    if _HOST_ALIASES.get(host, host) != loc.host:
        return None
    path = loc.path
    if prefix and loc.scheme in ("http", "https") and path.startswith(prefix + "/"):
        path = path[len(prefix) + 1 :]
    segments = path.split("/")
    if account.kind == "github" and len(segments) != 2:
        return None
    if account.kind == "gitlab" and len(segments) < 2:
        return None
    return path


def match_account[A: AccountLike](loc: RemoteLocation, accounts: list[A]) -> tuple[A, str] | None:
    """First account (in the given order) whose server hosts ``loc``."""
    for account in accounts:
        slug = slug_for_account(loc, account)
        if slug is not None:
            return account, slug
    return None
