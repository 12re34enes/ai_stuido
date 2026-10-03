"""The in-process ``studio`` MCP server, reached by the CLI through ``mcp_message`` control
requests (the CLI is the MCP client, we are the server). Only the ``tools`` capability is
offered; tool calls go to the session's bound :class:`ToolHost`."""

from __future__ import annotations

import logging
from typing import Any

from aistudio.adapters.claude.protocol import MCP_PROTOCOL_VERSIONS, STUDIO_SERVER, as_dict, as_str
from aistudio.contracts.tools import ToolHost

log = logging.getLogger(__name__)

SERVER_VERSION = "1.0.0"

# JSON-RPC error codes
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


def _response(msg_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "result": result}


def _error(msg_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}


class StudioMcpServer:
    def __init__(self, tools: ToolHost, *, name: str = STUDIO_SERVER) -> None:
        self._tools = tools
        self.name = name

    async def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """Handle one JSON-RPC message. Returns the response for requests, ``None`` for
        notifications and responses (nothing to answer)."""
        method = as_str(message.get("method"))
        if "id" not in message or method is None:
            return None  # notification (e.g. notifications/initialized) or a stray response
        msg_id = message.get("id")
        params = as_dict(message.get("params"))
        try:
            if method == "initialize":
                return _response(msg_id, self._initialize(params))
            if method == "ping":
                return _response(msg_id, {})
            if method == "tools/list":
                return _response(msg_id, self._tools_list())
            if method == "tools/call":
                return await self._tools_call(msg_id, params)
            return _error(msg_id, METHOD_NOT_FOUND, f"Method not found: {method}")
        except Exception as e:  # never let a tool bug break the control channel
            log.exception("studio MCP server failed on %s", method)
            return _error(msg_id, INTERNAL_ERROR, f"Internal error: {e}")

    def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        requested = as_str(params.get("protocolVersion"))
        version = requested if requested in MCP_PROTOCOL_VERSIONS else MCP_PROTOCOL_VERSIONS[0]
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": self.name, "version": SERVER_VERSION},
            "instructions": "AI Studio tools: shared memory, evidence, approvals, status and handoff.",
        }

    def _tools_list(self) -> dict[str, Any]:
        tools = []
        for spec in self._tools.specs():
            schema = dict(spec.input_schema) if spec.input_schema else {"type": "object", "properties": {}}
            schema.setdefault("type", "object")
            tools.append(
                {
                    "name": spec.name,
                    "description": spec.description,
                    "inputSchema": schema,
                    "annotations": {"readOnlyHint": not spec.mutating},
                }
            )
        return {"tools": tools}

    async def _tools_call(self, msg_id: Any, params: dict[str, Any]) -> dict[str, Any]:
        name = as_str(params.get("name"))
        if not name:
            return _error(msg_id, INVALID_PARAMS, "tools/call requires a tool name")
        arguments = as_dict(params.get("arguments"))
        result = await self._tools.call(name, arguments)
        # ``result.data`` is the structured copy for the UI/event log (written by the ToolHost);
        # only the text goes back to the model.
        return _response(msg_id, {"content": [{"type": "text", "text": result.content}], "isError": result.is_error})
