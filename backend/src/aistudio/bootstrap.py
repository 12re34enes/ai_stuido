"""Build the application context and app. Shared by ``__main__`` and tests."""

from __future__ import annotations

import sys

from fastapi import FastAPI

from aistudio.api.app import create_app, load_modules
from aistudio.api.auth import load_or_create_token
from aistudio.core.config import Settings
from aistudio.core.context import AppContext
from aistudio.core.eventlog import EventLog
from aistudio.core.module import Module
from aistudio.core.settings_store import SettingsStore
from aistudio.security.masking import Masker
from aistudio.security.secrets import KeyringSecretStore, MemorySecretStore, SecretStore
from aistudio.storage import tables as _core_tables  # noqa: F401  (registers core tables)
from aistudio.storage.db import Database


def build_context(
    settings: Settings, *, secrets: SecretStore | None = None, masker: Masker | None = None, db_path: str | None = None
) -> AppContext:
    settings.paths.ensure()
    masker = masker or Masker()
    if secrets is None:
        secrets = KeyringSecretStore(masker) if sys.platform == "darwin" else MemorySecretStore(masker)
    db = Database.open(db_path or settings.paths.db)
    return AppContext(
        settings=settings, db=db, events=EventLog(db, masker), masker=masker, secrets=secrets, store=SettingsStore(db)
    )


def build_app(ctx: AppContext, *, modules: list[Module] | None = None, token: str | None = None) -> tuple[FastAPI, str]:
    """Module setup, table creation and start happen in the app lifespan (on the server loop)."""
    mods = modules if modules is not None else load_modules()
    token = token or load_or_create_token(ctx.settings, ctx.secrets)
    return create_app(ctx, token, mods), token
