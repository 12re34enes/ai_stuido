# AI Studio developer commands. Run `make help`.
DEV_HOME  := $(CURDIR)/.aistudio-dev
DEV_PORT  := 8765
DEV_TOKEN := dev-token
DEV_ENV   := AISTUDIO_HOME=$(DEV_HOME) AISTUDIO_DEV=1 AISTUDIO_DEV_TOKEN=$(DEV_TOKEN) AISTUDIO_PORT=$(DEV_PORT)

.PHONY: help setup dev dev-backend dev-web dev-app test test-backend test-web lint typecheck check check-secrets verify-clis demo demo-backend

help:
	@echo "make setup         install backend (uv) and frontend (pnpm) dependencies"
	@echo "make dev           run studiod + web UI (browser at http://localhost:1420)"
	@echo "make dev-app       run the Tauri desktop app in dev mode (macOS)"
	@echo "make demo          explore the UI with sample data and fake CLIs (no quota, no login)"
	@echo "make check         lint + typecheck + tests (backend and frontend)"
	@echo "make verify-clis   verify real Claude Code / Codex CLIs on this Mac (uses a little quota)"

setup:
	cd backend && uv sync
	pnpm install

dev-backend:
	cd backend && $(DEV_ENV) uv run studiod serve

dev-web:
	AISTUDIO_PORT=$(DEV_PORT) AISTUDIO_DEV_TOKEN=$(DEV_TOKEN) pnpm --filter desktop dev

dev:
	@trap 'kill 0' EXIT; $(MAKE) dev-backend & $(MAKE) dev-web & wait

dev-app:
	@trap 'kill 0' EXIT; $(MAKE) dev-backend & (cd apps/desktop && AISTUDIO_PORT=$(DEV_PORT) AISTUDIO_DEV_TOKEN=$(DEV_TOKEN) pnpm tauri dev) & wait

demo-backend:
	cd backend && uv run python ../scripts/dev/demo_server.py

demo:
	@trap 'kill 0' EXIT; $(MAKE) demo-backend & (sleep 3; $(MAKE) dev-web) & wait

test-backend:
	cd backend && uv run pytest -q

test-web:
	pnpm --filter desktop test

test: test-backend test-web

lint:
	cd backend && uv run ruff check src tests && uv run ruff format --check src tests
	pnpm --filter desktop lint

typecheck:
	cd backend && uv run pyright
	pnpm --filter desktop typecheck

check-secrets:
	python3 scripts/dev/check_secrets.py

check: check-secrets lint typecheck test

verify-clis:
	cd backend && uv run python ../scripts/verify/claude/verify_claude.py
	cd backend && uv run python ../scripts/verify/codex/verify_codex.py
