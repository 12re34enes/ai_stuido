"""Secret storage. Secrets live only in the macOS Keychain (via ``keyring``).

The database stores references (``SecretRef``), never values. Every value that passes
through the store is registered with the :class:`Masker` so it can never leak into
events, logs or alerts.

Reference format: ``"<owner>/<id>/<field>"`` e.g. ``"host/host_01J.../password"``.
"""

from __future__ import annotations

import contextlib
from typing import Protocol

from aistudio.security.masking import Masker

KEYRING_SERVICE = "AI Studio"


class SecretStore(Protocol):
    def get(self, ref: str) -> str | None: ...
    def set(self, ref: str, value: str) -> None: ...
    def delete(self, ref: str) -> None: ...


class KeyringSecretStore:
    def __init__(self, masker: Masker, service: str = KEYRING_SERVICE) -> None:
        import keyring

        self._keyring = keyring
        self._masker = masker
        self._service = service

    def get(self, ref: str) -> str | None:
        value = self._keyring.get_password(self._service, ref)
        self._masker.add_secret(value)
        return value

    def set(self, ref: str, value: str) -> None:
        self._masker.add_secret(value)
        self._keyring.set_password(self._service, ref, value)

    def delete(self, ref: str) -> None:
        import keyring.errors

        with contextlib.suppress(keyring.errors.PasswordDeleteError):
            self._keyring.delete_password(self._service, ref)


class MemorySecretStore:
    """In-process store for tests and non-macOS development."""

    def __init__(self, masker: Masker) -> None:
        self._values: dict[str, str] = {}
        self._masker = masker

    def get(self, ref: str) -> str | None:
        value = self._values.get(ref)
        self._masker.add_secret(value)
        return value

    def set(self, ref: str, value: str) -> None:
        self._masker.add_secret(value)
        self._values[ref] = value

    def delete(self, ref: str) -> None:
        self._values.pop(ref, None)


def secret_ref(owner: str, owner_id: str, field: str) -> str:
    return f"{owner}/{owner_id}/{field}"
