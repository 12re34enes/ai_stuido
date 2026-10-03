"""Real-CLI verification of the Claude Code adapter (spec §21 M0). Run on the Mac with a
logged-in ``claude``:

    cd backend && uv run python ../scripts/verify/claude/verify_claude.py [--model haiku] [--extended] [--subagents]

It creates a throwaway git repo, drives the REAL adapter with a handful of tiny prompts on a
cheap model and checks: health/login, the quota-free limit probe (get_usage), settings applied,
streaming, the studio MCP tool, permission allow + deny round-trips, rate_limit_event capture,
interrupt, session listing, history import and resume. ``--extended`` also checks steering.
``--subagents`` asks the model to spawn one CLI-native subagent (Agent tool, cheap model) that
runs a command needing permission, and checks SubagentStarted / tagged payloads (incl. forwarded
subagent text) / the permission request's subagent_id / SubagentCompleted and the subagent in the
imported history. It costs a little extra quota (one short subagent run).

Raw stdin/stdout lines (masked) and the normalized events are written to
``scripts/verify/out/claude/<timestamp>/``. Exit code 0 = every check passed.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import glob as _glob
import json
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from aistudio.adapters.claude import ClaudeAdapter, ClaudeSession
from aistudio.contracts.agents import (
    AgentEventPayload,
    Boundaries,
    FileChanged,
    Message,
    MessageDelta,
    PermissionDecision,
    PermissionRequest,
    SessionSpec,
    SubagentCompleted,
    SubagentStarted,
    ToolCall,
    ToolResultEv,
    TurnCompleted,
    TurnResult,
    TurnStarted,
    Usage,
)
from aistudio.contracts.limits import LimitWindow
from aistudio.contracts.tools import ToolResult, ToolSpec
from aistudio.contracts.transport import CompletedProcess, Process, Transport
from aistudio.core import proc as core_proc
from aistudio.core.errors import StudioError
from aistudio.security.masking import Masker

REPO_ROOT = Path(__file__).resolve().parents[3]
OUT_ROOT = REPO_ROOT / "scripts" / "verify" / "out" / "claude"
TURN_TIMEOUT = 240.0

Status = Literal["GEÇTİ", "KALDI", "UYARI", "ATLANDI"]


# --------------------------------------------------------------------------- transport


class _MiniProcess:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self._stderr = bytearray()
        self._task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        assert self._proc.stderr is not None
        while chunk := await self._proc.stderr.read(65536):
            self._stderr += chunk

    @property
    def pid(self) -> int | None:
        return self._proc.pid

    async def write(self, data: bytes) -> None:
        assert self._proc.stdin is not None
        self._proc.stdin.write(data)
        await self._proc.stdin.drain()

    async def close_stdin(self) -> None:
        if self._proc.stdin is not None and not self._proc.stdin.is_closing():
            self._proc.stdin.close()

    async def readline(self) -> bytes:
        assert self._proc.stdout is not None
        return await self._proc.stdout.readline()

    async def read_stderr(self) -> bytes:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(asyncio.shield(self._task), 5)
        return bytes(self._stderr)

    async def wait(self) -> int:
        return await self._proc.wait()

    async def terminate(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._proc.terminate()

    async def kill(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._proc.kill()


class _MiniLocalTransport:
    """Fallback when the agents workstream's LocalTransport is not available yet."""

    kind: Literal["local", "ssh"] = "local"
    host_id: str | None = None

    async def spawn(self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None) -> Process:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            limit=64 * 1024 * 1024,
        )
        return _MiniProcess(proc)

    async def run(
        self,
        argv: list[str],
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float | None = None,
        input: bytes | None = None,
    ) -> CompletedProcess:
        return await core_proc.run(argv, cwd=cwd, env=env, timeout=timeout, input=input)

    async def read_file(self, path: str) -> bytes:
        return await asyncio.to_thread(Path(path).read_bytes)

    async def write_file(self, path: str, data: bytes) -> None:
        await asyncio.to_thread(Path(path).write_bytes, data)

    async def exists(self, path: str) -> bool:
        return Path(path).exists()

    async def glob(self, pattern: str) -> list[str]:
        return sorted(_glob.glob(pattern, recursive=True))

    async def home(self) -> str:
        return str(Path.home())

    async def which(self, binary: str) -> str | None:
        return shutil.which(binary)


def _base_transport() -> Transport:
    try:
        from aistudio.agents.transport_local import LocalTransport  # type: ignore[import-not-found]

        return LocalTransport()  # type: ignore[no-any-return]
    except Exception:
        return _MiniLocalTransport()


class _TeeProcess:
    """Records every stdin/stdout line of a process for the raw stream dump."""

    def __init__(self, inner: Process, record: Callable[[str, bytes], None]) -> None:
        self._inner = inner
        self._record = record

    @property
    def pid(self) -> int | None:
        return self._inner.pid

    async def write(self, data: bytes) -> None:
        self._record("in", data)
        await self._inner.write(data)

    async def close_stdin(self) -> None:
        await self._inner.close_stdin()

    async def readline(self) -> bytes:
        line = await self._inner.readline()
        if line:
            self._record("out", line)
        return line

    async def read_stderr(self) -> bytes:
        data = await self._inner.read_stderr()
        if data:
            self._record("err", data)
        return data

    async def wait(self) -> int:
        return await self._inner.wait()

    async def terminate(self) -> None:
        await self._inner.terminate()

    async def kill(self) -> None:
        await self._inner.kill()


class TeeTransport:
    kind: Literal["local", "ssh"]
    host_id: str | None

    def __init__(self, inner: Transport, out_dir: Path, masker: Masker) -> None:
        self._inner = inner
        self.kind = inner.kind
        self.host_id = inner.host_id
        self._out_dir = out_dir
        self._masker = masker
        self._count = 0
        self.current_name = "process"

    async def spawn(self, argv: list[str], *, cwd: str | None = None, env: dict[str, str] | None = None) -> Process:
        self._count += 1
        path = self._out_dir / f"{self._count:02d}-{self.current_name}.jsonl"
        started = time.monotonic()
        masker = self._masker

        def record(direction: str, data: bytes) -> None:
            text = masker.mask(data.decode("utf-8", errors="replace").rstrip("\n"))
            entry = {"t_ms": int((time.monotonic() - started) * 1000), "dir": direction, "line": text}
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        record("argv", json.dumps(argv, ensure_ascii=False).encode())
        return _TeeProcess(await self._inner.spawn(argv, cwd=cwd, env=env), record)

    async def run(self, argv: list[str], **kw: Any) -> CompletedProcess:
        return await self._inner.run(argv, **kw)

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
    def __init__(self, path: Path, masker: Masker) -> None:
        self.events: list[AgentEventPayload] = []
        self.limits_seen: list[LimitWindow] = []
        self._path = path
        self._masker = masker
        self._changed = asyncio.Event()

    async def emit(self, payload: AgentEventPayload) -> None:
        self.events.append(payload)
        self._changed.set()
        entry = {"type": type(payload).__name__, "payload": self._masker.mask_obj(payload.model_dump(mode="json"))}
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    async def limits(self, windows: list[LimitWindow]) -> None:
        self.limits_seen.extend(windows)
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"type": "limits", "windows": [w.model_dump(mode="json") for w in windows]}) + "\n")

    def mark(self) -> int:
        return len(self.events)

    def since[T](self, mark: int, cls: type[T]) -> list[T]:
        return [e for e in self.events[mark:] if isinstance(e, cls)]

    async def wait_for(self, mark: int, cls: type, timeout: float) -> bool:
        """Wait until an event of ``cls`` arrived after ``mark``."""
        deadline = time.monotonic() + timeout
        while not self.since(mark, cls):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            self._changed.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._changed.wait(), remaining)
        return True


class PingTools:
    def __init__(self) -> None:
        self.code = f"kiwi-{secrets.token_hex(2)}"
        self.calls: list[str] = []

    def specs(self) -> list[ToolSpec]:
        return [ToolSpec(name="verify_ping", description="Returns a verification code. Takes no arguments.")]

    async def call(self, name: str, args: dict[str, Any]) -> ToolResult:
        self.calls.append(name)
        if name == "verify_ping":
            return ToolResult(content=self.code)
        return ToolResult(content=f"unknown tool {name}", is_error=True)


class Permissions:
    def __init__(self) -> None:
        self.requests: list[PermissionRequest] = []

    async def __call__(self, req: PermissionRequest) -> PermissionDecision:
        self.requests.append(req)
        if req.tool == "Bash" and req.command and "denied.txt" in req.command:
            return PermissionDecision(allow=False, reason="Denied by the verification script.", decided_by="policy")
        return PermissionDecision(allow=True, decided_by="policy")


# --------------------------------------------------------------------------- checks


@dataclass
class Check:
    name: str
    status: Status = "ATLANDI"
    detail: str = ""


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    def add(self, name: str, ok: bool | None, detail: str = "", *, warn: bool = False) -> None:
        status: Status = "ATLANDI" if ok is None else ("GEÇTİ" if ok else ("UYARI" if warn else "KALDI"))
        self.checks.append(Check(name, status, detail))
        print(f"  [{status}] {name}{(' — ' + detail) if detail else ''}", flush=True)

    async def run(self, name: str, fn: Callable[[], Awaitable[tuple[bool | None, str]]], *, warn: bool = False) -> None:
        try:
            ok, detail = await fn()
        except Exception as e:
            ok, detail = False, f"{type(e).__name__}: {e}"
            if not isinstance(e, StudioError):  # expected errors carry their own message
                traceback.print_exc()
        self.add(name, ok, detail, warn=warn)

    def table(self) -> str:
        w = max(len(c.name) for c in self.checks) + 2
        lines = [f"{'Kontrol'.ljust(w)}{'Sonuç'.ljust(9)}Ayrıntı", "-" * (w + 60)]
        lines += [f"{c.name.ljust(w)}{c.status.ljust(9)}{c.detail}" for c in self.checks]
        return "\n".join(lines)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def make_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aistudio-verify-claude-")).resolve()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.email", "verify@example.com")
    _git(repo, "config", "user.name", "Verify")
    (repo / "README.md").write_text("# verify\n")
    (repo / "secret.txt").write_text("do not read\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-m", "init")
    return repo


async def turn(session: ClaudeSession, text: str) -> TurnResult:
    return await session.wait_turn(await session.send(text), timeout=TURN_TIMEOUT)


def _text_since(sink: Sink, mark: int) -> str:
    return "\n".join(m.text for m in sink.since(mark, Message) if m.role == "assistant")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Claude Code adaptörü gerçek CLI doğrulaması")
    parser.add_argument("--model", default="haiku", help="ucuz model (varsayılan: haiku)")
    parser.add_argument("--effort", default=None, help="isteğe bağlı effort seviyesi")
    parser.add_argument("--extended", action="store_true", help="steer (yönlendirme) kontrolünü de çalıştır")
    parser.add_argument(
        "--subagents",
        action="store_true",
        help="yerel alt ajan (Agent aracı) kontrolünü de çalıştır; biraz ek kota harcar",
    )
    parser.add_argument("--keep-repo", action="store_true", help="geçici repoyu silme")
    parser.add_argument(
        "--binary", default=None, help="claude yolu (PATH'te değilse); boşlukla ayrılmış komut olabilir"
    )
    return parser.parse_args()


async def main() -> int:
    args = parse_args()
    repo = make_repo()
    try:
        return await run_checks(args, repo)
    finally:
        if args.keep_repo:
            print(f"Geçici repo korundu: {repo}")
        else:
            shutil.rmtree(repo, ignore_errors=True)


async def run_checks(args: argparse.Namespace, repo: Path) -> int:
    out_dir = OUT_ROOT / datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir.mkdir(parents=True, exist_ok=True)
    masker = Masker()
    transport = TeeTransport(_base_transport(), out_dir, masker)
    adapter = ClaudeAdapter(binary=shlex.split(args.binary) if args.binary else None)
    report = Report()
    print(f"Geçici repo: {repo}\nÇıktılar: {out_dir}\n", flush=True)

    # ---------------------------------------------------------------- no-quota checks
    health = await adapter.health(transport)
    report.add(
        "Kurulum ve sürüm",
        health.installed and bool(health.compatible),
        f"{health.binary} sürüm {health.version} (test aralığı {health.tested_range}) {health.message or ''}".strip(),
    )
    report.add("Giriş durumu (auth status)", health.logged_in is True, str(health.logged_in))
    if not health.installed or health.logged_in is False:
        print("\n" + report.table())
        return 1

    async def limits_probe() -> tuple[bool | None, str]:
        transport.current_name = "usage-probe"
        windows = await adapter.read_limits(transport)
        detail = ", ".join(f"{w.label}: %{w.used_percent:.0f}" for w in windows) or "boş döndü"
        return bool(windows), detail

    await report.run("Limit sorgusu (get_usage, kota harcamaz)", limits_probe, warn=True)

    # ---------------------------------------------------------------- session 1
    tools = PingTools()
    perms = Permissions()
    sink = Sink(out_dir / "events-session1.jsonl", masker)
    spec = SessionSpec(
        provider="claude",
        cwd=str(repo),
        model=args.model,
        effort=args.effort,
        system_append="You are being verified by an automated script. Keep every answer extremely short.",
        boundaries=Boundaries(forbidden_paths=["secret.txt"]),
    )
    transport.current_name = "session1"
    try:
        session = await adapter.start(spec, transport=transport, sink=sink, tools=tools, permissions=perms)
    except Exception as e:
        report.add("Oturum başlatma (initialize)", False, str(e))
        print("\n" + report.table())
        return 1
    native_id = session.native_id or ""
    report.add("Oturum başlatma (initialize)", True, f"oturum {native_id}")

    async def settings_applied() -> tuple[bool | None, str]:
        rules = json.dumps(await session.control("list_permission_rules"), ensure_ascii=False)
        ok = "secret.txt" in rules and "mcp__studio" in rules
        return ok, "deny Read(secret.txt) ve allow mcp__studio görüldü" if ok else rules[:300]

    await report.run("Ayarlar uygulandı (list_permission_rules)", settings_applied)

    async def streaming() -> tuple[bool | None, str]:
        mark = sink.mark()
        result = await turn(session, "Reply with exactly one word: pineapple")
        deltas = sink.since(mark, MessageDelta)
        text = _text_since(sink, mark)
        usage = sink.since(mark, Usage)
        ok = result.status == "success" and bool(deltas) and "pineapple" in text.lower()
        ctx = f"bağlam {usage[-1].context_used}/{usage[-1].context_window}" if usage else "kullanım yok"
        return ok, f"{len(deltas)} delta, metin={text!r}, {ctx}, model={session.model}"

    await report.run("Akış: delta + mesaj + kullanım", streaming)

    async def studio_tool() -> tuple[bool | None, str]:
        mark = sink.mark()
        result = await turn(
            session, "Call the mcp__studio__verify_ping tool once, then reply with exactly the code it returned."
        )
        text = _text_since(sink, mark)
        calls = [c for c in sink.since(mark, ToolCall) if c.tool == "mcp__studio__verify_ping"]
        ok = result.status == "success" and bool(tools.calls) and tools.code in text and bool(calls)
        return ok, f"araç çağrıları={tools.calls}, kod={tools.code}, metin={text!r}"

    await report.run("Studio MCP aracı (mcp_message)", studio_tool)

    async def permission_allow() -> tuple[bool | None, str]:
        mark = sink.mark()
        before = len(perms.requests)
        result = await turn(
            session,
            "Use the Write tool to create a file named hello.txt containing the single word hi. Use no other tool.",
        )
        asked = [r for r in perms.requests[before:] if r.tool == "Write"]
        changes = [c for c in sink.since(mark, FileChanged) if c.path == "hello.txt"]
        exists = (repo / "hello.txt").exists()
        ok = result.status == "success" and bool(asked) and exists and bool(changes)
        detail = f"izin istekleri={[r.tool for r in perms.requests[before:]]}, dosya={exists}, "
        detail += f"değişiklik={[(c.path, c.change) for c in changes]}"
        return ok, detail

    await report.run("İzin isteği → izin ver (can_use_tool)", permission_allow)

    async def permission_deny() -> tuple[bool | None, str]:
        mark = sink.mark()
        before = len(perms.requests)
        await turn(session, "Run exactly this shell command with the Bash tool: touch denied.txt")
        asked = [r for r in perms.requests[before:] if r.tool == "Bash"]
        errors = [r for r in sink.since(mark, ToolResultEv) if r.is_error]
        exists = (repo / "denied.txt").exists()
        ok = bool(asked) and not exists and bool(errors)
        return ok, f"istenen komut={[r.command for r in asked]}, dosya oluştu={exists}, hata sonucu={len(errors)}"

    await report.run("İzin isteği → reddet", permission_deny)

    report.add(
        "rate_limit_event yakalandı",
        bool(sink.limits_seen),
        ", ".join(f"{w.window}=%{w.used_percent:.0f} ({w.status})" for w in sink.limits_seen[-4:]) or "olay gelmedi",
        warn=True,
    )

    async def interrupt() -> tuple[bool | None, str]:
        mark = sink.mark()
        turn_id = await session.send("Count from 1 to 400, one number per line, no other text.")
        started = time.monotonic()
        await sink.wait_for(mark, MessageDelta, 90)
        await session.interrupt()
        result = await session.wait_turn(turn_id, timeout=60)
        return result.status == "interrupted", f"durum={result.status}, kesme süresi={time.monotonic() - started:.1f}s"

    await report.run("Kesme (interrupt)", interrupt)

    if args.extended:

        async def steer() -> tuple[bool | None, str]:
            mark = sink.mark()
            turn_id = await session.send("Run the shell command `sleep 4` with the Bash tool, then reply with: done")
            await sink.wait_for(mark, ToolCall, 90)
            await session.steer("Also add the word mango at the very end of your reply.")
            result = await session.wait_turn(turn_id, timeout=TURN_TIMEOUT)
            await asyncio.sleep(2)
            turns = sink.since(mark, TurnStarted)
            text = _text_since(sink, mark)
            folded = len(turns) == 1
            ok = "mango" in text.lower()
            return ok, f"tura katıldı={folded}, tur sayısı={len(turns)}, durum={result.status}, metin={text!r}"

        await report.run("Yönlendirme (steer)", steer, warn=True)

    subagent_id: str | None = None
    if args.subagents:

        async def subagents() -> tuple[bool | None, str]:
            nonlocal subagent_id
            mark = sink.mark()
            before = len(perms.requests)
            result = await turn(
                session,
                'Use the Agent tool exactly once with subagent_type "general-purpose", model "haiku" and '
                'run_in_background false. Give the subagent this task: "Run the shell command '
                '`touch subagent.txt` with the Bash tool, then reply with the single word: ready". '
                "When it has finished, reply with exactly what it reported.",
            )
            started = sink.since(mark, SubagentStarted)
            if not started:
                return False, f"SubagentStarted gelmedi (durum={result.status})"
            subagent_id = started[0].subagent_id
            # a background run (CLI default) ends later with a task_notification
            deadline = time.monotonic() + TURN_TIMEOUT
            while not any(d.subagent_id == subagent_id for d in sink.since(mark, SubagentCompleted)):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not await sink.wait_for(sink.mark(), SubagentCompleted, remaining):
                    break
            done = [d for d in sink.since(mark, SubagentCompleted) if d.subagent_id == subagent_id]
            inside = [e for e in sink.events[mark:] if getattr(e, "subagent_id", None) == subagent_id]
            calls = [e.tool for e in inside if isinstance(e, ToolCall)]
            texts = [e for e in inside if isinstance(e, Message)]
            asked = [r for r in perms.requests[before:] if r.subagent_id == subagent_id]
            merged: dict[str, Any] = {}
            for s in started:
                if s.subagent_id == subagent_id:
                    merged.update({k: v for k, v in s.model_dump().items() if v is not None})
            ok = bool(done) and done[0].status == "success" and "Bash" in calls and bool(asked)
            detail = (
                f"ad={merged.get('name')}, model={merged.get('model')}, iç araçlar={calls}, "
                f"iletilen metin={len(texts)}, alt ajan izin istekleri={len(asked)}, "
                f"sonuç={done[0].status if done else 'yok'}, kullanım="
                f"{(done[0].usage.input_tokens, done[0].usage.output_tokens) if done and done[0].usage else None}, "
                f"dosya={(repo / 'subagent.txt').exists()}"
            )
            return ok, detail

        await report.run("Yerel alt ajan (Agent aracı)", subagents)

    await session.close()

    # ---------------------------------------------------------------- listing / history / resume
    async def listing() -> tuple[bool | None, str]:
        sessions = await adapter.list_native_sessions(transport, cwd=str(repo))
        mine = [s for s in sessions if s.native_id == native_id]
        if not mine:
            return False, f"{len(sessions)} oturum bulundu, {native_id} yok"
        s = mine[0]
        return True, f"başlık={s.title!r}, model={s.model}, mesaj={s.message_count}, dal={s.branch}"

    await report.run("Mevcut oturumları listeleme", listing)

    async def history() -> tuple[bool | None, str]:
        payloads = await adapter.read_native_history(transport, native_id, cwd=str(repo))
        turns = [p for p in payloads if isinstance(p, TurnStarted)]
        done = [p for p in payloads if isinstance(p, TurnCompleted)]
        detail = f"{len(payloads)} olay, {len(turns)} tur, {len(done)} tamamlanan"
        ok = len(turns) >= 4
        if subagent_id:  # replayed from <session>/subagents/agent-<id>.jsonl
            subs = [p for p in payloads if isinstance(p, SubagentStarted) and p.subagent_id == subagent_id]
            inner = [p for p in payloads if getattr(p, "subagent_id", None) == subagent_id]
            ok = ok and bool(subs)
            detail += f", alt ajan geçmişte={bool(subs)} ({len(inner)} olay)"
        return ok, detail

    await report.run("Geçmişi içe aktarma (jsonl)", history)

    async def resume() -> tuple[bool | None, str]:
        sink2 = Sink(out_dir / "events-session2.jsonl", masker)
        transport.current_name = "session2-resume"
        resumed = await adapter.start(
            spec.model_copy(update={"resume_native_id": native_id}),
            transport=transport,
            sink=sink2,
            tools=tools,
            permissions=perms,
        )
        try:
            result = await turn(
                resumed, "What single word did I ask you to reply with first? Reply with just that word."
            )
            text = _text_since(sink2, 0)
        finally:
            await resumed.close()
        ok = result.status == "success" and "pineapple" in text.lower() and resumed.native_id == native_id
        return ok, f"oturum={resumed.native_id}, metin={text!r}"

    await report.run("Devam ettirme (--resume)", resume)

    # ---------------------------------------------------------------- report
    print("\n" + report.table())
    (out_dir / "summary.json").write_text(
        json.dumps(
            {
                "health": health.model_dump(mode="json"),
                "native_id": native_id,
                "checks": [c.__dict__ for c in report.checks],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    failed = [c for c in report.checks if c.status == "KALDI"]
    print(f"\n{'TÜM KONTROLLER GEÇTİ' if not failed else f'{len(failed)} KONTROL KALDI'} — çıktılar: {out_dir}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
