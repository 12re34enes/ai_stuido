"""Limit window conversion and the in-process studio MCP server."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from aistudio.adapters.claude.limits import (
    window_label,
    windows_from_rate_limit_event,
    windows_from_usage_response,
)
from aistudio.adapters.claude.mcp import StudioMcpServer
from aistudio.contracts.tools import ToolResult

from .helpers import FakeToolHost

NOW = datetime(2026, 10, 3, 12, 0, tzinfo=UTC)


def test_rate_limit_event_fraction_to_percent() -> None:
    windows = windows_from_rate_limit_event(
        {
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "rejected",
                "resetsAt": 1791000000,
                "rateLimitType": "seven_day_opus",
                "utilization": 1.02,
                "unifiedWindows": {
                    "five_hour": {"utilization": 0.25, "resetsAt": 1790000000},
                    "seven_day": {"utilization": 0.9, "resetsAt": 1791500000},
                },
            },
        },
        observed_at=NOW,
    )
    by = {w.window: w for w in windows}
    assert [w.window for w in windows] == ["five_hour", "seven_day", "seven_day_opus"]
    assert by["five_hour"].used_percent == 25.0 and by["five_hour"].status == "ok"
    assert by["five_hour"].resets_at == datetime.fromtimestamp(1790000000, UTC)
    assert by["five_hour"].window_minutes == 300
    assert by["seven_day"].used_percent == 90.0 and by["seven_day"].status == "warning"
    assert by["seven_day_opus"].used_percent == 100.0 and by["seven_day_opus"].status == "exhausted"
    assert by["seven_day_opus"].label == "Haftalık (Opus)" and by["seven_day_opus"].window_minutes == 10080
    assert all(w.provider == "claude" and w.source == "event" and w.observed_at == NOW for w in windows)


def test_rate_limit_event_minimal_shapes() -> None:
    # only the limiting window, no utilization: an allowed status says nothing measurable
    assert windows_from_rate_limit_event({"rate_limit_info": {"status": "allowed"}}, observed_at=NOW) == []
    assert (
        windows_from_rate_limit_event(
            {"rate_limit_info": {"status": "allowed", "rateLimitType": "five_hour"}}, observed_at=NOW
        )
        == []
    )
    rejected = windows_from_rate_limit_event(
        {"rate_limit_info": {"status": "rejected", "rateLimitType": "five_hour", "resetsAt": 1790000000}},
        observed_at=NOW,
    )
    assert rejected[0].used_percent == 100.0 and rejected[0].status == "exhausted"
    # the info dict itself is accepted too
    direct = windows_from_rate_limit_event(
        {"status": "allowed", "rateLimitType": "seven_day_sonnet", "utilization": 0.5}, observed_at=NOW
    )
    assert direct[0].label == "Haftalık (Sonnet)" and direct[0].used_percent == 50.0


def test_usage_response_percent_scale() -> None:
    windows = windows_from_usage_response(
        {
            "rate_limits_available": True,
            "rate_limits": {
                "five_hour": {"utilization": 37.5, "resets_at": "2026-10-03T15:00:00Z"},
                "seven_day": {"utilization": 100, "resets_at": "2026-10-07T00:00:00+00:00"},
                "seven_day_opus": None,
                "seven_day_sonnet": {"utilization": None, "resets_at": None},
                "model_scoped": [{"display_name": "Fable", "utilization": 82, "resets_at": None}],
            },
        },
        observed_at=NOW,
    )
    by = {w.window: w for w in windows}
    assert set(by) == {"five_hour", "seven_day", "seven_day_model:Fable"}
    assert by["five_hour"].used_percent == 37.5 and by["five_hour"].resets_at == datetime(2026, 10, 3, 15, tzinfo=UTC)
    assert by["seven_day"].status == "exhausted"
    assert by["seven_day_model:Fable"].label == "Haftalık (Fable)" and by["seven_day_model:Fable"].status == "warning"
    assert all(w.source == "probe" for w in windows)
    assert windows_from_usage_response({"rate_limits_available": False, "rate_limits": None}, observed_at=NOW) == []


def test_labels() -> None:
    assert window_label("five_hour") == "5 saat"
    assert window_label("seven_day") == "Haftalık"
    assert window_label("something_new") == "something new"


async def test_mcp_server_protocol() -> None:
    tools = FakeToolHost()
    server = StudioMcpServer(tools)
    init = await server.handle(
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2099-01-01"}}
    )
    assert init is not None and init["result"]["protocolVersion"] == "2025-11-25"
    assert init["result"]["capabilities"] == {"tools": {}}
    assert await server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
    listing = await server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert listing is not None
    names = [t["name"] for t in listing["result"]["tools"]]
    assert names == ["memory_read", "report_status"]
    assert listing["result"]["tools"][0]["inputSchema"]["required"] == ["key"]
    assert listing["result"]["tools"][1]["annotations"] == {"readOnlyHint": False}
    call = await server.handle(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "memory_read", "arguments": {"key": "k"}},
        }
    )
    assert call == {
        "jsonrpc": "2.0",
        "id": 3,
        "result": {"content": [{"type": "text", "text": "memory:k"}], "isError": False},
    }
    bad = await server.handle({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "nope"}})
    assert bad is not None and bad["result"]["isError"] is True
    missing = await server.handle({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {}})
    assert missing is not None and missing["error"]["code"] == -32602
    unknown = await server.handle({"jsonrpc": "2.0", "id": 6, "method": "resources/list"})
    assert unknown is not None and unknown["error"]["code"] == -32601
    assert await server.handle({"jsonrpc": "2.0", "id": 7, "method": "ping"}) == {
        "jsonrpc": "2.0",
        "id": 7,
        "result": {},
    }


async def test_mcp_server_survives_tool_crash() -> None:
    class Exploding(FakeToolHost):
        async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
            raise RuntimeError("kaboom")

    server = StudioMcpServer(Exploding())
    out = await server.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "memory_read"}})
    assert out is not None and out["error"]["code"] == -32603 and "kaboom" in out["error"]["message"]
