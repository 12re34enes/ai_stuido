from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from memory_helpers import MemEnv, eventually

from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.core.errors import ValidationFailed
from aistudio.core.events import EventFilter, Severity
from aistudio.memory.service import MemoryProposalRecord

FACTS_V1 = (
    "# Proje gerçekleri\n\n## Amaç\nÖdeme altyapısı.\n\n## Komutlar\n`make test`\n\n## Sözlük\nPSP: ödeme sağlayıcı\n"
)


def _root(env: MemEnv) -> Path:
    return env.ctx.settings.paths.memory_dir(env.ws.slug)


def _git(root: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True).stdout


async def _settled(env: MemEnv, proposal_id: str) -> MemoryProposalRecord:
    async def check() -> MemoryProposalRecord | None:
        rec = await env.svc.get_proposal(proposal_id)
        return rec if rec.status != "pending" else None

    rec = await eventually(check)
    assert rec is not None
    return rec


async def test_propose_creates_pending_proposal_and_approval(mem: MemEnv) -> None:
    await mem.svc.write(mem.ws.id, "facts.md", FACTS_V1, message="v1")
    new = FACTS_V1.replace("`make test`", "`make test`\n`make lint`")
    p = await mem.svc.propose(
        mem.ws.id, path="facts.md", new_content=new, rationale="Lint komutu eklendi", source_session_id="ses_1"
    )
    assert p.status == "pending" and p.layer == "facts" and p.approval_id
    assert p.old_content == FACTS_V1
    assert "+`make lint`" in p.diff and p.diff.startswith("--- a/facts.md\n+++ b/facts.md\n")
    # Nothing is written before approval.
    assert (_root(mem) / "facts.md").read_text() == FACTS_V1

    approval = await mem.approvals.get(p.approval_id)
    assert approval.kind == ApprovalKind.memory
    assert approval.severity == Severity.normal
    assert approval.title == "Hafıza önerisi: facts.md"
    assert approval.requested_by == "agent:ses_1"
    assert approval.payload["proposal_id"] == p.id
    assert approval.payload["content"] == new
    assert approval.payload["diff"] == p.diff
    assert approval.payload["additions"] == 1 and approval.payload["deletions"] == 0

    events = await mem.ctx.events.query(EventFilter(types=["memory.proposed"]))
    assert len(events) == 1
    assert events[0].severity == Severity.info
    assert events[0].payload["proposal_id"] == p.id and events[0].session_id == "ses_1"

    listed = await mem.svc.list_proposals(mem.ws.id, status="pending")
    assert [r.id for r in listed] == [p.id]


async def test_approved_proposal_is_committed(mem: MemEnv) -> None:
    mem.svc.start()
    await mem.svc.write(mem.ws.id, "facts.md", FACTS_V1, message="v1")
    new = FACTS_V1 + "\n## Ortamlar\ntest: staging.local\n"
    p = await mem.svc.propose(mem.ws.id, path="facts.md", new_content=new, rationale="Ortam", source_session_id="ses_9")
    assert p.approval_id
    await mem.approvals.decide(p.approval_id, approve=True)
    rec = await _settled(mem, p.id)
    assert rec.status == "applied" and not rec.edited and rec.commit_sha
    assert (_root(mem) / "facts.md").read_text() == new
    history = await mem.svc.history(mem.ws.id)
    assert history[0].sha == rec.commit_sha
    assert history[0].message == "Hafıza önerisi uygulandı: facts.md"
    assert history[0].actor == "agent:ses_9"
    assert history[0].body == "Ortam"
    trailers = _git(_root(mem), "log", "-1", "--format=%(trailers)")
    assert f"AI-Studio-Proposal: {p.id}" in trailers
    applied = await mem.ctx.events.query(EventFilter(types=["memory.applied"]))
    assert applied[0].payload["commit"] == rec.commit_sha and applied[0].payload["edited"] is False


async def test_user_edited_content_is_applied(mem: MemEnv) -> None:
    mem.svc.start()
    p = await mem.svc.propose(
        mem.ws.id, path="decisions/2026-10-03-kuyruk.md", new_content="# Kuyruk\n\nRabbitMQ.\n", rationale="Karar"
    )
    assert p.approval_id and p.old_content is None
    assert p.diff.startswith("--- /dev/null\n")
    edited = "# Kuyruk\n\nNATS kullanılacak.\n"
    await mem.approvals.decide(p.approval_id, approve=True, decision_payload={"content": edited})
    rec = await _settled(mem, p.id)
    assert rec.status == "applied" and rec.edited is True
    assert rec.new_content == edited
    assert (_root(mem) / "decisions/2026-10-03-kuyruk.md").read_text() == edited


async def test_rejected_proposal_leaves_memory_untouched(mem: MemEnv) -> None:
    mem.svc.start()
    head = await mem.svc.head(mem.ws.id)
    p = await mem.svc.propose(mem.ws.id, path="facts.md", new_content="# Proje gerçekleri\n\nyanlış\n")
    assert p.approval_id
    await mem.approvals.decide(p.approval_id, approve=False, note="Bu bilgi yanlış")
    rec = await _settled(mem, p.id)
    assert rec.status == "rejected" and rec.note == "Bu bilgi yanlış"
    assert await mem.svc.head(mem.ws.id) == head
    rejected = await mem.ctx.events.query(EventFilter(types=["memory.rejected"]))
    assert rejected[0].payload["proposal_id"] == p.id
    assert rejected[0].payload["status"] == ApprovalStatus.rejected.value


async def test_cancelled_approval_rejects_proposal(mem: MemEnv) -> None:
    mem.svc.start()
    p = await mem.svc.propose(mem.ws.id, path="facts.md", new_content="# Proje gerçekleri\n\niptal\n")
    assert p.approval_id
    await mem.approvals.cancel(p.approval_id)
    rec = await _settled(mem, p.id)
    assert rec.status == "rejected" and rec.note == "Onay isteği iptal edildi."


async def test_non_conflicting_concurrent_edit_is_merged(mem: MemEnv) -> None:
    mem.svc.start()
    await mem.svc.write(mem.ws.id, "facts.md", FACTS_V1, message="v1")
    proposed = FACTS_V1.replace("Ödeme altyapısı.", "Ödeme altyapısı (kartlı ve havale).")
    p = await mem.svc.propose(mem.ws.id, path="facts.md", new_content=proposed)
    user_edit = FACTS_V1.replace("PSP: ödeme sağlayıcı", "PSP: ödeme hizmet sağlayıcısı")
    await mem.svc.write(mem.ws.id, "facts.md", user_edit, message="sözlük")
    assert p.approval_id
    await mem.approvals.decide(p.approval_id, approve=True)
    rec = await _settled(mem, p.id)
    assert rec.status == "applied"
    final = (_root(mem) / "facts.md").read_text()
    assert "kartlı ve havale" in final and "ödeme hizmet sağlayıcısı" in final


async def test_conflicting_concurrent_edit_is_rejected_with_note(mem: MemEnv) -> None:
    mem.svc.start()
    await mem.svc.write(mem.ws.id, "facts.md", FACTS_V1, message="v1")
    p = await mem.svc.propose(mem.ws.id, path="facts.md", new_content=FACTS_V1.replace("Ödeme", "Agent"))
    await mem.svc.write(mem.ws.id, "facts.md", FACTS_V1.replace("Ödeme", "Kullanıcı"), message="çakışan")
    assert p.approval_id
    await mem.approvals.decide(p.approval_id, approve=True)
    rec = await _settled(mem, p.id)
    assert rec.status == "rejected" and rec.note and "birleştirilemedi" in rec.note
    assert "Kullanıcı" in (_root(mem) / "facts.md").read_text()
    assert await mem.ctx.events.query(EventFilter(types=["memory.conflict"]))


async def test_boundaries_proposal_is_highlighted(mem: MemEnv) -> None:
    p = await mem.svc.propose(
        mem.ws.id,
        path="boundaries.md",
        new_content="---\nnetwork: true\nsandbox: hepsi\n---\n# Sınırlar\n",
        rationale="Daha fazla yetki",
        source_session_id="ses_x",
    )
    assert p.approval_id
    approval = await mem.approvals.get(p.approval_id)
    assert approval.severity == Severity.high
    assert approval.summary and approval.summary.startswith("Sınırları değiştiren öneri")
    assert any("sandbox" in w for w in approval.payload["boundary_warnings"])


async def test_identical_or_empty_content_is_rejected(mem: MemEnv) -> None:
    current = (await mem.svc.read(mem.ws.id, "facts.md")).content
    with pytest.raises(ValidationFailed):
        await mem.svc.propose(mem.ws.id, path="facts.md", new_content=current)
    with pytest.raises(ValidationFailed):
        await mem.svc.propose(mem.ws.id, path="facts.md", new_content="   \n")
    with pytest.raises(ValidationFailed):
        await mem.svc.propose(mem.ws.id, path="notes/x.md", new_content="x")


async def test_secrets_are_masked_in_proposals(mem: MemEnv) -> None:
    token = "gh" + "p_" + "Q7rT" * 9  # built at runtime: no secret literal in the repo
    p = await mem.svc.propose(mem.ws.id, path="facts.md", new_content=f"# Proje gerçekleri\n\nCI belirteci: {token}\n")
    assert token not in p.new_content and "[gizli]" in p.new_content
    assert p.approval_id
    approval = await mem.approvals.get(p.approval_id)
    assert token not in approval.payload["content"]


async def test_settle_is_idempotent_and_reconcile_applies_missed_decisions(mem: MemEnv) -> None:
    # Decided while the listener is not running (e.g. app restarted in between).
    p = await mem.svc.propose(mem.ws.id, path="facts.md", new_content="# Proje gerçekleri\n\nkaçırılan\n")
    assert p.approval_id
    await mem.approvals.decide(p.approval_id, approve=True)
    assert (await mem.svc.get_proposal(p.id)).status == "pending"
    mem.svc.start()  # reconcile on subscribe
    rec = await _settled(mem, p.id)
    assert rec.status == "applied"
    again = await mem.svc.settle(p.id)
    assert again.commit_sha == rec.commit_sha
    assert len(await mem.ctx.events.query(EventFilter(types=["memory.applied"]))) == 1


async def test_pending_approval_keeps_proposal_pending(mem: MemEnv) -> None:
    p = await mem.svc.propose(mem.ws.id, path="facts.md", new_content="# Proje gerçekleri\n\nbekliyor\n")
    rec = await mem.svc.settle(p.id)
    assert rec.status == "pending"
