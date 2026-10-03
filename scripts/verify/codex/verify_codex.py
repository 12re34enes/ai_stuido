"""Verify the Codex adapter against the REAL, logged-in Codex CLI (run on the user's Mac).

    cd backend && uv run python ../scripts/verify/codex/verify_codex.py [--model M] [--effort low]
                                                                      [--codex /path/to/codex] [--quick]
                                                                      [--subagents]

Uses a throw-away git repository and tiny prompts (about 9 short turns with reasoning effort
"low"; ``--quick`` runs only the free checks plus one streaming turn). Checks: schema drift
against the installed CLI, health, rate limits, account, streaming, command approval (allow and
deny), file change approval, dynamic Studio tool call, steer, interrupt, resume, thread listing
and history import. ``--subagents`` (costs a little extra quota) asks the model to spawn one
sub-agent that runs a command needing approval and checks SubagentStarted (name from thread/read),
payloads tagged with the sub-agent thread id, the approval's subagent_id, SubagentCompleted and
the sub-agent in the imported history. Raw JSON-RPC streams (masked with ``Masker``) and
normalized events go to ``scripts/verify/out/codex/<time>/``; a Turkish result table is printed.
Exit code 1 on failure.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import secrets
import shutil
import sys
import tempfile
import time
import traceback
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from aistudio.adapters.codex import CodexAdapter, schema_tools
from aistudio.contracts.agents import (
    AgentErrorEv,
    AgentEventPayload,
    FileChanged,
    Message,
    MessageDelta,
    PermissionDecision,
    PermissionRequest,
    SessionSpec,
    SubagentCompleted,
    SubagentStarted,
    ToolCall,
    ToolKind,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolResult, ToolSpec
from aistudio.contracts.transport import CompletedProcess
from aistudio.core import proc as procmod
from aistudio.security.masking import Masker

ROOT = Path(__file__).resolve().parents[3]
OUT_ROOT = ROOT / "scripts" / "verify" / "out" / "codex"
TURN_TIMEOUT = 240.0
MASKER = Masker()

# --------------------------------------------------------------------------- transport (tee to disk)


class TeeProcess:
    """Wraps a transport Process and appends every stdin/stdout line (masked) to a JSONL file."""

    def __init__(self, inner: Any, path: Path) -> None:
        self._inner = inner
        self._path = path

    def _log(self, direction: str, data: bytes) -> None:
        text = data.decode("utf-8", errors="replace").rstrip("\n")
        if not text:
            return
        try:
            payload: Any = MASKER.mask_obj(json.loads(text))
        except json.JSONDecodeError:
            payload = MASKER.mask(text)
        with self._path.open("a", encoding="utf-8") as f:
            record = {"t": round(time.time(), 3), "dir": direction, "msg": payload}
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    @property
    def pid(self) -> int | None:
        return self._inner.pid

    async def write(self, data: bytes) -> None:
        for line in data.splitlines():
            self._log("send", line)
        await self._inner.write(data)

    async def close_stdin(self) -> None:
        await self._inner.close_stdin()

    async def readline(self) -> bytes:
        line = await self._inner.readline()
        self._log("recv", line)
        return line

    async def read_stderr(self) -> bytes:
        data = await self._inner.read_stderr()
        if data:
            with self._path.with_suffix(".stderr.txt").open("w", encoding="utf-8") as f:
                f.write(MASKER.mask(data.decode("utf-8", errors="replace")))
        return data

    async def wait(self) -> int:
        return await self._inner.wait()

    async def terminate(self) -> None:
        await self._inner.terminate()

    async def kill(self) -> None:
        await self._inner.kill()


class _LocalProcess:
    def __init__(self, p: asyncio.subprocess.Process) -> None:
        self._p = p
        self._stderr = bytearray()
        self._task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        assert self._p.stderr is not None
        while chunk := await self._p.stderr.read(65536):
            self._stderr += chunk

    @property
    def pid(self) -> int | None:
        return self._p.pid

    async def write(self, data: bytes) -> None:
        assert self._p.stdin is not None
        self._p.stdin.write(data)
        await self._p.stdin.drain()

    async def close_stdin(self) -> None:
        if self._p.stdin is not None and not self._p.stdin.is_closing():
            self._p.stdin.close()

    async def readline(self) -> bytes:
        assert self._p.stdout is not None
        return await self._p.stdout.readline()

    async def read_stderr(self) -> bytes:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(self._task), 5)
        return bytes(self._stderr)

    async def wait(self) -> int:
        return await self._p.wait()

    async def terminate(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._p.terminate()

    async def kill(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._p.kill()


class _FallbackLocalTransport:
    """Used when aistudio.agents' LocalTransport is not available yet."""

    kind: Literal["local", "ssh"] = "local"
    host_id: str | None = None

    async def spawn(self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None) -> Any:
        p = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=16 * 1024 * 1024,
        )
        return _LocalProcess(p)

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        return await procmod.run(argv, cwd=cwd, env=env, timeout=timeout, input=input)

    async def read_file(self, path: str) -> bytes:
        return await asyncio.to_thread(Path(path).read_bytes)

    async def write_file(self, path: str, data: bytes) -> None:
        await asyncio.to_thread(Path(path).write_bytes, data)

    async def exists(self, path: str) -> bool:
        return os.path.exists(path)

    async def glob(self, pattern: str) -> list[str]:
        import glob as globmod

        return sorted(globmod.glob(pattern, recursive=True))

    async def home(self) -> str:
        return str(Path.home())

    async def which(self, binary: str) -> str | None:
        return shutil.which(binary)


def base_transport() -> Any:
    try:
        from aistudio.agents.transport_local import LocalTransport  # type: ignore[import-not-found]

        return LocalTransport()
    except Exception:
        return _FallbackLocalTransport()


class TeeTransport:
    def __init__(self, inner: Any, out_dir: Path) -> None:
        self._inner = inner
        self._out = out_dir
        self._n = 0
        self.kind = inner.kind
        self.host_id = inner.host_id

    async def spawn(self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None) -> Any:
        self._n += 1
        path = self._out / f"stream-{self._n:02d}.jsonl"
        with path.open("w", encoding="utf-8") as f:
            f.write(json.dumps({"dir": "meta", "msg": {"argv": argv, "cwd": cwd}}) + "\n")
        return TeeProcess(await self._inner.spawn(argv, cwd=cwd, env=env), path)

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        return await self._inner.run(argv, cwd=cwd, env=env, timeout=timeout, input=input)

    async def read_file(self, path: str) -> bytes:
        return await self._inner.read_file(path)

    async def write_file(self, path: str, data: bytes) -> None:
        await self._inner.write_file(path, data)

    async def exists(self, path: str) -> bool:
        return await self._inner.exists(path)

    async def glob(self, pattern: str) -> list[str]:
        return await self._inner.glob(pattern)

    async def home(self) -> str:
        return await self._inner.home()

    async def which(self, binary: str) -> str | None:
        return await self._inner.which(binary)


# --------------------------------------------------------------------------- doubles


class Sink:
    def __init__(self, path: Path) -> None:
        self.events: list[AgentEventPayload] = []
        self.limits_seen: list[LimitWindow] = []
        self._path = path

    async def emit(self, payload: AgentEventPayload) -> None:
        self.events.append(payload)
        with self._path.open("a", encoding="utf-8") as f:
            data = MASKER.mask_obj(payload.model_dump(mode="json"))
            f.write(json.dumps({"type": type(payload).__name__, **data}, ensure_ascii=False) + "\n")

    async def limits(self, windows: list[LimitWindow]) -> None:
        self.limits_seen.extend(windows)

    def of[T](self, kind: type[T], since: int = 0) -> list[T]:
        return [e for e in self.events[since:] if isinstance(e, kind)]


class EchoTools:
    def __init__(self) -> None:
        self.token = "pong-" + secrets.token_hex(3)
        self.calls: list[dict[str, Any]] = []

    def specs(self) -> list[ToolSpec]:
        return [
            ToolSpec(
                name="aistudio_echo",
                description="AI Studio verification tool. Returns a secret word for the given text.",
                input_schema={"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
            )
        ]

    async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
        self.calls.append({"name": name, "args": args})
        return ToolResult(content=f"{self.token} ({args.get('text', '')})")


@dataclass
class Policy:
    deny_substring: str = "denied.txt"
    requests: list[PermissionRequest] = field(default_factory=list)

    async def __call__(self, req: PermissionRequest) -> PermissionDecision:
        self.requests.append(req)
        text = json.dumps(req.input, ensure_ascii=False) + (req.command or "")
        allow = self.deny_substring not in text
        return PermissionDecision(allow=allow, decided_by="policy", reason=None if allow else "doğrulama: reddet")


# --------------------------------------------------------------------------- checks


@dataclass
class Row:
    name: str
    status: Literal["BAŞARILI", "BAŞARISIZ", "ATLANDI"]
    detail: str = ""
    seconds: float = 0.0


class Runner:
    def __init__(self, args: argparse.Namespace, out_dir: Path) -> None:
        self.args = args
        self.out = out_dir
        self.rows: list[Row] = []
        self.transport = TeeTransport(base_transport(), out_dir)
        command = [args.codex] if args.codex else None
        self.adapter = CodexAdapter(command=command)
        self.repo = Path(tempfile.mkdtemp(prefix="aistudio-codex-verify-"))
        self.sink = Sink(out_dir / "events.jsonl")
        self.tools = EchoTools()
        self.policy = Policy()
        self.session: Any = None
        self.native_id: str | None = None
        self.subagent_id: str | None = None
        self.logged_in = False

    async def check(self, name: str, fn: Callable[[], Awaitable[str]], *, needs_login: bool = True) -> None:
        if needs_login and not self.logged_in:
            self.rows.append(Row(name, "ATLANDI", "Codex girişi yok"))
            return
        started = time.monotonic()
        try:
            detail = await fn()
            self.rows.append(Row(name, "BAŞARILI", detail, time.monotonic() - started))
        except Exception as e:
            with (self.out / "errors.txt").open("a", encoding="utf-8") as f:
                f.write(f"--- {name}\n{traceback.format_exc()}\n")
            self.rows.append(Row(name, "BAŞARISIZ", f"{type(e).__name__}: {e}"[:200], time.monotonic() - started))

    # -- helpers

    def spec(self, **kw: Any) -> SessionSpec:
        return SessionSpec(
            provider="codex",
            cwd=str(self.repo),
            model=self.args.model,
            effort=self.args.effort,
            system_append="This is an automated AI Studio verification. Keep every answer to one short line.",
            title="AI Studio doğrulama",
            **kw,
        )

    async def ensure_session(self) -> Any:
        if self.session is None:
            self.session = await self.adapter.start(
                self.spec(), transport=self.transport, sink=self.sink, tools=self.tools, permissions=self.policy
            )
            self.native_id = self.session.native_id
        return self.session

    async def turn(self, prompt: str) -> tuple[Any, int]:
        session = await self.ensure_session()
        mark = len(self.sink.events)
        turn_id = await session.send(prompt)
        result = await session.wait_turn(turn_id, timeout=TURN_TIMEOUT)
        return result, mark

    # -- free checks

    async def c_schema(self) -> str:
        codex = self.args.codex or shutil.which("codex") or "codex"
        with tempfile.TemporaryDirectory() as tmp:
            gen = await procmod.run(
                [codex, "app-server", "generate-json-schema", "--experimental", "--out", tmp], timeout=120
            )
            if gen.returncode != 0:
                raise AssertionError(f"şema üretilemedi: {gen.stderr[-300:]}")
            bundle = json.loads((Path(tmp) / schema_tools.BUNDLE_FILE_NAME).read_text(encoding="utf-8"))
        version = (await procmod.run([codex, "--version"], timeout=30)).stdout.strip()
        fresh = schema_tools.prune_bundle(bundle, codex_version=version)
        diffs = schema_tools.compare_used(schema_tools.load_committed(), fresh)
        (self.out / "schema-diff.txt").write_text("\n".join(diffs) + "\n")
        if diffs:
            raise AssertionError(f"{len(diffs)} şema farkı (schema-diff.txt): {', '.join(diffs[:3])}")
        return f"kullanılan alt küme aynı ({version})"

    async def c_health(self) -> str:
        h = await self.adapter.health(self.transport)
        (self.out / "health.json").write_text(h.model_dump_json(indent=2))
        self.logged_in = bool(h.logged_in)
        if not h.installed:
            raise AssertionError(h.message or "kurulu değil")
        if not h.logged_in:
            raise AssertionError(h.message or "giriş yok")
        detail = f"sürüm {h.version}, uyumlu={h.compatible}"
        if h.message:
            detail += f" ({h.message})"
        return detail

    async def c_limits(self) -> str:
        windows = await self.adapter.read_limits(self.transport)
        (self.out / "limits.json").write_text(json.dumps([w.model_dump(mode="json") for w in windows], indent=2))
        if not windows:
            raise AssertionError("account/rateLimits/read boş döndü")
        return ", ".join(f"{w.label} %{w.used_percent:.0f}" for w in windows)

    async def c_account(self) -> str:
        acc = await self.adapter.read_account(self.transport)
        if acc is None or acc.account is None:
            raise AssertionError("hesap okunamadı")
        if acc.account.type != "chatgpt":
            raise AssertionError(f"hesap türü {acc.account.type} (ChatGPT aboneliği bekleniyordu)")
        return f"chatgpt, plan {acc.account.plan_type}"

    # -- quota checks (tiny prompts)

    async def c_stream(self) -> str:
        result, mark = await self.turn("Reply with exactly the word: merhaba")
        deltas = self.sink.of(MessageDelta, mark)
        usage = self.sink.of(Usage, mark)
        if result.status != "success":
            raise AssertionError(f"tur durumu {result.status}: {result.error}")
        if not deltas:
            raise AssertionError("MessageDelta gelmedi")
        if "merhaba" not in (result.text or "").lower():
            raise AssertionError(f"beklenmeyen yanıt: {result.text!r}")
        ctx = f", bağlam {usage[-1].context_used}/{usage[-1].context_window}" if usage else ", Usage yok"
        return f"{len(deltas)} parça{ctx}"

    async def c_approve(self) -> str:
        before = len(self.policy.requests)
        result, _ = await self.turn(
            "Run exactly this shell command in the current directory and nothing else: touch approved.txt"
        )
        reqs = [r for r in self.policy.requests[before:] if r.kind != ToolKind.file_edit]
        if not reqs:
            raise AssertionError("onay isteği gelmedi (approvalPolicy=untrusted beklenirdi)")
        if not (self.repo / "approved.txt").exists():
            raise AssertionError(f"approved.txt oluşmadı (tur: {result.status})")
        return f"istek: {reqs[0].summary}"

    async def c_deny(self) -> str:
        before = len(self.policy.requests)
        result, _ = await self.turn(
            "Run exactly this shell command in the current directory and nothing else: touch denied.txt. "
            "If it is not allowed, just say so."
        )
        reqs = self.policy.requests[before:]
        if not reqs:
            raise AssertionError("onay isteği gelmedi")
        if (self.repo / "denied.txt").exists():
            raise AssertionError("reddedilen komut yine de çalıştı")
        return f"reddedildi, tur {result.status}"

    async def c_file_change(self) -> str:
        before = len(self.policy.requests)
        result, mark = await self.turn(
            "Create a new file named hello.txt containing the single line hi. Use your file editing tool "
            "(apply_patch), not a shell command."
        )
        reqs = [r for r in self.policy.requests[before:] if r.kind == ToolKind.file_edit]
        changed = [c.path for c in self.sink.of(FileChanged, mark)]
        if not reqs:
            raise AssertionError(f"dosya değişikliği onayı gelmedi (FileChanged: {changed}, tur {result.status})")
        if "hello.txt" not in changed:
            raise AssertionError(f"FileChanged hello.txt yok: {changed}")
        return f"onay: {reqs[0].summary}; FileChanged {changed}"

    async def c_dynamic_tool(self) -> str:
        result, mark = await self.turn(
            "Call the aistudio_echo tool with text 'ping' and reply with exactly what it returned."
        )
        calls = [c for c in self.sink.of(ToolCall, mark) if c.kind == ToolKind.studio]
        if not self.tools.calls or not calls:
            raise AssertionError(f"araç çağrılmadı (tur {result.status}: {result.text!r})")
        if self.tools.token not in (result.text or ""):
            raise AssertionError(f"yanıtta araç çıktısı yok: {result.text!r}")
        return f"argümanlar {self.tools.calls[-1]['args']}"

    async def c_steer(self) -> str:
        session = await self.ensure_session()
        mark = len(self.sink.events)
        turn_id = await session.send("Count from 1 to 200, one number per line, with no other text.")
        await self._wait_for(lambda: bool(self.sink.of(MessageDelta, mark)), 120)
        await session.steer("Stop counting now and reply only with the word: yönlendirildi")
        result = await session.wait_turn(turn_id, timeout=TURN_TIMEOUT)
        steered = [m for m in self.sink.of(Message, mark) if m.role == "user"]
        errors = [e.message for e in self.sink.of(AgentErrorEv, mark)]
        if not steered:
            raise AssertionError(f"turn/steer başarısız: {errors}")
        detail = "yanıt yönlendirmeyi izledi" if "yönlendirildi" in (result.text or "").lower() else "yanıt farklı"
        return f"{detail} (tur {result.status})"

    async def c_interrupt(self) -> str:
        session = await self.ensure_session()
        mark = len(self.sink.events)
        turn_id = await session.send("Write a 400 word story about the sea.")
        await self._wait_for(lambda: bool(self.sink.of(TurnStarted, mark)), 60)
        await asyncio.sleep(2)
        await session.interrupt()
        result = await session.wait_turn(turn_id, timeout=60)
        if result.status != "interrupted":
            raise AssertionError(f"tur durumu {result.status}")
        return "turn/completed interrupted"

    async def c_resume(self) -> str:
        if self.session is not None:
            await self.session.close()
            self.session = None
        assert self.native_id
        mark = len(self.sink.events)
        session = await self.adapter.start(
            self.spec(resume_native_id=self.native_id),
            transport=self.transport,
            sink=self.sink,
            tools=self.tools,
            permissions=self.policy,
        )
        try:
            turn_id = await session.send("What single word did I ask you to reply with in my first message?")
            result = await session.wait_turn(turn_id, timeout=TURN_TIMEOUT)
        finally:
            await session.close()
        if session.native_id != self.native_id:
            raise AssertionError("farklı thread açıldı")
        remembered = "merhaba" in (result.text or "").lower()
        done = self.sink.of(TurnCompleted, mark)
        return f"thread/resume tamam, hafıza {'korundu' if remembered else 'belirsiz'} ({len(done)} tur)"

    async def c_subagents(self) -> str:
        before = len(self.policy.requests)
        result, mark = await self.turn(
            "Spawn exactly one sub-agent with your spawn_agent tool. Its task: run the shell command "
            "`touch subagent.txt` in the current directory, then reply with the single word: ready. "
            "Wait for it to finish, then reply with exactly what it reported."
        )
        started = self.sink.of(SubagentStarted, mark)
        if not started:
            raise AssertionError(
                f"alt ajan açılmadı (tur: {result.status}); bu Codex sürümünde çoklu ajan özelliği kapalı olabilir"
            )
        sid = started[0].subagent_id
        self.subagent_id = sid
        await self._wait_for(
            lambda: any(c.subagent_id == sid for c in self.sink.of(SubagentCompleted, mark)), TURN_TIMEOUT
        )
        done = next(c for c in self.sink.of(SubagentCompleted, mark) if c.subagent_id == sid)
        merged: dict[str, Any] = {}
        for st in started:
            if st.subagent_id == sid:
                merged.update({k: v for k, v in st.model_dump().items() if v is not None})
        inside = [e for e in self.sink.events[mark:] if getattr(e, "subagent_id", None) == sid]
        calls = [e.tool for e in inside if isinstance(e, ToolCall)]
        asked = [r for r in self.policy.requests[before:] if r.subagent_id == sid]
        if not inside:
            raise AssertionError("alt ajanın kendi olayları gelmedi (thread dinleyicisi?)")
        if not asked:
            raise AssertionError(f"alt ajan içinden onay isteği gelmedi (araçlar: {calls})")
        if done.status != "success":
            raise AssertionError(f"alt ajan sonucu {done.status}: {done.result_text!r}")
        return (
            f"ad={merged.get('name')}, model={merged.get('model')}, çağrı={merged.get('parent_call_id')}, "
            f"{len(inside)} olay, araçlar={calls}, onay={asked[0].summary!r}, "
            f"dosya={(self.repo / 'subagent.txt').exists()}"
        )

    async def c_listing(self) -> str:
        sessions = await self.adapter.list_native_sessions(self.transport, cwd=str(self.repo))
        ids = [s.native_id for s in sessions]
        if self.native_id not in ids:
            raise AssertionError(f"thread listede yok: {ids}")
        history = await self.adapter.read_native_history(self.transport, self.native_id or "")
        turns = [p for p in history if isinstance(p, TurnStarted)]
        (self.out / "history.jsonl").write_text(
            "\n".join(json.dumps(MASKER.mask_obj(p.model_dump(mode="json")), ensure_ascii=False) for p in history)
        )
        if not turns:
            raise AssertionError("geçmişte tur yok")
        detail = f"{len(sessions)} oturum, geçmiş {len(turns)} tur / {len(history)} olay"
        if self.subagent_id:
            subs = [p for p in history if isinstance(p, SubagentStarted) and p.subagent_id == self.subagent_id]
            if not subs:
                raise AssertionError("alt ajan geçmişte yok")
            if self.subagent_id in ids:
                raise AssertionError("alt ajan thread'i ayrı bir oturum olarak listelendi")
            inner = [p for p in history if getattr(p, "subagent_id", None) == self.subagent_id]
            detail += f", alt ajan geçmişte ({len(inner)} olay)"
        return detail

    async def c_limit_events(self) -> str:
        if not self.sink.limits_seen:
            raise AssertionError("tur sırasında account/rateLimits/updated gelmedi")
        last = self.sink.limits_seen[-1]
        return f"{len(self.sink.limits_seen)} pencere; son: {last.label} %{last.used_percent:.0f}"

    async def _wait_for(self, predicate: Callable[[], bool], timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() > deadline:
                raise TimeoutError("beklenen olay gelmedi")
            await asyncio.sleep(0.1)

    # -- main

    async def run(self) -> int:
        (self.repo / "README.md").write_text("# AI Studio codex verification\n")
        for vcs_args in (
            ("init", "-q", "-b", "main"),
            ("add", "."),
            ("-c", "user.name=AI Studio", "-c", "user.email=verify@example.com", "commit", "-q", "-m", "init"),
        ):
            res = await procmod.git(*vcs_args, cwd=str(self.repo))
            if res.returncode != 0:
                raise RuntimeError(f"git {' '.join(vcs_args)}: {res.stderr}")
        await self.check("Şema uyumu", self.c_schema, needs_login=False)
        await self.check("Sağlık", self.c_health, needs_login=False)
        await self.check("Limitler (okuma)", self.c_limits)
        await self.check("Hesap", self.c_account)
        await self.check("Akış", self.c_stream)
        if not self.args.quick:
            await self.check("Komut onayı (izin)", self.c_approve)
            await self.check("Komut onayı (red)", self.c_deny)
            await self.check("Dosya değişikliği onayı", self.c_file_change)
            await self.check("Dinamik Studio aracı", self.c_dynamic_tool)
            await self.check("Yönlendirme (steer)", self.c_steer)
            await self.check("Durdurma (interrupt)", self.c_interrupt)
            await self.check("Devam ettirme (resume)", self.c_resume)
        if self.args.subagents:
            await self.check("Yerel alt ajan (spawn_agent)", self.c_subagents)
        if self.session is not None:
            with contextlib.suppress(Exception):
                await self.session.close()
            self.session = None
        await self.check("Oturum listesi ve geçmiş", self.c_listing)
        await self.check("Limit bildirimi", self.c_limit_events)
        self.report()
        shutil.rmtree(self.repo, ignore_errors=True)
        return 1 if any(r.status == "BAŞARISIZ" for r in self.rows) else 0

    def report(self) -> None:
        (self.out / "report.json").write_text(
            json.dumps([r.__dict__ for r in self.rows], ensure_ascii=False, indent=2), encoding="utf-8"
        )
        width = max(len(r.name) for r in self.rows) + 2
        print(f"\nCodex adaptörü doğrulaması  ({datetime.now():%Y-%m-%d %H:%M})")
        print(f"{'Kontrol':<{width}}{'Sonuç':<12}{'Süre':>7}  Ayrıntı")
        print("-" * (width + 40))
        for r in self.rows:
            print(f"{r.name:<{width}}{r.status:<12}{r.seconds:>6.1f}s  {r.detail}")
        passed = sum(r.status == "BAŞARILI" for r in self.rows)
        failed = sum(r.status == "BAŞARISIZ" for r in self.rows)
        print(f"\n{passed} başarılı, {failed} başarısız, {len(self.rows) - passed - failed} atlandı.")
        print(f"Ham akışlar ve rapor: {self.out}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--codex", help="codex binary (default: codex on PATH)")
    ap.add_argument("--model", default=None, help="model (default: CLI default)")
    ap.add_argument("--effort", default="low", help="reasoning effort (default: low)")
    ap.add_argument("--quick", action="store_true", help="only free checks + one streaming turn")
    ap.add_argument(
        "--subagents", action="store_true", help="also check CLI-native sub-agents (costs a little extra quota)"
    )
    args = ap.parse_args()
    out_dir = OUT_ROOT / datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    return asyncio.run(Runner(args, out_dir).run())


if __name__ == "__main__":
    sys.exit(main())
