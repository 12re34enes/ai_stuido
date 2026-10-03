"""Studio tool registry and per-session binding."""

from __future__ import annotations

import logging
from typing import Any

from aistudio.contracts.tools import StudioTool, ToolContext, ToolResult, ToolSpec
from aistudio.core.errors import NotFound, StudioError
from aistudio.core.eventlog import EventLog

log = logging.getLogger(__name__)


class ToolRegistryImpl:
    def __init__(self, events: EventLog) -> None:
        self._tools: dict[str, StudioTool] = {}
        self._events = events

    def register(self, tool: StudioTool) -> None:
        name = tool.spec.name
        if name in self._tools:
            raise RuntimeError(f"tool {name} registered twice")
        self._tools[name] = tool

    def get(self, name: str) -> StudioTool:
        try:
            return self._tools[name]
        except KeyError:
            raise NotFound(f"Araç bulunamadı: {name}") from None

    def all_specs(self) -> list[ToolSpec]:
        return [t.spec for t in self._tools.values()]

    def bind(self, ctx: ToolContext, names: list[str] | None = None, *, allow_mutating: bool = True) -> BoundToolHost:
        selected = [
            t
            for n, t in self._tools.items()
            if (names is None or n in names) and (allow_mutating or not t.spec.mutating)
        ]
        return BoundToolHost(ctx, {t.spec.name: t for t in selected}, self._events)


class BoundToolHost:
    def __init__(self, ctx: ToolContext, tools: dict[str, StudioTool], events: EventLog) -> None:
        self._ctx = ctx
        self._tools = tools
        self._events = events

    def specs(self) -> list[ToolSpec]:
        return [t.spec for t in self._tools.values()]

    async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
        tool = self._tools.get(name)
        if tool is None:
            return ToolResult(content=f"Unknown or not permitted tool: {name}", is_error=True)
        try:
            result = await tool(self._ctx, args)
        except StudioError as e:
            result = ToolResult(content=e.message, is_error=True, data={"code": e.code, **e.details})
        except Exception as e:  # tool bugs must not kill the agent session
            log.exception("studio tool %s failed", name)
            result = ToolResult(content=f"Tool error: {e}", is_error=True)
        await self._events.append(
            "tool.called",
            {
                "tool": name,
                "args": args,
                "is_error": result.is_error,
                "content": result.content[:4000],
                "data": result.data,
            },
            actor=f"agent:{self._ctx.session_id}",
            workspace_id=self._ctx.workspace_id,
            task_id=self._ctx.task_id,
            run_id=self._ctx.run_id,
            session_id=self._ctx.session_id,
        )
        return result
