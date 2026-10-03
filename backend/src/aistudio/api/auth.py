"""Local API authentication: one bearer token per install.

The token lives in the Keychain (``studiod/api-token``); the Tauri shell reads the same item
and hands it to the webview. ``make dev`` uses a fixed ``AISTUDIO_DEV_TOKEN`` instead.
"""

from __future__ import annotations

import hmac
import secrets as pysecrets

from fastapi import Request, WebSocket

from aistudio.core.config import Settings
from aistudio.security.secrets import SecretStore

TOKEN_REF = "studiod/api-token"


def load_or_create_token(settings: Settings, store: SecretStore) -> str:
    if settings.dev and settings.dev_token:
        return settings.dev_token
    token = store.get(TOKEN_REF)
    if not token:
        token = pysecrets.token_urlsafe(32)
        store.set(TOKEN_REF, token)
    return token


def _extract(headers: dict[str, str], query: dict[str, str]) -> str | None:
    auth = headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return query.get("token")


def token_ok(expected: str, provided: str | None) -> bool:
    return provided is not None and hmac.compare_digest(expected.encode(), provided.encode())


def request_token(request: Request) -> str | None:
    return _extract({k.lower(): v for k, v in request.headers.items()}, dict(request.query_params))


def websocket_token(ws: WebSocket) -> str | None:
    return _extract({k.lower(): v for k, v in ws.headers.items()}, dict(ws.query_params))
