"""FastAPI application factory and lifecycle."""

from __future__ import annotations

import importlib
import logging
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from typing import Any

from fastapi import APIRouter, FastAPI, Request, Response, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from aistudio import __version__
from aistudio.api.auth import request_token, token_ok, websocket_token
from aistudio.api.ws import stream_events
from aistudio.core.context import AppContext
from aistudio.core.errors import StudioError
from aistudio.core.events import Event, EventFilter
from aistudio.core.module import Module
from aistudio.modules import MODULES

log = logging.getLogger("aistudio.api")


def load_modules(paths: tuple[str, ...] = MODULES) -> list[Module]:
    modules: list[Module] = []
    for path in paths:
        mod = importlib.import_module(f"{path}.module")
        instance = getattr(mod, "module", None)
        if not isinstance(instance, Module):
            raise RuntimeError(f"{path}.module must define `module = <Module subclass>()`")
        # Fresh instance per app so module state never leaks between apps (tests, restarts).
        modules.append(type(instance)())
    return modules


class SystemInfo(BaseModel):
    version: str
    modules: list[str]
    dev: bool
    last_event_id: int


class EventsPage(BaseModel):
    events: list[Event]
    has_more: bool


def create_app(ctx: AppContext, token: str, modules: list[Module] | None = None) -> FastAPI:
    mods = modules if modules is not None else load_modules()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # setup -> create tables -> start. Everything runs on the server's event loop.
        await setup_modules(ctx, mods)
        await ctx.db.create_all()
        for m in mods:
            await m.start(ctx)
        log.info("studiod ready (%d modules)", len(mods))
        try:
            yield
        finally:
            for m in reversed(mods):
                try:
                    await m.stop()
                except Exception:
                    log.exception("module %s failed to stop", m.name)
            await ctx.shutdown_tasks()
            await ctx.db.close()

    app = FastAPI(
        title="AI Studio",
        version=__version__,
        lifespan=lifespan,
        docs_url="/api/docs" if ctx.settings.dev else None,
        openapi_url="/api/openapi.json",
    )
    app.state.ctx = ctx

    @app.middleware("http")
    async def auth_and_origin(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        origin = request.headers.get("origin")
        cors_headers: dict[str, str] = {}
        if origin and origin in ctx.settings.allowed_origins:
            cors_headers = {
                "access-control-allow-origin": origin,
                "access-control-allow-credentials": "true",
                "access-control-allow-headers": "authorization, content-type",
                "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "vary": "origin",
            }
        elif origin:
            return JSONResponse({"error": {"code": "bad_origin", "message": "Origin not allowed"}}, 403)
        if request.method == "OPTIONS":
            return Response(status_code=204, headers=cors_headers)
        public = request.url.path in ("/health",) or (
            ctx.settings.dev and request.url.path.startswith(("/api/docs", "/api/openapi.json"))
        )
        if not public and not token_ok(token, request_token(request)):
            return JSONResponse({"error": {"code": "unauthorized", "message": "Yetkisiz"}}, 401, headers=cors_headers)
        response = await call_next(request)
        response.headers.update(cors_headers)
        return response

    @app.exception_handler(StudioError)
    async def studio_error(_: Request, exc: StudioError) -> JSONResponse:
        return JSONResponse(
            {"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
            status_code=exc.status_code,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            {
                "error": {
                    "code": "validation_failed",
                    "message": "Geçersiz istek",
                    "details": {"errors": _jsonable_errors(exc.errors())},
                }
            },
            status_code=422,
        )

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": __version__}

    api = APIRouter(prefix="/api")

    @api.get("/system", response_model=SystemInfo, tags=["system"])
    async def system_info() -> SystemInfo:
        return SystemInfo(
            version=__version__,
            modules=[m.name for m in mods],
            dev=ctx.settings.dev,
            last_event_id=await ctx.events.last_id(),
        )

    @api.get("/events", response_model=EventsPage, tags=["events"])
    async def list_events(
        workspace_id: str | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        session_id: str | None = None,
        types: str | None = None,
        after_id: int | None = None,
        before_id: int | None = None,
        limit: int = 500,
        descending: bool = False,
    ) -> EventsPage:
        limit = max(1, min(limit, 5000))
        flt = EventFilter(
            workspace_id=workspace_id,
            task_id=task_id,
            run_id=run_id,
            session_id=session_id,
            types=[t for t in types.split(",") if t] if types else None,
        )
        rows = await ctx.events.query(
            flt, after_id=after_id, before_id=before_id, limit=limit + 1, descending=descending
        )
        return EventsPage(events=rows[:limit], has_more=len(rows) > limit)

    @api.get("/events/verify", tags=["events"])
    async def verify_events() -> dict[str, Any]:
        ok, bad = await ctx.events.verify_chain()
        return {"ok": ok, "first_bad_id": bad}

    @api.get("/settings", tags=["settings"])
    async def get_settings() -> dict[str, Any]:
        return await ctx.store.all()

    @api.put("/settings/{key}", tags=["settings"])
    async def put_setting(key: str, body: dict[str, Any]) -> dict[str, Any]:
        await ctx.store.set(key, body.get("value"))
        await ctx.events.append("settings.changed", {"key": key}, actor="user")
        return {"key": key, "value": body.get("value")}

    for m in mods:
        router = m.router()
        if router is not None:
            api.include_router(router)
    app.include_router(api)

    @app.websocket("/ws/events")
    async def ws_events(ws: WebSocket) -> None:
        origin = ws.headers.get("origin")
        if (origin and origin not in ctx.settings.allowed_origins) or not token_ok(token, websocket_token(ws)):
            await ws.close(code=4401)
            return
        await ws.accept()
        await stream_events(ws, ctx.events)

    # Modules may also expose websocket routes on their router; mount extra apps here if needed.
    return app


def _jsonable_errors(errors: Sequence[Any]) -> list[dict[str, Any]]:
    """Pydantic puts the raised exception object in ``ctx`` (e.g. a validator's ValueError),
    which is not JSON serializable; stringify anything that isn't plain data."""
    out: list[dict[str, Any]] = []
    for err in errors:
        item = dict(err)
        ctx = item.get("ctx")
        if isinstance(ctx, dict):
            item["ctx"] = {
                k: v if isinstance(v, str | int | float | bool | type(None)) else str(v) for k, v in ctx.items()
            }
        item.pop("url", None)
        if "input" in item and not isinstance(item["input"], str | int | float | bool | list | dict | type(None)):
            item["input"] = str(item["input"])
        out.append(item)
    return out


async def setup_modules(ctx: AppContext, modules: list[Module]) -> None:
    for m in modules:
        await m.setup(ctx)
