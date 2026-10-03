from __future__ import annotations

from memory_helpers import MemEnv

from aistudio.contracts.tools import ToolContext
from aistudio.memory.tools import MemoryProposeTool, MemoryReadTool
from aistudio.tools.registry import BoundToolHost, ToolRegistryImpl


def _host(env: MemEnv, *, allow_mutating: bool = True) -> BoundToolHost:
    registry = ToolRegistryImpl(env.ctx.events)
    registry.register(MemoryReadTool(env.svc))
    registry.register(MemoryProposeTool(env.svc))
    tctx = ToolContext(workspace_id=env.ws.id, session_id="ses_tool", provider="claude")
    return registry.bind(tctx, allow_mutating=allow_mutating)


async def test_tools_are_non_mutating_and_available_to_advisors(mem: MemEnv) -> None:
    host = _host(mem, allow_mutating=False)
    names = sorted(s.name for s in host.specs())
    assert names == ["memory_propose", "memory_read"]
    assert MemoryReadTool.spec.mutating is False and MemoryProposeTool.spec.mutating is False


async def test_memory_read_lists_and_reads(mem: MemEnv) -> None:
    host = _host(mem)
    listing = await host.call("memory_read", {})
    assert not listing.is_error
    assert "facts.md [facts] — Proje gerçekleri" in listing.content
    assert listing.data is not None
    assert {d["path"] for d in listing.data["documents"]} >= {"facts.md", "boundaries.md"}

    doc = await host.call("memory_read", {"path": "facts.md"})
    assert doc.content.startswith("# Proje gerçekleri")

    missing = await host.call("memory_read", {"path": "decisions/yok.md"})
    assert missing.is_error and "bulunamadı" in missing.content
    bad = await host.call("memory_read", {"path": "../../etc/passwd"})
    assert bad.is_error


async def test_memory_propose_creates_proposal_from_agent(mem: MemEnv) -> None:
    host = _host(mem)
    res = await host.call(
        "memory_propose",
        {"path": "facts.md", "content": "# Proje gerçekleri\n\n## Amaç\nYeni.\n", "rationale": "Amaç netleşti"},
    )
    assert not res.is_error, res.content
    assert "NOT applied" in res.content
    assert res.data is not None
    rec = await mem.svc.get_proposal(res.data["proposal_id"])
    assert rec.source_session_id == "ses_tool" and rec.status == "pending"
    approval = await mem.approvals.get(res.data["approval_id"])
    assert approval.requested_by == "agent:ses_tool"

    invalid = await host.call("memory_propose", {"path": "facts.md"})
    assert invalid.is_error
