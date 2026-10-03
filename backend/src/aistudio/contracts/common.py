from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel

Provider = Literal["claude", "codex"]
PROVIDERS: tuple[Provider, ...] = ("claude", "codex")


class Environment(StrEnum):
    local = "local"
    test = "test"
    production = "production"


class PermissionLevel(StrEnum):
    read = "read"  # Salt okuma
    limited = "limited"  # Sınırlı yazma
    full = "full"  # Tam yetki


class Location(BaseModel):
    """Where something runs: on this Mac, or on a registered SSH host."""

    kind: Literal["local", "remote"] = "local"
    host_id: str | None = None

    @classmethod
    def local(cls) -> Location:
        return cls()

    @classmethod
    def remote(cls, host_id: str) -> Location:
        return cls(kind="remote", host_id=host_id)


def other_provider(p: Provider) -> Provider:
    return "codex" if p == "claude" else "claude"
