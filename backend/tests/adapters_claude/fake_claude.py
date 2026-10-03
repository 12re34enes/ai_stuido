"""Fake Claude Code CLI for tests: speaks headless stream-json + the SDK control protocol and
plays scripted scenarios (``FAKE_CLAUDE_SCENARIO`` = path to a JSON file).

Scenario format::

    {
      "auth": {...},                      # `auth status --json` output
      "version": "2.1.288 (Claude Code)", # `--version` output
      "startup": {"stderr": "...", "exit": 2},   # optional: fail at startup
      "initialize_response": {...},
      "usage_response": {...},            # get_usage answer
      "mcp_handshake": true,              # MCP initialize/tools-list over mcp_message after initialize
      "after_initialize": [step, ...],    # output the CLI produces on its own (no user turn)
      "model": "claude-sonnet-4-5",
      "turns": [[step, ...], ...]         # one list per user turn
    }

Steps: ``emit`` (msg), ``result`` (overrides), ``permission`` (tool, input, tool_use_id, on_allow,
on_deny, cancel_after), ``mcp_call`` (tool, arguments, tool_use_id), ``wait_interrupt``
(timeout, then), ``fold``, ``sleep`` (seconds), ``raw`` (line), ``stderr`` (text), ``exit`` (code).
Strings ``$SESSION`` / ``$UUIDS`` / ``$CWD`` inside emitted messages are substituted.

Everything received and decided is appended (JSON lines) to ``FAKE_CLAUDE_LOG`` if set.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from collections import deque
from typing import Any

Json = dict[str, Any]


class Fake:
    def __init__(self, argv: list[str], scenario: Json) -> None:
        self.argv = argv
        self.scenario = scenario
        self.inbox: queue.Queue[Json | None] = queue.Queue()
        self.pending_users: deque[Json] = deque()
        self.turns = deque(scenario.get("turns", []))
        self.interrupted = False
        self.req_seq = 0
        self.log_path = os.environ.get("FAKE_CLAUDE_LOG")
        self.session_id = self._arg_after("--session-id") or self._arg_after("--resume") or "fake-session"
        self.model = self._arg_after("--model") or scenario.get("model", "claude-sonnet-4-5")
        self.uuids: list[str] = []
        self.mcp_tools: list[Json] = []

    # ------------------------------------------------------------------ io

    def _arg_after(self, flag: str) -> str | None:
        if flag in self.argv:
            i = self.argv.index(flag)
            if i + 1 < len(self.argv):
                return self.argv[i + 1]
        return None

    def log(self, entry: Json) -> None:
        if not self.log_path:
            return
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def out(self, msg: Json) -> None:
        sys.stdout.write(json.dumps(self.subst(msg), ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def subst(self, value: Any) -> Any:
        if isinstance(value, str):
            if value == "$UUIDS":
                return list(self.uuids)
            return value.replace("$SESSION", self.session_id).replace("$CWD", os.getcwd())
        if isinstance(value, list):
            return [self.subst(v) for v in value]
        if isinstance(value, dict):
            return {k: self.subst(v) for k, v in value.items()}
        return value

    def reader(self) -> None:
        for raw in sys.stdin.buffer:
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            msg = json.loads(line)
            self.log({"in": msg})
            self.inbox.put(msg)
        self.inbox.put(None)

    def next_message(self, timeout: float | None = None) -> Json | None:
        """Next inbound message; raises queue.Empty on timeout; None at EOF."""
        return self.inbox.get(timeout=timeout)

    # ------------------------------------------------------------------ control protocol

    def respond(self, req_id: str, response: Json | None = None, error: str | None = None) -> None:
        if error is not None:
            self.out(
                {"type": "control_response", "response": {"subtype": "error", "request_id": req_id, "error": error}}
            )
        else:
            self.out(
                {
                    "type": "control_response",
                    "response": {"subtype": "success", "request_id": req_id, "response": response or {}},
                }
            )

    def request(self, request: Json) -> str:
        self.req_seq += 1
        req_id = f"cli_{self.req_seq}"
        self.out({"type": "control_request", "request_id": req_id, "request": request})
        return req_id

    def wait_response(self, req_id: str, timeout: float = 10.0) -> Json:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"no response to {req_id}")
            msg = self.next_message(remaining)
            if msg is None:
                sys.exit(0)
            if msg.get("type") == "control_response" and msg["response"].get("request_id") == req_id:
                return msg["response"]
            self.side_message(msg)

    def side_message(self, msg: Json) -> None:
        """Messages arriving while a turn runs."""
        if msg.get("type") == "user":
            self.pending_users.append(msg)
        elif msg.get("type") == "control_request":
            self.control(msg)

    def control(self, msg: Json) -> None:
        req = msg["request"]
        req_id = msg["request_id"]
        subtype = req.get("subtype")
        if subtype == "initialize":
            self.respond(
                req_id, self.scenario.get("initialize_response", {"commands": [], "models": [], "account": {}})
            )
            servers = list(req.get("sdkMcpServers") or [])
            if servers and self.scenario.get("mcp_handshake", True):
                self.mcp_handshake(servers[0])
            self.run_steps(self.scenario.get("after_initialize", []))  # CLI-initiated output
        elif subtype == "interrupt":
            self.interrupted = True
            self.respond(req_id, {"still_queued": []})
        elif subtype == "get_usage":
            self.respond(req_id, self.scenario.get("usage_response", {"rate_limits_available": False}))
        elif subtype == "list_permission_rules":
            settings = json.loads(self._arg_after("--settings") or "{}")
            self.respond(req_id, {"state": {"rules": settings.get("permissions", {})}})
        else:
            self.respond(req_id, error=f"unsupported: {subtype}")

    def mcp(self, server: str, message: Json) -> Json:
        req_id = self.request({"subtype": "mcp_message", "server_name": server, "message": message})
        resp = self.wait_response(req_id)
        self.log({"mcp": message.get("method"), "response": resp})
        return resp

    def mcp_handshake(self, server: str) -> None:
        init = self.mcp(
            server,
            {
                "jsonrpc": "2.0",
                "id": 0,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake"}},
            },
        )
        self.log({"mcp_initialized": init.get("response", {}).get("mcp_response", {}).get("result")})
        self.mcp(server, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        listing = self.mcp(server, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.mcp_tools = listing.get("response", {}).get("mcp_response", {}).get("result", {}).get("tools", [])

    # ------------------------------------------------------------------ turns

    def init_message(self) -> Json:
        return {
            "type": "system",
            "subtype": "init",
            "session_id": self.session_id,
            "cwd": os.getcwd(),
            "model": self.model,
            "tools": ["Bash", "Read", "Edit", "Write", *(f"mcp__studio__{t['name']}" for t in self.mcp_tools)],
            "mcp_servers": [{"name": "studio", "status": "connected", "source": "sdk"}],
            "permissionMode": "default",
            "claude_code_version": "2.1.288",
            "apiKeySource": "none",
            "slash_commands": [],
            "output_style": "default",
            "skills": [],
            "plugins": [],
            "uuid": "00000000-0000-4000-8000-000000000001",
        }

    def run_turn(self, user: Json) -> None:
        self.uuids = [user.get("uuid", "")]
        self.interrupted = False
        steps = self.turns.popleft() if self.turns else [{"op": "result"}]
        self.out(self.init_message())
        self.run_steps(steps)

    def run_steps(self, steps: list[Json]) -> None:
        for step in steps:
            self.step(step)

    def step(self, step: Json) -> None:
        op = step["op"]
        if op == "emit":
            self.out(step["msg"])
        elif op == "result":
            msg: Json = {
                "type": "result",
                "subtype": "success",
                "is_error": False,
                "duration_ms": 1200,
                "duration_api_ms": 1000,
                "num_turns": 1,
                "result": "done",
                "stop_reason": "end_turn",
                "total_cost_usd": 0.01,
                "usage": {
                    "input_tokens": 10,
                    "output_tokens": 20,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 5,
                },
                "modelUsage": {self.model: {"inputTokens": 10, "outputTokens": 20, "contextWindow": 200000}},
                "permission_denials": [],
                "user_message_uuids": list(self.uuids),
                "user_message_uuid": self.uuids[-1] if self.uuids else None,
                "session_id": self.session_id,
                "uuid": "00000000-0000-4000-8000-0000000000ff",
            }
            msg.update({k: v for k, v in step.items() if k != "op"})
            if self.interrupted and "terminal_reason" not in step:
                msg.update(
                    {"subtype": "error_during_execution", "is_error": True, "terminal_reason": "aborted_streaming"}
                )
            self.out(msg)
        elif op == "permission":
            req = {
                "subtype": "can_use_tool",
                "tool_name": step["tool"],
                "input": step.get("input", {}),
                "tool_use_id": step.get("tool_use_id", "toolu_x"),
            }
            if "decision_reason" in step:
                req["decision_reason"] = step["decision_reason"]
            req_id = self.request(req)
            if "cancel_after" in step:
                time.sleep(step["cancel_after"])
                self.out({"type": "control_cancel_request", "request_id": req_id})
                self.log({"cancelled": req_id})
                return
            resp = self.wait_response(req_id, timeout=step.get("timeout", 10.0))
            decision = resp.get("response", {})
            self.log({"permission": step["tool"], "decision": decision})
            branch = step.get("on_allow", []) if decision.get("behavior") == "allow" else step.get("on_deny", [])
            self.run_steps(branch)
        elif op == "mcp_call":
            tool_use_id = step.get("tool_use_id", "toolu_mcp")
            resp = self.mcp(
                "studio",
                {
                    "jsonrpc": "2.0",
                    "id": 10 + self.req_seq,
                    "method": "tools/call",
                    "params": {"name": step["tool"], "arguments": step.get("arguments", {})},
                },
            )
            result = resp.get("response", {}).get("mcp_response", {}).get("result", {})
            text = "".join(c.get("text", "") for c in result.get("content", []))
            self.out(
                {
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": [{"type": "text", "text": text}],
                                "is_error": bool(result.get("isError")),
                            }
                        ],
                    },
                    "parent_tool_use_id": None,
                    "session_id": self.session_id,
                    "uuid": "00000000-0000-4000-8000-0000000000aa",
                }
            )
        elif op == "wait_interrupt":
            deadline = time.monotonic() + step.get("timeout", 10.0)
            while not self.interrupted and time.monotonic() < deadline:
                try:
                    incoming = self.next_message(max(0.0, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if incoming is None:
                    sys.exit(0)
                self.side_message(incoming)
            self.log({"interrupted": self.interrupted})
            self.run_steps(step.get("then", []))
        elif op == "fold":
            # drain anything already sent, then fold queued user messages into this turn
            while True:
                try:
                    incoming = self.next_message(step.get("wait", 0.3))
                except queue.Empty:
                    break
                if incoming is None:
                    break
                self.side_message(incoming)
                if self.pending_users:
                    break
            while self.pending_users:
                self.uuids.append(self.pending_users.popleft().get("uuid", ""))
        elif op == "sleep":
            time.sleep(step.get("seconds", 0.05))
        elif op == "raw":
            sys.stdout.write(step["line"] + "\n")
            sys.stdout.flush()
        elif op == "stderr":
            sys.stderr.write(step["text"] + "\n")
            sys.stderr.flush()
        elif op == "exit":
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(step.get("code", 1))
        else:
            raise ValueError(f"unknown step {op}")

    # ------------------------------------------------------------------ main loop

    def serve(self) -> int:
        threading.Thread(target=self.reader, daemon=True).start()
        while True:
            # user messages parked while we waited for a control response come first
            msg = self.pending_users.popleft() if self.pending_users else self.next_message()
            if msg is None:
                break
            if msg.get("type") == "control_request":
                self.control(msg)
            elif msg.get("type") == "user":
                self.run_turn(msg)
                while self.pending_users:  # unfolded queued messages run as the next turn
                    nxt = self.pending_users.popleft()
                    self.run_turn(nxt)
        self.log({"eof": True})
        return 0


def main() -> int:
    argv = sys.argv[1:]
    with open(os.environ["FAKE_CLAUDE_SCENARIO"], encoding="utf-8") as f:
        scenario: Json = json.load(f)
    fake = Fake(argv, scenario)
    fake.log(
        {
            "argv": argv,
            "cwd": os.getcwd(),
            "env": {k: os.environ.get(k) for k in ("CLAUDE_CODE_ENTRYPOINT", "ANTHROPIC_API_KEY", "FAKE_EXTRA")},
        }
    )
    if argv[:1] == ["--version"]:
        print(scenario.get("version", "2.1.288 (Claude Code)"))
        return 0
    if argv[:2] == ["auth", "status"]:
        print(json.dumps(scenario.get("auth", {"loggedIn": True, "authMethod": "claude.ai"})))
        return 0 if scenario.get("auth", {}).get("loggedIn", True) else 1
    startup = scenario.get("startup", {})
    if startup.get("stderr"):
        sys.stderr.write(startup["stderr"] + "\n")
        sys.stderr.flush()
    if "exit" in startup:
        return int(startup["exit"])
    return fake.serve()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.exit(main())
