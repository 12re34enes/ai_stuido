"""Fake ``codex`` CLI for tests (stdlib only, launched with ``sys.executable``).

Supports ``--version``, ``login status`` and ``app-server`` (newline-delimited JSON-RPC without the
``jsonrpc`` member, like Codex 0.160.0). Behaviour comes from a scenario JSON file named by
``FAKE_CODEX_SCENARIO``; every message received from the client is appended to ``FAKE_CODEX_LOG``
as ``{"recv": <msg>, "respondsTo": <server request method or null>}``.

Scenario keys (all optional)::

    version            "0.160.0"
    login              "chatgpt" | "apikey" | "none"
    threadId / forkId  ids returned by thread/start / thread/fork
    model              model reported by thread/start
    threads            [Thread]          for thread/list, thread/read, thread/resume
    turns              {threadId: [Turn]} for thread/turns/list
    pageSize           page size for list endpoints (default 100)
    rateLimits         GetAccountRateLimitsResponse
    afterInitialize    [step]            run right after the initialized notification
    turnScripts        [[step]]          one script per turn/start, in order
    byInstructions     {text: {...}}     the first entry whose key occurs in thread/start's
                                         developerInstructions overrides top-level keys

Steps (strings "$THREAD", "$TURN", "$CWD", "$TOOL_TEXT", "$TOOL_SUCCESS" are substituted)::

    {"notify": method, "params": {...}}
    {"item": {...}, "phase": "started" | "completed", "threadId"?, "turnId"?}
                               threadId/turnId override the main thread (sub-agent items)
    {"approval": "command" | "fileChange" | "permissions", "params": {...},
     "accept": [step], "decline": [step]}
    {"toolCall": {"callId", "tool", "arguments", "namespace"?}, "then": [step]}
    {"request": method, "params": {...}}       raw server request (waits for the response)
    {"approvalResolved": "command", "params": {...}, "afterMs": 100}
                               approval request withdrawn via serverRequest/resolved
    {"waitSteer": true}        wait for turn/steer, then emit the steered userMessage item
    {"waitInterrupt": true}    block until turn/interrupt (which completes the turn as interrupted)
    {"sleep": ms}
    {"write": {"path", "content"}}   really write a file (path relative to the thread cwd)
    {"raw": "text"}            write a raw (malformed) line
    {"crash": code, "stderr": "..."}
    {"complete": {"status": "failed", "error": {...}}}
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sys
import time
import uuid
from typing import Any

SCENARIO: dict[str, Any] = {}


def write_file(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


LOG_PATH = os.environ.get("FAKE_CODEX_LOG")


def load_scenario() -> None:
    path = os.environ.get("FAKE_CODEX_SCENARIO")
    if path:
        with open(path, encoding="utf-8") as f:
            SCENARIO.update(json.load(f))


def version() -> str:
    return str(SCENARIO.get("version", "0.160.0"))


def new_uuid() -> str:
    return str(uuid.uuid4())


def log_recv(msg: Any, responds_to: str | None) -> None:
    if not LOG_PATH:
        return
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(json.dumps({"recv": msg, "respondsTo": responds_to}) + "\n")


def write(msg: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def subst(value: Any, ctx: dict[str, Any]) -> Any:
    if isinstance(value, str):
        if value in ctx:
            return ctx[value]
        for key, rep in ctx.items():
            if isinstance(rep, str) and key in value:
                value = value.replace(key, rep)
        return value
    if isinstance(value, list):
        return [subst(v, ctx) for v in value]
    if isinstance(value, dict):
        return {k: subst(v, ctx) for k, v in value.items()}
    return value


def make_thread(thread_id: str, cwd: str, *, model: str | None, preview: str = "", **extra: Any) -> dict[str, Any]:
    now = int(time.time())
    thread = {
        "id": thread_id,
        "sessionId": thread_id,
        "forkedFromId": None,
        "parentThreadId": None,
        "preview": preview,
        "ephemeral": False,
        "projectId": None,
        "historyMode": "paginated",
        "modelProvider": "openai",
        "model": model,
        "reasoningEffort": None,
        "createdAt": now,
        "updatedAt": now,
        "status": {"type": "idle"},
        "path": f"/fake/.codex/sessions/rollout-{thread_id}.jsonl",
        "cwd": cwd,
        "cliVersion": version(),
        "source": "vscode",
        "gitInfo": None,
        "name": None,
        "turns": [],
    }
    thread.update(extra)
    return thread


def source_kind(source: Any) -> str:
    """ThreadSourceKind of a SessionSource value (``{"subAgent": {"thread_spawn": ...}}`` ...)."""
    if isinstance(source, str):
        return source
    if isinstance(source, dict) and "subAgent" in source:
        sub = source["subAgent"]
        if isinstance(sub, dict):
            return "subAgentThreadSpawn" if "thread_spawn" in sub else "subAgentOther"
        return {"review": "subAgentReview", "compact": "subAgentCompact"}.get(str(sub), "subAgent")
    return "unknown"


class NoResponse(Exception):
    """The real server sends no response at all (e.g. turn/interrupt after the turn finished)."""


class FakeServer:
    def __init__(self) -> None:
        self.next_id = 0
        self.pending: dict[int, asyncio.Future[Any]] = {}
        self.pending_method: dict[int, str] = {}
        self.thread: dict[str, Any] | None = None
        self.turn_index = 0
        self.active_turn: str | None = None
        self.turn_task: asyncio.Task[None] | None = None
        self.steer_queue: asyncio.Queue[str] = asyncio.Queue()
        self.cwd = os.getcwd()

    # ---------------------------------------------------------------- server -> client requests

    async def server_request(self, method: str, params: dict[str, Any]) -> Any:
        rid = self.next_id
        self.next_id += 1
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self.pending[rid] = fut
        self.pending_method[rid] = method
        write({"id": rid, "method": method, "params": params})
        return await fut

    def notify(self, method: str, params: Any) -> None:
        write({"method": method, "params": params, "emittedAtMs": int(time.time() * 1000)})

    # ---------------------------------------------------------------- steps

    def ctx(self, extra: dict[str, Any] | None = None) -> dict[str, Any]:
        out: dict[str, Any] = {
            "$THREAD": self.thread["id"] if self.thread else "",
            "$TURN": self.active_turn or "",
            "$CWD": self.thread["cwd"] if self.thread else self.cwd,
        }
        out.update(extra or {})
        return out

    async def run_steps(self, steps: list[dict[str, Any]], extra: dict[str, Any] | None = None) -> str | None:
        """Returns a completion status override when a step completes the turn."""
        extra = dict(extra or {})
        for raw_step in steps:
            step = subst(raw_step, self.ctx(extra))
            if "notify" in step:
                self.notify(step["notify"], step.get("params", {}))
            elif "item" in step:
                method = "item/started" if step.get("phase", "started") == "started" else "item/completed"
                key = "startedAtMs" if method == "item/started" else "completedAtMs"
                self.notify(
                    method,
                    {
                        "item": step["item"],
                        "threadId": step.get("threadId") or self.ctx()["$THREAD"],  # sub-agent thread override
                        "turnId": step.get("turnId") or self.ctx()["$TURN"],
                        key: 1,
                    },
                )
            elif "approval" in step:
                method = {
                    "command": "item/commandExecution/requestApproval",
                    "fileChange": "item/fileChange/requestApproval",
                    "permissions": "item/permissions/requestApproval",
                }[step["approval"]]
                result = await self.server_request(method, step["params"])
                if step["approval"] == "permissions":
                    decision = "accept" if (result or {}).get("permissions") else "decline"
                else:
                    decision = (
                        "accept" if (result or {}).get("decision") in ("accept", "acceptForSession") else "decline"
                    )
                status = await self.run_steps(step.get(decision, []), extra)
                if status:
                    return status
            elif "toolCall" in step:
                call = step["toolCall"]
                params = {
                    "threadId": self.ctx()["$THREAD"],
                    "turnId": self.ctx()["$TURN"],
                    "callId": call["callId"],
                    "namespace": call.get("namespace"),
                    "tool": call["tool"],
                    "arguments": call.get("arguments", {}),
                }
                result = await self.server_request("item/tool/call", params)
                items = (result or {}).get("contentItems") or []
                extra["$TOOL_TEXT"] = "\n".join(i.get("text", "") for i in items if isinstance(i, dict))
                extra["$TOOL_SUCCESS"] = bool((result or {}).get("success"))
                status = await self.run_steps(step.get("then", []), extra)
                if status:
                    return status
            elif "request" in step:
                result = await self.server_request(step["request"], step.get("params", {}))
                extra["$LAST_RESULT"] = json.dumps(result)
            elif "approvalResolved" in step:
                method = {
                    "command": "item/commandExecution/requestApproval",
                    "fileChange": "item/fileChange/requestApproval",
                }[step["approvalResolved"]]
                rid = self.next_id
                self.next_id += 1
                self.pending[rid] = asyncio.get_running_loop().create_future()
                self.pending_method[rid] = method
                write({"id": rid, "method": method, "params": step["params"]})
                await asyncio.sleep(step.get("afterMs", 100) / 1000)
                self.pending.pop(rid, None)
                self.notify("serverRequest/resolved", {"threadId": self.ctx()["$THREAD"], "requestId": rid})
            elif "waitSteer" in step:
                text = await self.steer_queue.get()
                item = {
                    "type": "userMessage",
                    "id": new_uuid(),
                    "clientId": None,
                    "content": [{"type": "text", "text": text, "text_elements": []}],
                }
                await self.run_steps([{"item": item, "phase": "started"}, {"item": item, "phase": "completed"}])
            elif "waitInterrupt" in step:
                await asyncio.Event().wait()
            elif "sleep" in step:
                await asyncio.sleep(step["sleep"] / 1000)
            elif "write" in step:  # really write a file under the thread's cwd
                root = self.thread["cwd"] if self.thread else self.cwd
                write_file(os.path.join(root, step["write"]["path"]), step["write"].get("content", ""))
            elif "raw" in step:
                sys.stdout.write(step["raw"] + "\n")
                sys.stdout.flush()
            elif "crash" in step:
                sys.stderr.write(step.get("stderr", "") + "\n")
                sys.stderr.flush()
                os._exit(int(step["crash"]))
            elif "complete" in step:
                self.complete_turn(step["complete"].get("status", "completed"), step["complete"].get("error"))
                return step["complete"].get("status", "completed")
        return None

    # ---------------------------------------------------------------- turns

    def complete_turn(self, status: str, error: dict[str, Any] | None = None) -> None:
        turn_id = self.active_turn
        if turn_id is None or self.thread is None:
            return
        self.active_turn = None
        self.notify("thread/status/changed", {"threadId": self.thread["id"], "status": {"type": "idle"}})
        self.notify(
            "turn/completed",
            {
                "threadId": self.thread["id"],
                "turn": {
                    "id": turn_id,
                    "items": [],
                    "itemsView": "notLoaded",
                    "status": status,
                    "error": error,
                    "startedAt": int(time.time()),
                    "completedAt": int(time.time()),
                    "durationMs": 1234,
                },
            },
        )

    async def run_turn(self, turn_id: str, text: str, script: list[dict[str, Any]]) -> None:
        assert self.thread is not None
        self.notify(
            "thread/status/changed", {"threadId": self.thread["id"], "status": {"type": "active", "activeFlags": []}}
        )
        turn = {
            "id": turn_id,
            "items": [],
            "itemsView": "notLoaded",
            "status": "inProgress",
            "error": None,
            "startedAt": int(time.time()),
            "completedAt": None,
            "durationMs": None,
        }
        self.notify("turn/started", {"threadId": self.thread["id"], "turn": turn})
        user_item = {
            "type": "userMessage",
            "id": new_uuid(),
            "clientId": None,
            "content": [{"type": "text", "text": text, "text_elements": []}],
        }
        await self.run_steps([{"item": user_item, "phase": "started"}, {"item": user_item, "phase": "completed"}])
        status = await self.run_steps(script)
        if status is None:
            self.complete_turn("completed")

    # ---------------------------------------------------------------- client requests

    def threads(self) -> list[dict[str, Any]]:
        return list(SCENARIO.get("threads", []))

    def find_thread(self, thread_id: str) -> dict[str, Any] | None:
        if self.thread and self.thread["id"] == thread_id:
            return self.thread
        return next((t for t in self.threads() if t["id"] == thread_id), None)

    async def handle(self, rid: Any, method: str, params: dict[str, Any]) -> None:
        try:
            result = await self.dispatch(method, params)
        except NoResponse:
            return
        except LookupError as e:
            write({"id": rid, "error": {"code": -32600, "message": str(e)}})
            return
        write({"id": rid, "result": result})
        if method == "thread/start" or method == "thread/fork":
            self.notify("thread/started", {"thread": self.thread})
        if method == "thread/resume":
            self.notify("thread/status/changed", {"threadId": params["threadId"], "status": {"type": "idle"}})

    def thread_response(self, params: dict[str, Any]) -> dict[str, Any]:
        assert self.thread is not None
        sandbox_mode = params.get("sandbox") or "read-only"
        net = ((params.get("config") or {}).get("sandbox_workspace_write") or {}).get("network_access", False)
        sandbox = {
            "read-only": {"type": "readOnly", "networkAccess": False},
            "workspace-write": {
                "type": "workspaceWrite",
                "writableRoots": [],
                "networkAccess": net,
                "excludeTmpdirEnvVar": False,
                "excludeSlashTmp": False,
            },
            "danger-full-access": {"type": "dangerFullAccess"},
        }[sandbox_mode]
        return {
            "thread": self.thread,
            "model": self.thread["model"],
            "modelProvider": "openai",
            "serviceTier": None,
            "disabledPluginIds": [],
            "cwd": self.thread["cwd"],
            "instructionSources": [],
            "approvalPolicy": params.get("approvalPolicy") or "on-request",
            "approvalsReviewer": params.get("approvalsReviewer") or "user",
            "sandbox": sandbox,
            "reasoningEffort": (params.get("config") or {}).get("model_reasoning_effort"),
        }

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "initialize":
            return {
                "userAgent": f"{params['clientInfo']['name']}/{version()} (Fake OS) fake",
                "codexHome": "/fake/.codex",
                "platformFamily": "unix",
                "platformOs": "macos",
            }
        if method == "thread/start":
            instructions = str(params.get("developerInstructions") or "")
            for key, override in SCENARIO.get("byInstructions", {}).items():
                if key in instructions:
                    SCENARIO.update(override)
                    break
            model = params.get("model") or SCENARIO.get("model", "gpt-5.5")
            self.thread = make_thread(
                SCENARIO.get("threadId") or new_uuid(), params.get("cwd") or self.cwd, model=model
            )
            return self.thread_response(params)
        if method == "thread/resume":
            found = self.find_thread(params["threadId"])
            if found is None:
                raise LookupError(f"no rollout found for thread id {params['threadId']}")
            self.thread = dict(found, cwd=params.get("cwd") or found["cwd"])
            return self.thread_response(params)
        if method == "thread/fork":
            found = self.find_thread(params["threadId"])
            if found is None:
                raise LookupError(f"no rollout found for thread id {params['threadId']}")
            fork_id = SCENARIO.get("forkId") or new_uuid()
            self.thread = make_thread(
                fork_id, params.get("cwd") or found["cwd"], model=found.get("model"), forkedFromId=found["id"]
            )
            return self.thread_response(params)
        if method == "thread/name/set":
            if self.thread and self.thread["id"] == params["threadId"]:
                self.thread["name"] = params["name"]
            return {}
        if method == "thread/list":
            data = self.threads()
            kinds = params.get("sourceKinds")
            if kinds:  # like the real server: sub-agent threads only when asked for
                data = [t for t in data if source_kind(t.get("source")) in kinds]
            cwd = params.get("cwd")
            if cwd is not None:
                wanted = cwd if isinstance(cwd, list) else [cwd]
                data = [t for t in data if t["cwd"] in wanted]
            data.sort(key=lambda t: t.get("updatedAt", 0), reverse=params.get("sortDirection", "desc") == "desc")
            return self.page(data, params)
        if method == "thread/read":
            found = self.find_thread(params["threadId"])
            if found is None:
                raise LookupError(f"invalid thread id: {params['threadId']}")
            return {"thread": dict(found, turns=[])}
        if method == "thread/turns/list":
            if self.find_thread(params["threadId"]) is None:
                raise LookupError(f"invalid thread id: {params['threadId']}")
            turns = list(SCENARIO.get("turns", {}).get(params["threadId"], []))
            if params.get("sortDirection", "desc") == "desc":
                turns.reverse()
            return self.page(turns, params)
        if method == "turn/start":
            if self.thread is None or params["threadId"] != self.thread["id"]:
                raise LookupError("thread not loaded")
            scripts = SCENARIO.get("turnScripts", [])
            script = scripts[self.turn_index] if self.turn_index < len(scripts) else []
            self.turn_index += 1
            turn_id = new_uuid()
            self.active_turn = turn_id
            text = "\n".join(i.get("text", "") for i in params.get("input", []) if i.get("type") == "text")
            loop = asyncio.get_running_loop()
            loop.call_soon(lambda: self.start_turn_task(turn_id, text, script))
            return {
                "turn": {
                    "id": turn_id,
                    "items": [],
                    "itemsView": "notLoaded",
                    "status": "inProgress",
                    "error": None,
                    "startedAt": None,
                    "completedAt": None,
                    "durationMs": None,
                }
            }
        if method == "turn/steer":
            if self.active_turn is None:
                raise LookupError("no active turn to steer")
            if params.get("expectedTurnId") != self.active_turn:
                raise LookupError(
                    f"expected active turn id {params.get('expectedTurnId')} but found {self.active_turn}"
                )
            text = "\n".join(i.get("text", "") for i in params.get("input", []) if i.get("type") == "text")
            self.steer_queue.put_nowait(text)
            return {"turnId": self.active_turn}
        if method == "turn/interrupt":
            if self.active_turn is None:
                raise NoResponse
            if params.get("turnId") != self.active_turn:
                raise LookupError(f"expected active turn id {params.get('turnId')} but found {self.active_turn}")
            loop = asyncio.get_running_loop()
            loop.call_soon(self.interrupt_turn)
            return {}
        if method == "account/rateLimits/read":
            if SCENARIO.get("login", "chatgpt") == "none" or "rateLimits" not in SCENARIO:
                raise LookupError("codex account authentication required to read rate limits")
            return SCENARIO["rateLimits"]
        if method == "account/read":
            login = SCENARIO.get("login", "chatgpt")
            account = None
            if login == "chatgpt":
                account = {"type": "chatgpt", "email": "user@example.com", "planType": "plus"}
            elif login == "apikey":
                account = {"type": "apiKey"}
            return {"account": account, "requiresOpenaiAuth": True, "workspaceRouting": None}
        raise LookupError(f"Invalid request: unknown variant `{method}`")

    def page(self, data: list[Any], params: dict[str, Any]) -> dict[str, Any]:
        size = min(int(params.get("limit") or 100), int(SCENARIO.get("pageSize", 100)))
        start = int(params.get("cursor") or 0)
        chunk = data[start : start + size]
        nxt = str(start + size) if start + size < len(data) else None
        return {"data": chunk, "nextCursor": nxt, "backwardsCursor": None}

    def start_turn_task(self, turn_id: str, text: str, script: list[dict[str, Any]]) -> None:
        self.turn_task = asyncio.create_task(self.run_turn(turn_id, text, script))

    def interrupt_turn(self) -> None:
        if self.turn_task is not None and not self.turn_task.done():
            self.turn_task.cancel()
        self.complete_turn("interrupted")

    # ---------------------------------------------------------------- main loop

    async def serve(self) -> None:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=16 * 1024 * 1024)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        tasks: set[asyncio.Task[Any]] = set()
        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            rid = msg.get("id")
            method = msg.get("method")
            if method is None and rid is not None:  # response to one of our requests
                responds_to = self.pending_method.pop(rid, None)
                log_recv(msg, responds_to)
                fut = self.pending.pop(rid, None)
                if fut is not None and not fut.done():
                    if "error" in msg:
                        fut.set_result(None)
                    else:
                        fut.set_result(msg.get("result"))
                continue
            log_recv(msg, None)
            if method == "initialized":
                task = asyncio.create_task(self.run_steps(SCENARIO.get("afterInitialize", [])))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
                continue
            if rid is None or not isinstance(method, str):
                continue
            task = asyncio.create_task(self.handle(rid, method, msg.get("params") or {}))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
        if self.turn_task is not None:
            self.turn_task.cancel()
            with contextlib.suppress(BaseException):
                await self.turn_task


def main(argv: list[str]) -> int:
    load_scenario()
    if "--version" in argv:
        print(f"codex-cli {version()}")
        return 0
    if argv[:2] == ["login", "status"]:
        login = SCENARIO.get("login", "chatgpt")
        if login == "none":
            print("Not logged in", file=sys.stderr)
            return 1
        print("Logged in using ChatGPT" if login == "chatgpt" else "Logged in using an API key")
        return 0
    if argv[:1] == ["app-server"] and len(argv) == 1:
        if SCENARIO.get("failStart"):
            print(SCENARIO["failStart"], file=sys.stderr)
            return 2
        asyncio.run(FakeServer().serve())
        return 0
    print(f"fake codex: unsupported arguments {argv}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
