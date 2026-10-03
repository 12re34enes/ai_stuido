from __future__ import annotations

from pathlib import Path

from memory_helpers import MemEnv, eventually
from pydantic import BaseModel

from aistudio.contracts.agents import (
    PAYLOAD_EVENT_TYPE,
    AgentErrorEv,
    FileChanged,
    Message,
    SessionEnded,
    SessionStarted,
    ToolCall,
    ToolKind,
    ToolResultEv,
    TurnCompleted,
    TurnStarted,
    Usage,
)
from aistudio.core.events import EventFilter
from aistudio.memory.service import SETTING_AUTO_SUMMARIES, MemoryProposalRecord
from aistudio.memory.summaries import SessionMeta, build_session_summary, fmt_duration, fmt_int


async def _emit(env: MemEnv, session_id: str, payload: BaseModel, *, workspace_id: str | None = None) -> None:
    await env.ctx.events.append(
        PAYLOAD_EVENT_TYPE[type(payload)],
        payload.model_dump(mode="json"),
        actor=f"agent:{session_id}",
        workspace_id=workspace_id or env.ws.id,
        session_id=session_id,
    )


async def _run_session(env: MemEnv, session_id: str = "ses_01ABC", *, end: bool = True) -> None:
    await _emit(env, session_id, SessionStarted(native_id="n1", model="claude-opus", cwd="/tmp/repo"))
    await _emit(env, session_id, TurnStarted(turn_id="t1", input="Giriş sayfasındaki 500 hatasını düzelt"))
    await _emit(
        env,
        session_id,
        ToolCall(call_id="c1", tool="Bash", kind=ToolKind.command, input={"command": "pytest -q tests/test_login.py"}),
    )
    await _emit(env, session_id, ToolResultEv(call_id="c1", output="1 failed", exit_code=1, is_error=True))
    await _emit(env, session_id, FileChanged(path="src/login.py", change="modify"))
    await _emit(env, session_id, FileChanged(path="tests/test_login.py", change="add"))
    suite = ToolCall(call_id="c2", tool="Bash", kind=ToolKind.command, input={"command": "pytest -q"})
    await _emit(env, session_id, suite)
    await _emit(env, session_id, ToolResultEv(call_id="c2", output="ok", exit_code=0))
    await _emit(env, session_id, Message(message_id="m1", text="Ara not"))
    await _emit(env, session_id, AgentErrorEv(message="Geçici ağ hatası", retryable=True))
    usage = Usage(input_tokens=12345, output_tokens=2100, cache_read_tokens=500)
    result = "Hata düzeltildi; null kontrolü eklendi."
    await _emit(env, session_id, TurnCompleted(turn_id="t1", status="success", result_text=result, usage=usage))
    if end:
        await _emit(env, session_id, SessionEnded(reason="completed", exit_code=0))


async def test_build_summary_from_events(mem: MemEnv) -> None:
    await _run_session(mem)
    events = await mem.ctx.events.query(EventFilter(session_id="ses_01ABC"))
    built = build_session_summary(
        "ses_01ABC", events, SessionMeta(label="Geliştirici", provider="claude", task_title="Giriş hatası")
    )
    assert built is not None
    path, md = built
    assert path.startswith("sessions/") and path.endswith("-ses-01abc.md")
    assert md.startswith("# Oturum özeti: Giriş hatası\n")
    assert "- **Oturum:** `ses_01ABC` — Geliştirici (Claude, claude-opus)" in md
    assert "- **Görev:** Giriş hatası" in md
    assert "tamamlandı" in md and "1 tur" in md
    assert "giriş 12.345, çıkış 2.100, önbellek 500" in md
    assert "> Giriş sayfasındaki 500 hatasını düzelt" in md
    assert "## Sonuç\n\nHata düzeltildi; null kontrolü eklendi." in md
    assert "- `src/login.py` (değiştirildi)" in md and "- `tests/test_login.py` (eklendi)" in md
    assert "- `pytest -q tests/test_login.py` — çıkış kodu 1" in md
    assert "- `pytest -q` — çıkış kodu 0" in md
    assert "## Hatalar\n\n- Geçici ağ hatası" in md


def test_empty_session_produces_no_summary() -> None:
    assert build_session_summary("ses_x", []) is None


def test_formatters() -> None:
    assert fmt_int(1234567) == "1.234.567"
    assert fmt_duration(42) == "42 sn"
    assert fmt_duration(125) == "2 dk 5 sn"
    assert fmt_duration(3600 * 2 + 60) == "2 sa 1 dk"


async def test_session_end_proposes_summary_which_applies_on_approval(mem: MemEnv) -> None:
    mem.svc.start()
    await _run_session(mem, "ses_flow")

    async def proposal() -> str | None:
        # The row is inserted before its approval is requested; wait until it is linked.
        recs = await mem.svc.list_proposals(mem.ws.id)
        return recs[0].id if recs and recs[0].approval_id else None

    pid = await eventually(proposal)
    assert pid is not None
    rec = await mem.svc.get_proposal(pid)
    assert rec.layer == "sessions" and rec.source_session_id == "ses_flow"
    assert rec.rationale == "Oturum sona erdiği için otomatik oluşturulan özet."
    assert rec.approval_id
    approval = await mem.approvals.get(rec.approval_id)
    assert approval.requested_by == "system"

    await mem.approvals.decide(rec.approval_id, approve=True)

    async def applied() -> bool:
        return (await mem.svc.get_proposal(pid)).status == "applied"

    await eventually(applied)
    root: Path = mem.ctx.settings.paths.memory_dir(mem.ws.slug)
    assert (root / rec.path).read_text().startswith("# Oturum özeti:")
    context = await mem.svc.context_for_agent(mem.ws.id, role="writer")
    assert "Giriş sayfasındaki 500 hatasını düzelt" in context  # session title in "Son oturumlar"

    # A duplicate end event does not create a second proposal.
    ended = await mem.ctx.events.query(EventFilter(session_id="ses_flow", types=["agent.session.ended"]))
    assert await mem.svc.summarize_session(ended[0]) is None


async def test_summaries_can_be_disabled(mem: MemEnv) -> None:
    await mem.ctx.store.set(SETTING_AUTO_SUMMARIES, False)
    mem.svc.start()
    await _run_session(mem, "ses_off")
    # A later memory proposal proves the listener processed the session end before it.
    await mem.svc.propose(mem.ws.id, path="facts.md", new_content="# Proje gerçekleri\n\nişaret\n")

    async def only_marker() -> bool:
        return len(await mem.svc.list_proposals(mem.ws.id)) >= 1

    await eventually(only_marker)
    recs = await mem.svc.list_proposals(mem.ws.id)
    assert [r.layer for r in recs] == ["facts"]


async def test_session_without_activity_is_skipped(mem: MemEnv) -> None:
    await _emit(mem, "ses_idle", SessionStarted(native_id="n", cwd="/tmp"))
    await _emit(mem, "ses_idle", SessionEnded(reason="closed"))
    ended = await mem.ctx.events.query(EventFilter(session_id="ses_idle", types=["agent.session.ended"]))
    assert await mem.svc.summarize_session(ended[0]) is None


async def test_flow_sessions_get_one_task_summary_instead_of_per_session(mem: MemEnv) -> None:
    """Sessions that belong to a task produce no per-session proposal; the finished task produces
    exactly one summary covering every agent and gate."""
    mem.svc.start()
    task_id = "task_01FLOWSUMMARY"

    async def emit(session_id: str, payload: BaseModel) -> None:
        await mem.ctx.events.append(
            PAYLOAD_EVENT_TYPE[type(payload)],
            payload.model_dump(mode="json"),
            actor=f"agent:{session_id}",
            workspace_id=mem.ws.id,
            session_id=session_id,
            task_id=task_id,
        )

    for sid, text in (("ses_writer", "Değişiklik yapıldı."), ("ses_reviewer", "Engelleyici sorun yok.")):
        await emit(sid, SessionStarted(native_id=sid, model="m", cwd="/tmp/repo"))
        await emit(sid, TurnStarted(turn_id="t1", input="README'yi güncelle"))
        await emit(sid, FileChanged(path="README.md", change="modify"))
        await emit(sid, TurnCompleted(turn_id="t1", status="success", result_text=text))
        await emit(sid, SessionEnded(reason="completed", exit_code=0))
    await mem.ctx.events.append(
        "gate.passed", {"gate": "build_test", "summary": "1 komut geçti"}, workspace_id=mem.ws.id, task_id=task_id
    )
    await mem.ctx.events.append(
        "task.completed", {"title": "README güncelle", "quality_score": 92}, workspace_id=mem.ws.id, task_id=task_id
    )

    async def one_proposal() -> list[MemoryProposalRecord] | None:
        recs = await mem.svc.list_proposals(mem.ws.id)
        return recs if recs and all(r.approval_id for r in recs) else None

    recs = await eventually(one_proposal)
    assert recs is not None and len(recs) == 1
    rec = recs[0]
    assert rec.source_session_id is None and rec.rationale == "Görev bittiği için otomatik oluşturulan özet."
    assert rec.path.startswith("sessions/") and "gorev-readme-guncelle" in rec.path
    assert rec.new_content.startswith("# Görev özeti: README güncelle")
    assert "Build/test kanıtı: geçti" in rec.new_content and "`README.md`" in rec.new_content
    assert "Kalite puanı:** 92/100" in rec.new_content
