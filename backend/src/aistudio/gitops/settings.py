"""Settings keys owned by gitops (declared on ``ctx.store`` during setup)."""

from __future__ import annotations

from aistudio.core.settings_store import SettingsStore

RETENTION_HOURS = "gitops.retention_hours"
CONFLICT_POLL_SECONDS = "gitops.conflict_poll_seconds"
CLEANUP_INTERVAL_MINUTES = "gitops.cleanup_interval_minutes"

DEFAULTS: dict[str, float] = {
    RETENTION_HOURS: 72,  # merged/abandoned worktrees are removed after this long
    CONFLICT_POLL_SECONDS: 15,  # full overlap rescan interval (file events trigger sooner)
    CLEANUP_INTERVAL_MINUTES: 60,
}


async def float_setting(store: SettingsStore, key: str) -> float:
    """Numeric setting; falls back to the default when unset or malformed (0 is a valid value)."""
    default = DEFAULTS[key]
    try:
        value = await store.get(key)
        return default if value is None or isinstance(value, bool) else float(value)
    except (TypeError, ValueError):
        return default
