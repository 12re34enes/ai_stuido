"""Shared memory service (spec §10).

Every workspace has its own git repo under ``paths.memory_dir(slug)`` holding hand-editable
Markdown (``facts.md``, ``boundaries.md``, ``decisions/``, ``sessions/``). Users edit directly
(each save is a commit); agents only *propose* changes, which become approvals and are committed
when approved. History is never rewritten: ``restore`` creates a new commit.

Events emitted (module prefix ``memory.``):
    memory.initialized         {path, commit}                       repo created
    memory.updated             {path, layer, commit, actor}         direct edit
    memory.proposed            {proposal_id, approval_id, path, layer, additions, deletions, ...}
    memory.applied             {proposal_id, approval_id, path, layer, commit, edited}
    memory.rejected            {proposal_id, approval_id, path, status, note}
    memory.conflict            {proposal_id, path}                  proposal could not be merged
    memory.restored            {commit, head}
    memory.boundaries_invalid  {path, warnings}                     boundaries.md partially ignored
"""

from __future__ import annotations

import asyncio
import contextlib
import difflib
import hashlib
import logging
import os
import re
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel

from aistudio.contracts.agents import AgentManager, AgentRole, Boundaries
from aistudio.contracts.approvals import Approval, ApprovalKind, ApprovalRequest, ApprovalService, ApprovalStatus
from aistudio.contracts.engine import FlowEngine
from aistudio.contracts.memory import MemoryDoc, MemoryLayer, MemoryProposal
from aistudio.contracts.workspaces import Workspace, WorkspaceService
from aistudio.core.clock import utcnow
from aistudio.core.context import AppContext
from aistudio.core.errors import NotFound, ValidationFailed
from aistudio.core.eventlog import SubscriberLagged
from aistudio.core.events import ET, Event, EventFilter, Severity
from aistudio.core.ids import new_id
from aistudio.memory.boundaries import parse_boundaries
from aistudio.memory.context import DecisionEntry, SessionEntry, build_context
from aistudio.memory.markdown import first_heading, first_paragraph_line, one_line, split_front_matter
from aistudio.memory.repo import MemoryCommit, MemoryRepo, validate_rev
from aistudio.memory.starter import STARTER_FILES
from aistudio.memory.summaries import SessionMeta, build_session_summary, build_task_summary
from aistudio.memory.tables import memory_proposals as proposals_t

log = logging.getLogger(__name__)

MAX_DOC_CHARS = 200_000
SETTING_AUTO_SUMMARIES = "memory.auto_session_summaries"
LAYER_LABELS: dict[str, str] = {
    "facts": "Proje gerçekleri",
    "boundaries": "Sınırlar",
    "decisions": "Kararlar",
    "sessions": "Oturum özetleri",
}
_LAYER_ORDER = {"facts": 0, "boundaries": 1, "decisions": 2, "sessions": 3}
_DATE_PREFIX = re.compile(r"^(\d{4}-\d{2}-\d{2})")
_SUMMARY_RATIONALE = "Oturum sona erdiği için otomatik oluşturulan özet."
_TASK_SUMMARY_RATIONALE = "Görev bittiği için otomatik oluşturulan özet."
_MAX_SESSION_EVENTS = 50_000


class MemoryProposalRecord(MemoryProposal):
    """A proposal plus bookkeeping the UI shows (who edited it, which commit applied it)."""

    base_commit: str | None = None
    commit_sha: str | None = None
    edited: bool = False
    note: str | None = None
    decided_at: datetime | None = None


class MemoryDiff(BaseModel):
    base: str
    head: str
    path: str | None = None
    diff: str
    truncated: bool = False


# --------------------------------------------------------------------------- helpers


def normalize_path(path: str) -> tuple[str, MemoryLayer]:
    """Validate a memory-relative path and return it with its layer."""
    p = (path or "").strip()
    if not p or len(p) > 240 or "\\" in p or "\x00" in p or p.startswith("/"):
        raise ValidationFailed("Geçersiz hafıza yolu.", details={"path": path})
    parts = PurePosixPath(p).parts
    if any(part in (".", "..") or part.startswith(".") for part in parts) or "//" in p:
        raise ValidationFailed("Geçersiz hafıza yolu.", details={"path": path})
    if not p.endswith(".md"):
        raise ValidationFailed("Hafıza belgeleri yalnız Markdown (.md) dosyası olabilir.", details={"path": path})
    if p == "facts.md":
        return p, "facts"
    if p == "boundaries.md":
        return p, "boundaries"
    if len(parts) >= 2 and parts[0] == "decisions":
        return p, "decisions"
    if len(parts) >= 2 and parts[0] == "sessions":
        return p, "sessions"
    raise ValidationFailed(
        "Hafıza yolu facts.md, boundaries.md ya da decisions/ veya sessions/ altında olmalı.",
        details={"path": path},
    )


def normalize_content(text: str) -> str:
    text = text.replace("\r\n", "\n")
    if text and not text.endswith("\n"):
        text += "\n"
    return text


def unified_diff(old: str | None, new: str, path: str) -> str:
    a = (old or "").splitlines(keepends=True)
    b = new.splitlines(keepends=True)
    out: list[str] = []
    for line in difflib.unified_diff(a, b, f"a/{path}" if old is not None else "/dev/null", f"b/{path}"):
        out.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    return "".join(out)


def diff_stats(diff: str) -> tuple[int, int]:
    adds = dels = 0
    for line in diff.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            adds += 1
        elif line.startswith("-") and not line.startswith("---"):
            dels += 1
    return adds, dels


def doc_title(path: str, content: str) -> str:
    fm = split_front_matter(content)
    if fm.data and isinstance(fm.data.get("title"), str) and fm.data["title"].strip():
        return fm.data["title"].strip()
    return first_heading(fm.body) or PurePosixPath(path).stem


def _boundary_notes(body: str) -> str:
    """The "Açıklamalar" section of boundaries.md (or the whole body if there is none)."""
    lines = body.splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"^(#{1,6})\s+(.+?)\s*$", line.strip())
        if m and m.group(2).casefold() == "açıklamalar":
            level = len(m.group(1))
            out: list[str] = []
            for nxt in lines[i + 1 :]:
                n = re.match(r"^(#{1,6})\s+", nxt.strip())
                if n and len(n.group(1)) <= level:
                    break
                out.append(nxt)
            return "\n".join(out)
    return body


def _scan_markdown(root: Path) -> list[tuple[str, float]]:
    found: list[tuple[str, float]] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in filenames:
            if name.startswith(".") or not name.endswith(".md"):
                continue
            full = Path(dirpath) / name
            rel = full.relative_to(root).as_posix()
            with contextlib.suppress(OSError):
                found.append((rel, full.stat().st_mtime))
    return found


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return None


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


# --------------------------------------------------------------------------- service


class MemoryServiceImpl:
    def __init__(self, ctx: AppContext) -> None:
        self._ctx = ctx
        self._locks: dict[str, asyncio.Lock] = {}
        self._ready: set[str] = set()
        self._boundary_warned: dict[str, str] = {}
        self._listener: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------ infrastructure
    def _lock(self, workspace_id: str) -> asyncio.Lock:
        return self._locks.setdefault(workspace_id, asyncio.Lock())

    async def _workspace(self, workspace_id: str) -> Workspace:
        return await self._ctx.services.get(WorkspaceService).get(workspace_id)  # type: ignore[type-abstract]

    def _approvals(self) -> ApprovalService:
        return self._ctx.services.get(ApprovalService)  # type: ignore[type-abstract]

    async def _repo(self, workspace_id: str) -> MemoryRepo:
        ws = await self._workspace(workspace_id)
        repo = MemoryRepo(self._ctx.settings.paths.memory_dir(ws.slug))
        if workspace_id in self._ready and repo.is_repo():
            return repo
        async with self._lock(workspace_id):
            if not repo.is_repo() or await repo.head() is None:
                sha = await repo.init(STARTER_FILES)
                await self._ctx.events.append(
                    "memory.initialized", {"path": str(repo.root), "commit": sha}, workspace_id=workspace_id
                )
            self._ready.add(workspace_id)
        return repo

    async def _sync_external(self, repo: MemoryRepo) -> str | None:
        """Commit edits made outside the app (external editor) so history stays complete.
        Caller holds the workspace lock."""
        if await repo.is_dirty():
            return await repo.commit_all("Harici düzenlemeler kaydedildi", actor="external")
        return None

    async def _read(self, repo: MemoryRepo, rel: str) -> str | None:
        return await asyncio.to_thread(_read_text, repo.file(rel))

    # ------------------------------------------------------------------ MemoryService
    async def ensure(self, workspace_id: str) -> None:
        await self._repo(workspace_id)

    async def list_docs(self, workspace_id: str) -> list[MemoryDoc]:
        repo = await self._repo(workspace_id)
        files = await asyncio.to_thread(_scan_markdown, repo.root)
        modified = await repo.last_modified()
        docs: list[MemoryDoc] = []
        for rel, mtime in files:
            try:
                rel, layer = normalize_path(rel)
            except ValidationFailed:
                continue
            content = await self._read(repo, rel)
            if content is None:
                continue
            docs.append(
                MemoryDoc(
                    path=rel,
                    layer=layer,
                    title=doc_title(rel, content),
                    content=content,
                    updated_at=modified.get(rel) or datetime.fromtimestamp(mtime, UTC),
                )
            )
        docs.sort(key=lambda d: (_LAYER_ORDER[d.layer], d.path))
        return docs

    async def read(self, workspace_id: str, path: str) -> MemoryDoc:
        rel, layer = normalize_path(path)
        repo = await self._repo(workspace_id)
        content = await self._read(repo, rel)
        if content is None:
            raise NotFound("Hafıza belgesi bulunamadı.", details={"path": rel})
        updated: datetime | None = None
        log_entries = await repo.log(path=rel, limit=1)
        if log_entries:
            updated = log_entries[0].committed_at
        return MemoryDoc(path=rel, layer=layer, title=doc_title(rel, content), content=content, updated_at=updated)

    async def write(self, workspace_id: str, path: str, content: str, *, message: str, actor: str = "user") -> str:
        rel, layer = normalize_path(path)
        content = normalize_content(content)
        if len(content) > MAX_DOC_CHARS:
            raise ValidationFailed("Hafıza belgesi çok büyük (en fazla 200.000 karakter).")
        repo = await self._repo(workspace_id)
        async with self._lock(workspace_id):
            await self._sync_external(repo)
            await asyncio.to_thread(_write_text, repo.file(rel), content)
            sha = await repo.commit_all(message.strip() or f"{rel} güncellendi", actor=actor)
            head = sha or await repo.head()
        assert head is not None
        if sha is not None:
            await self._ctx.events.append(
                "memory.updated",
                {"path": rel, "layer": layer, "commit": sha, "actor": actor},
                actor=actor if actor.startswith(("user", "agent:")) else "system",
                workspace_id=workspace_id,
            )
        if layer == "boundaries":
            await self._check_boundaries(workspace_id, content)
        return head

    async def boundaries(self, workspace_id: str) -> Boundaries:
        repo = await self._repo(workspace_id)
        text = await self._read(repo, "boundaries.md") or ""
        return await self._check_boundaries(workspace_id, text)

    async def boundary_warnings(self, workspace_id: str) -> list[str]:
        repo = await self._repo(workspace_id)
        text = await self._read(repo, "boundaries.md") or ""
        return parse_boundaries(text)[1]

    async def _check_boundaries(self, workspace_id: str, text: str) -> Boundaries:
        parsed, warnings = parse_boundaries(text)
        digest = hashlib.sha256(text.encode()).hexdigest()
        if warnings and self._boundary_warned.get(workspace_id) != digest:
            self._boundary_warned[workspace_id] = digest
            await self._ctx.events.append(
                "memory.boundaries_invalid",
                {"path": "boundaries.md", "warnings": warnings},
                severity=Severity.normal,
                workspace_id=workspace_id,
            )
        elif not warnings:
            self._boundary_warned.pop(workspace_id, None)
        return parsed

    async def head(self, workspace_id: str) -> str | None:
        repo = await self._repo(workspace_id)
        async with self._lock(workspace_id):
            await self._sync_external(repo)
            return await repo.head()

    async def restore(self, workspace_id: str, commit: str, *, actor: str = "system") -> None:
        validate_rev(commit)
        repo = await self._repo(workspace_id)
        async with self._lock(workspace_id):
            await self._sync_external(repo)
            sha = await repo.resolve(commit)
            await repo.restore_tree(sha)
            new = await repo.commit_all(
                f"Hafıza {sha[:8]} sürümüne geri yüklendi",
                actor=actor,
                trailers={"AI-Studio-Restored-From": sha},
            )
            head = new or await repo.head()
        await self._ctx.events.append(
            "memory.restored",
            {"commit": sha, "head": head, "changed": new is not None},
            actor=actor if actor.startswith(("user", "agent:")) else "system",
            workspace_id=workspace_id,
        )

    async def context_for_agent(self, workspace_id: str, *, role: AgentRole) -> str:
        ws = await self._workspace(workspace_id)
        repo = await self._repo(workspace_id)
        facts = await self._read(repo, "facts.md") or ""
        btext = await self._read(repo, "boundaries.md") or ""
        bounds = await self._check_boundaries(workspace_id, btext)
        files = await asyncio.to_thread(_scan_markdown, repo.root)
        decisions: list[DecisionEntry] = []
        sessions: list[SessionEntry] = []
        for rel, mtime in files:
            name = PurePosixPath(rel).name
            if name.lower() == "readme.md":
                continue
            fallback_date = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")
            if rel.startswith("decisions/"):
                content = await self._read(repo, rel) or ""
                decisions.append(_decision_entry(rel, content, fallback_date))
            elif rel.startswith("sessions/"):
                content = await self._read(repo, rel) or ""
                m = _DATE_PREFIX.match(name)
                title = doc_title(rel, content).removeprefix("Oturum özeti:").strip()
                sessions.append(SessionEntry(path=rel, date=m.group(1) if m else fallback_date, title=title))
        decisions.sort(key=lambda d: (d.date, d.path), reverse=True)
        sessions.sort(key=lambda s: (s.date, s.path), reverse=True)
        return build_context(
            workspace_name=ws.name,
            role=role,
            facts=facts,
            boundaries=bounds,
            boundary_notes=_boundary_notes(split_front_matter(btext).body),
            decisions=decisions,
            sessions=sessions,
        )

    # ------------------------------------------------------------------ history
    async def history(self, workspace_id: str, *, path: str | None = None, limit: int = 50) -> list[MemoryCommit]:
        rel = normalize_path(path)[0] if path else None
        repo = await self._repo(workspace_id)
        return await repo.log(path=rel, limit=limit)

    async def diff(
        self, workspace_id: str, base: str, head: str | None = None, *, path: str | None = None
    ) -> MemoryDiff:
        rel = normalize_path(path)[0] if path else None
        repo = await self._repo(workspace_id)
        base_sha = await repo.resolve(base)
        head_sha = await repo.resolve(head or "HEAD")
        text, truncated = await repo.diff(base_sha, head_sha, path=rel)
        return MemoryDiff(base=base_sha, head=head_sha, path=rel, diff=text, truncated=truncated)

    async def read_at(self, workspace_id: str, path: str, commit: str) -> MemoryDoc:
        """A document as it was at ``commit`` (for the history view)."""
        rel, layer = normalize_path(path)
        repo = await self._repo(workspace_id)
        sha = await repo.resolve(commit)
        content = await repo.show(sha, rel)
        if content is None:
            raise NotFound("Belge bu sürümde yok.", details={"path": rel, "commit": sha})
        return MemoryDoc(path=rel, layer=layer, title=doc_title(rel, content), content=content)

    # ------------------------------------------------------------------ proposals
    async def propose(
        self,
        workspace_id: str,
        *,
        path: str,
        new_content: str,
        rationale: str | None = None,
        source_session_id: str | None = None,
        requested_by: str | None = None,
    ) -> MemoryProposal:
        rel, layer = normalize_path(path)
        # Memory feeds every agent's prompt: never let a secret in, even via an agent proposal.
        content = normalize_content(self._ctx.masker.mask(new_content))
        if not content.strip():
            raise ValidationFailed("Önerilen içerik boş olamaz.")
        if len(content) > MAX_DOC_CHARS:
            raise ValidationFailed("Önerilen içerik çok büyük (en fazla 200.000 karakter).")
        rationale = (rationale or "").strip() or None
        repo = await self._repo(workspace_id)
        async with self._lock(workspace_id):
            await self._sync_external(repo)
            old = await self._read(repo, rel)
            base_commit = await repo.head()
        if old == content:
            raise ValidationFailed("Önerilen içerik mevcut belgeyle aynı; değişiklik yok.", details={"path": rel})
        diff = unified_diff(old, content, rel)
        record = MemoryProposalRecord(
            id=new_id("memp"),
            workspace_id=workspace_id,
            layer=layer,
            path=rel,
            old_content=old,
            new_content=content,
            diff=diff,
            rationale=rationale,
            source_session_id=source_session_id,
            created_at=utcnow(),
            base_commit=base_commit,
        )
        async with self._ctx.db.begin() as conn:
            await conn.execute(
                proposals_t.insert().values(
                    **record.model_dump(include=set(proposals_t.c.keys()) - {"approval_id", "status"}),
                    status="pending",
                )
            )
        if requested_by is None:
            requested_by = f"agent:{source_session_id}" if source_session_id else "system"
        record = await self._request_approval(record, requested_by=requested_by)
        adds, dels = diff_stats(diff)
        await self._ctx.events.append(
            "memory.proposed",
            {
                "proposal_id": record.id,
                "approval_id": record.approval_id,
                "path": rel,
                "layer": layer,
                "rationale": rationale,
                "additions": adds,
                "deletions": dels,
                "source_session_id": source_session_id,
            },
            severity=Severity.info,
            actor=requested_by,
            workspace_id=workspace_id,
            session_id=source_session_id,
        )
        return MemoryProposal(**record.model_dump(include=set(MemoryProposal.model_fields)))

    async def _request_approval(self, record: MemoryProposalRecord, *, requested_by: str) -> MemoryProposalRecord:
        adds, dels = diff_stats(record.diff)
        payload: dict[str, Any] = {
            "proposal_id": record.id,
            "path": record.path,
            "layer": record.layer,
            "diff": record.diff,
            "content": record.new_content,  # the user may edit this; send it back in decision_payload.content
            "rationale": record.rationale,
            "source_session_id": record.source_session_id,
            "additions": adds,
            "deletions": dels,
        }
        severity = Severity.normal
        summary = record.rationale or f"{LAYER_LABELS[record.layer]} katmanı için değişiklik önerisi."
        if record.layer == "boundaries":
            # Loosening one's own limits must stand out in the inbox.
            severity = Severity.high
            summary = "Sınırları değiştiren öneri; dikkatle inceleyin. " + (record.rationale or "")
            _, warnings = parse_boundaries(record.new_content)
            payload["boundary_warnings"] = warnings
        approval = await self._approvals().request(
            ApprovalRequest(
                kind=ApprovalKind.memory,
                title=f"Hafıza önerisi: {record.path}",
                summary=one_line(summary, 300),
                payload=payload,
                severity=severity,
                workspace_id=record.workspace_id,
                session_id=record.source_session_id,
                requested_by=requested_by,
            )
        )
        async with self._ctx.db.begin() as conn:
            await conn.execute(
                proposals_t.update().where(proposals_t.c.id == record.id).values(approval_id=approval.id)
            )
        return record.model_copy(update={"approval_id": approval.id})

    async def get_proposal(self, proposal_id: str) -> MemoryProposalRecord:
        async with self._ctx.db.connect() as conn:
            row = (await conn.execute(sa.select(proposals_t).where(proposals_t.c.id == proposal_id))).mappings().first()
        if row is None:
            raise NotFound("Hafıza önerisi bulunamadı.")
        return MemoryProposalRecord(**row)

    async def list_proposals(
        self, workspace_id: str, *, status: str | None = None, limit: int = 200
    ) -> list[MemoryProposalRecord]:
        stmt = (
            sa.select(proposals_t)
            .where(proposals_t.c.workspace_id == workspace_id)
            .order_by(proposals_t.c.created_at.desc())
            .limit(max(1, min(limit, 1000)))
        )
        if status is not None:
            stmt = stmt.where(proposals_t.c.status == status)
        async with self._ctx.db.connect() as conn:
            rows = (await conn.execute(stmt)).mappings().all()
        return [MemoryProposalRecord(**r) for r in rows]

    async def settle(self, proposal_id: str, *, approval: Approval | None = None) -> MemoryProposalRecord:
        """Apply or reject a proposal according to its approval. Idempotent; a pending approval
        leaves the proposal untouched."""
        rec = await self.get_proposal(proposal_id)
        if rec.status != "pending":
            return rec
        approval_id = rec.approval_id or (approval.id if approval else None)
        if approval_id is None:
            return rec
        if approval is None or approval.id != approval_id:
            approval = await self._approvals().get(approval_id)
        if approval.status == ApprovalStatus.pending:
            return rec
        if approval.status == ApprovalStatus.approved:
            return await self._apply(rec.id, approval)
        notes = {
            ApprovalStatus.rejected: "Kullanıcı reddetti.",
            ApprovalStatus.expired: "Onay süresi doldu.",
            ApprovalStatus.cancelled: "Onay isteği iptal edildi.",
        }
        return await self._close(
            rec, approval, note=approval.decision_note or notes.get(approval.status, "Reddedildi.")
        )

    async def _close(self, rec: MemoryProposalRecord, approval: Approval, *, note: str) -> MemoryProposalRecord:
        async with self._ctx.db.begin() as conn:
            res = await conn.execute(
                proposals_t.update()
                .where(proposals_t.c.id == rec.id, proposals_t.c.status == "pending")
                .values(status="rejected", note=note, decided_at=utcnow(), approval_id=approval.id)
            )
        if res.rowcount:
            await self._ctx.events.append(
                "memory.rejected",
                {
                    "proposal_id": rec.id,
                    "approval_id": approval.id,
                    "path": rec.path,
                    "status": approval.status.value,
                    "note": note,
                },
                workspace_id=rec.workspace_id,
                session_id=rec.source_session_id,
            )
        return await self.get_proposal(rec.id)

    async def _apply(self, proposal_id: str, approval: Approval) -> MemoryProposalRecord:
        rec = await self.get_proposal(proposal_id)
        repo = await self._repo(rec.workspace_id)
        async with self._lock(rec.workspace_id):
            rec = await self.get_proposal(proposal_id)  # re-check under the lock (concurrent settle)
            if rec.status != "pending":
                return rec
            content = rec.new_content
            edited = False
            dp = approval.decision_payload or {}
            if isinstance(dp.get("content"), str):
                user_content = normalize_content(dp["content"])
                if user_content != content:
                    content, edited = user_content, True
            await self._sync_external(repo)
            current = await self._read(repo, rec.path)
            if not edited and current != rec.old_content:
                # The document changed since the proposal: merge both sides when possible.
                merged = await repo.merge_three_way(rec.old_content or "", current or "", content)
                if merged is None:
                    note = (
                        "Belge öneriden sonra değişti ve değişiklikler otomatik birleştirilemedi. "
                        "Güncel içerikle yeniden önerilmeli."
                    )
                    await self._ctx.events.append(
                        "memory.conflict",
                        {"proposal_id": rec.id, "path": rec.path},
                        severity=Severity.normal,
                        workspace_id=rec.workspace_id,
                    )
                    return await self._close(rec, approval, note=note)
                content = merged
            commit: str | None = None
            if current != content:
                await asyncio.to_thread(_write_text, repo.file(rec.path), content)
                actor = f"agent:{rec.source_session_id}" if rec.source_session_id else "system"
                commit = await repo.commit_all(
                    f"Hafıza önerisi uygulandı: {rec.path}",
                    actor=actor,
                    body=rec.rationale,
                    trailers={
                        "AI-Studio-Proposal": rec.id,
                        "AI-Studio-Approval": approval.id,
                        "AI-Studio-Approved-By": approval.decided_by or "user",
                    },
                )
            commit = commit or await repo.head()
            async with self._ctx.db.begin() as conn:
                await conn.execute(
                    proposals_t.update()
                    .where(proposals_t.c.id == rec.id, proposals_t.c.status == "pending")
                    .values(
                        status="applied",
                        commit_sha=commit,
                        edited=edited,
                        new_content=content,
                        diff=unified_diff(current, content, rec.path),
                        decided_at=utcnow(),
                        approval_id=approval.id,
                        note=approval.decision_note,
                    )
                )
        await self._ctx.events.append(
            ET.MEMORY_APPLIED,
            {
                "proposal_id": rec.id,
                "approval_id": approval.id,
                "path": rec.path,
                "layer": rec.layer,
                "commit": commit,
                "edited": edited,
            },
            workspace_id=rec.workspace_id,
            session_id=rec.source_session_id,
        )
        if rec.layer == "boundaries":
            await self._check_boundaries(rec.workspace_id, content)
        return await self.get_proposal(rec.id)

    # ------------------------------------------------------------------ session summaries
    async def summarize_session(self, ev: Event) -> MemoryProposal | None:
        """Propose a summary for the session that ``ev`` (``agent.session.ended``) closed."""
        session_id = ev.session_id or ev.payload.get("session_id")
        if not session_id:
            return None
        workspace_id = ev.workspace_id
        task_id = ev.task_id
        meta = SessionMeta()
        manager = self._ctx.services.maybe(AgentManager)  # type: ignore[type-abstract]
        if manager is not None:
            try:
                rec = await manager.get(session_id)
            except Exception:  # the summary is best-effort; never fail on missing metadata
                rec = None
            if rec is not None:
                meta.label = rec.label or rec.title
                meta.provider = rec.provider
                meta.model = rec.model
                meta.role = rec.role
                workspace_id = workspace_id or rec.workspace_id
                task_id = task_id or rec.task_id
        if not workspace_id:
            return None
        if task_id:
            # Flow sessions are summarized once per task (summarize_task), not per agent session:
            # an İkili/Hat/Kurul run would otherwise ask for several approvals.
            return None
        events = await self._session_events(session_id)
        built = build_session_summary(session_id, events, meta)
        if built is None:
            return None
        path, content = built
        async with self._ctx.db.connect() as conn:
            dup = (
                await conn.execute(
                    sa.select(proposals_t.c.id).where(
                        proposals_t.c.workspace_id == workspace_id,
                        proposals_t.c.source_session_id == session_id,
                        proposals_t.c.path == path,
                    )
                )
            ).first()
        if dup is not None:
            return None
        try:
            return await self.propose(
                workspace_id,
                path=path,
                new_content=content,
                rationale=_SUMMARY_RATIONALE,
                source_session_id=session_id,
                requested_by="system",
            )
        except ValidationFailed:
            return None

    async def summarize_task(self, ev: Event) -> MemoryProposal | None:
        """Propose one summary for a finished task (``task.completed`` / ``task.failed``)."""
        task_id = ev.task_id
        workspace_id = ev.workspace_id
        if not task_id or not workspace_id:
            return None
        title = str(ev.payload.get("title") or "Görev")
        mode: str | None = None
        engine = self._ctx.services.maybe(FlowEngine)  # type: ignore[type-abstract]
        if engine is not None:
            with contextlib.suppress(Exception):
                task = await engine.get_task(task_id)
                title, mode = task.title, task.mode.value
        events: list[Event] = []
        after = 0
        flt = EventFilter(task_id=task_id)
        while len(events) < _MAX_SESSION_EVENTS:
            page = await self._ctx.events.query(flt, after_id=after, limit=2000)
            events.extend(page)
            if len(page) < 2000:
                break
            after = page[-1].id
        status = "completed" if ev.type == "task.completed" else "failed"
        score = ev.payload.get("quality_score")
        built = build_task_summary(
            task_id,
            title,
            events,
            status=status,
            mode=mode,
            quality_score=float(score) if isinstance(score, int | float) else None,
        )
        if built is None:
            return None
        path, content = built
        async with self._ctx.db.connect() as conn:
            dup = (
                await conn.execute(
                    sa.select(proposals_t.c.id).where(
                        proposals_t.c.workspace_id == workspace_id, proposals_t.c.path == path
                    )
                )
            ).first()
        if dup is not None:
            return None
        try:
            return await self.propose(
                workspace_id,
                path=path,
                new_content=content,
                rationale=_TASK_SUMMARY_RATIONALE,
                source_session_id=None,
                requested_by="system",
            )
        except ValidationFailed:
            return None

    async def _session_events(self, session_id: str) -> list[Event]:
        out: list[Event] = []
        after = 0
        flt = EventFilter(session_id=session_id, types=["agent.*"])
        while len(out) < _MAX_SESSION_EVENTS:
            page = await self._ctx.events.query(flt, after_id=after, limit=2000)
            out.extend(page)
            if len(page) < 2000:
                break
            after = page[-1].id
        return out

    # ------------------------------------------------------------------ background
    def start(self) -> None:
        if self._listener is None or self._listener.done():
            self._listener = self._ctx.spawn(self._listen(), name="memory-events")

    async def stop(self) -> None:
        task, self._listener = self._listener, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _listen(self) -> None:
        flt = EventFilter(
            types=["workspace.created", ET.AGENT_SESSION_ENDED, ET.TASK_COMPLETED, ET.TASK_FAILED, ET.APPROVAL_DECIDED],
            include_ephemeral=False,
        )
        while True:
            try:
                async with self._ctx.events.subscribe(flt) as stream:
                    await self._reconcile()
                    async for ev in stream:
                        await self._handle(ev)
            except SubscriberLagged:
                log.warning("memory event listener lagged; re-subscribing")

    async def _handle(self, ev: Event) -> None:
        try:
            if ev.type == "workspace.created" and ev.workspace_id:
                await self.ensure(ev.workspace_id)
            elif ev.type == ET.AGENT_SESSION_ENDED:
                if await self._ctx.store.get(SETTING_AUTO_SUMMARIES):
                    await self.summarize_session(ev)
            elif ev.type in (ET.TASK_COMPLETED, ET.TASK_FAILED):
                if await self._ctx.store.get(SETTING_AUTO_SUMMARIES):
                    await self.summarize_task(ev)
            elif ev.type == ET.APPROVAL_DECIDED and ev.payload.get("kind") == ApprovalKind.memory.value:
                approval = await self._approvals().get(str(ev.payload.get("approval_id")))
                proposal_id = approval.payload.get("proposal_id")
                if isinstance(proposal_id, str):
                    await self.settle(proposal_id, approval=approval)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("memory: failed to handle %s (event %s)", ev.type, ev.id)

    async def _reconcile(self) -> None:
        """Settle proposals whose approval was decided while we were not listening."""
        async with self._ctx.db.connect() as conn:
            stmt = sa.select(proposals_t).where(proposals_t.c.status == "pending")
            rows = (await conn.execute(stmt)).mappings().all()
        for row in rows:
            rec = MemoryProposalRecord(**row)
            try:
                if rec.approval_id is None:  # crashed between insert and approval request
                    await self._request_approval(rec, requested_by="system")
                else:
                    await self.settle(rec.id)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("memory: failed to reconcile proposal %s", rec.id)


def _decision_entry(rel: str, content: str, fallback_date: str) -> DecisionEntry:
    fm = split_front_matter(content)
    data = fm.data or {}
    m = _DATE_PREFIX.match(PurePosixPath(rel).name)
    raw_date = data.get("date")
    date = str(raw_date) if raw_date else (m.group(1) if m else fallback_date)
    title = doc_title(rel, content)
    summary = data.get("summary") if isinstance(data.get("summary"), str) else None
    if not summary:
        summary = first_paragraph_line(fm.body, after_heading="Karar") or first_paragraph_line(fm.body)
    status = data.get("status") if isinstance(data.get("status"), str) else None
    return DecisionEntry(path=rel, date=date[:10], title=title, summary=summary, status=status)
