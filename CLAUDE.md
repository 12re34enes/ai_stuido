# AI Studio — contributor guide (humans and agents)

Product spec: `docs/sartname.md` (Turkish, authoritative). Original plan: `docs/plan.md`.

## Layout

```
backend/                 studiod — Python 3.13, uv, FastAPI, SQLite (SQLAlchemy Core async)
  src/aistudio/
    core/                foundation: config, ids, events, eventlog, context, services, settings_store, proc, text
    storage/             db.py (shared `metadata`, UTCDateTime, json_col), tables.py (core tables)
    security/            masking.py (Masker), secrets.py (Keychain SecretStore)
    api/                 app factory, auth, websocket event stream
    contracts/           cross-module models + service Protocols (THE integration surface)
    workspaces/ approvals/ tools/      foundation modules
    agents/ limits/ adapters/claude/ adapters/codex/ gitops/ memory/ engine/
    studios/ remote/ deploy/ git_hosting/ alerts/ backup/   feature modules
  tests/                 tests/<module>/test_*.py per module; conftest.py has ctx/app_ctx/git_repo fixtures
apps/desktop/            Tauri 2 + React 19 + TypeScript + Vite + Tailwind v4 + Motion
scripts/verify/          real-CLI verification scripts run on the user's Mac
fixtures/                recorded (masked) CLI streams used by fake CLIs in tests
studios/                 built-in studio templates (YAML)
```

## Commands

```
cd backend && uv sync                      # install
cd backend && uv run pytest -q             # all backend tests
cd backend && uv run pytest tests/<module> # one module
cd backend && uv run ruff check src tests && uv run ruff format src tests
cd backend && uv run pyright               # must stay at 0 errors
cd apps/desktop && pnpm install && pnpm typecheck && pnpm lint && pnpm test
```

## Language

- **User-facing text is Turkish** (UI strings, error messages in `StudioError`, approval titles,
  alert texts, labels like `LimitWindow.label`). Use correct Turkish characters (ç ğ ı İ ö ş ü).
- Code, identifiers, comments, commit messages, logs: English.

## Backend conventions

- **Modules**: each package has `module.py` exposing `module = <Module subclass>()` (see
  `core/module.py`). `setup(ctx)` registers services/tools and imports the module's `tables.py`;
  `router()` returns an `APIRouter` (mounted under `/api`, use prefix `/<module>`); `start(ctx)`
  launches background work with `ctx.spawn(...)`; `stop()` cleans up. Constructors take no args.
- **Cross-module calls go only through `aistudio.contracts`**: register with
  `ctx.services.register(Protocol, impl)`, consume with `ctx.services.get(Protocol)` at call time
  (not in `setup`, other modules may not be set up yet). Never import another feature module's
  internals.
- **Contracts are shared**: don't change `contracts/*`, `core/*`, `storage/*`, `security/*`, `api/*`,
  `modules.py`, `pyproject.toml` from a feature workstream. If a contract truly must change, make the
  smallest additive change (new optional field / new method) and call it out explicitly in your report.
- **Tables**: declare in `<module>/tables.py` against `aistudio.storage.db.metadata`, import that file
  in `setup`. Prefix table names with the module (`engine_tasks`, `remote_hosts`). Timestamps use
  `UTCDateTime` and `aistudio.core.clock.utcnow()`. JSON via `json_col`. IDs via
  `aistudio.core.ids.new_id("<prefix>")`.
- **Events**: every meaningful state change is appended to `ctx.events` (see `core/events.py::ET` for
  shared types; module-specific types use the module's prefix). Payloads must be JSON-serializable and
  small; large blobs go to `ctx.settings.paths.blobs`. Token deltas use `publish_ephemeral`.
- **Errors**: raise `aistudio.core.errors` subclasses with Turkish messages; the API maps them.
- **Secrets**: only via `ctx.secrets` (Keychain). Store refs (`secret_ref(...)`) in tables, never values.
  Anything leaving a process (events, logs, alerts, command output) is masked by `ctx.masker`.
- **Async everywhere**; subprocesses via `aistudio.core.proc` or a `Transport`. No blocking calls on
  the event loop for anything slow (wrap with `asyncio.to_thread`).
- **Approvals**: any decision point goes through `ApprovalService` (`contracts/approvals.py`).
  Production approvals are restricted to app channels by the service itself.
- **Tests**: required for every module, in `backend/tests/<module>/`. No network, no real CLIs, no real
  Keychain: use fakes (fake CLI scripts, `MemorySecretStore`, local git repos in tmp_path, `respx` for
  HTTP). Keep the suite fast. `ruff` and `pyright` must pass.

## Frontend conventions

- Design tokens live in `src/styles/tokens.css` and are exposed to Tailwind in `src/styles/index.css`
  (`bg-canvas`, `bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`, `bg-claude-soft`,
  `text-codex`, `bg-env-production`...). Never hardcode colors.
- Motion values come only from `src/motion/tokens.ts` (springs, durations, easings, variants).
  Animate transform/opacity only. Every state change animates; nothing pops in.
- Fonts: system (`font-serif` = New York for headings, SF Pro body, SF Mono code). No font files.
- Shared components live in `src/ui/`; app chrome in `src/shell/`; each feature in
  `src/features/<name>/` with its own Turkish strings file. API calls via `src/lib/api.ts`, live
  events via `src/lib/events.ts`, formatting via `src/i18n/format.ts`.

## Git

- Small, focused commits with clear English messages. Don't commit generated or local runtime files.
