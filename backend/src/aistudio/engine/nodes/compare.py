"""``compare`` node (Yarış): gate every candidate, then let the user or a judge agent pick.

The winner's worktrees continue downstream (the compare node reports them as its own); the
losers' worktrees are removed (their branches stay in git so the work remains recoverable).
"""

from __future__ import annotations

import contextlib
from typing import Any

from aistudio.contracts.agents import StartSessionRequest
from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.contracts.flows import CompareNodeConfig, GateNodeConfig
from aistudio.core.text import truncate
from aistudio.engine.graph import is_writer, upstream_branch_heads
from aistudio.engine.nodes.agent import read_only_location
from aistudio.engine.nodes.base import NodeContext, NodeFailure, NodeOutcome, WriterTarget, approval_request
from aistudio.engine.nodes.gates import GATE_LABEL, diff_text, gate_enabled, run_gate_kind
from aistudio.engine.structured import JUDGE_SCHEMA, extract_json


def _score(candidate: dict[str, Any]) -> tuple[int, int]:
    gates = candidate["gates"]
    passed = sum(1 for g in gates.values() if g["status"] in ("passed", "skipped"))
    failed = sum(1 for g in gates.values() if g["status"] == "failed")
    return passed - failed, -int(candidate.get("additions", 0)) - int(candidate.get("deletions", 0))


async def run_compare_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, CompareNodeConfig)
    ex = nctx.ex
    heads = upstream_branch_heads(ex.topo, nctx.node_id, is_writer)
    targets: list[WriterTarget] = []
    for nid in heads:
        target = nctx.writer_target(nid)
        if target is not None and target.worktree_ids:
            targets.append(target)
    if not targets:
        raise NodeFailure("Karşılaştırılacak başarılı bir aday yok.")

    candidates: list[dict[str, Any]] = []
    for target in targets:
        gate_results: dict[str, dict[str, Any]] = {}
        for kind in cfg.run_gates:
            if not gate_enabled(nctx, kind):
                gate_results[kind.value] = {"status": "skipped", "summary": "Kapı kapalı."}
                continue
            verdict = await run_gate_kind(nctx, GateNodeConfig(gate=kind), target=target, key=f"{target.node_id}:")
            await nctx.record_gate(
                kind,
                verdict.status,
                summary=f"{ex.topo.nodes[target.node_id].label}: {verdict.summary}",
                evidence={**verdict.evidence, "candidate": target.node_id},
                decided_by=verdict.decided_by,
                target_node_id=target.node_id,
            )
            gate_results[kind.value] = {"status": verdict.status, "summary": verdict.summary}
        _, stats = await diff_text(nctx, target.worktree_ids, limit=0)
        candidates.append(
            {
                "node_id": target.node_id,
                "label": ex.topo.nodes[target.node_id].label,
                "provider": target.provider,
                "model": target.model,
                "summary": truncate(target.output, 2000),
                "gates": gate_results,
                "diffstat": stats,
                "files": sum(len(s["files"]) for s in stats),
                "additions": sum(int(s["additions"]) for s in stats),
                "deletions": sum(int(s["deletions"]) for s in stats),
            }
        )
    best = max(candidates, key=_score)["node_id"]
    by_id = {c["node_id"]: c for c in candidates}
    winner: str
    rationale = ""
    judge_info: dict[str, Any] = {"judge": cfg.judge}

    if cfg.judge == "user":
        lines = []
        for c in candidates:
            gates = ", ".join(f"{GATE_LABEL.get(k, k)}: {v['status']}" for k, v in c["gates"].items())
            lines.append(f"- **{c['label']}** — {c['files']} dosya, +{c['additions']} −{c['deletions']}; {gates}")
        approval = await nctx.approval(
            "compare",
            approval_request(
                ApprovalKind.custom,
                f"Yarış sonucu: kazananı seç ({ex.task.title})",
                summary="\n".join(lines),
                payload={
                    "type": "compare",
                    "candidates": candidates,
                    "criteria": cfg.criteria,
                    "suggested": best,
                    "choose_with": "decision_payload.winner",
                },
            ),
            waiting_reason="Kazananın seçilmesi bekleniyor",
        )
        if approval.status != ApprovalStatus.approved:
            note = (approval.decision_note or "").strip()
            return NodeOutcome(
                status="failed",
                error=f"Adayların hiçbiri seçilmedi: {note}" if note else "Adayların hiçbiri seçilmedi.",
                data={"candidates": candidates},
                loopable=False,
            )
        choice = (approval.decision_payload or {}).get("winner")
        winner = str(choice) if isinstance(choice, str) and choice in by_id else best
        rationale = (approval.decision_note or "").strip()
        judge_info.update(decided_by=approval.decided_by or "user", approval_id=approval.id)
    else:
        winner, rationale, extra = await _agent_judge(nctx, cfg, candidates, targets, best)
        judge_info.update(extra)

    wm = nctx.rt.worktrees()
    win_target = next(t for t in targets if t.node_id == winner)
    abandoned: list[str] = []
    for t in targets:
        if t.node_id == winner:
            continue
        for wid in t.worktree_ids:
            if wid in win_target.worktree_ids:
                continue
            with contextlib.suppress(Exception):
                await wm.remove(wid, force=True)
                abandoned.append(wid)
        await nctx.emit("node.candidate_abandoned", {"candidate": t.node_id, "worktree_ids": t.worktree_ids})
    data: dict[str, Any] = {
        "winner": winner,
        "winner_label": by_id[winner]["label"],
        "rationale": rationale,
        "candidates": candidates,
        "worktree_ids": win_target.worktree_ids,
        "provider": win_target.provider,
        "model": win_target.model,
        "session_id": win_target.data.get("session_id"),
        "boundaries": win_target.data.get("boundaries"),
        "branches": win_target.data.get("branches"),
        "changed_files": win_target.data.get("changed_files"),
        "abandoned_worktree_ids": abandoned,
        **judge_info,
    }
    await nctx.emit("node.winner", {"winner": winner, "label": by_id[winner]["label"], "rationale": rationale})
    output = f"Kazanan: {by_id[winner]['label']}" + (f"\n\nGerekçe: {rationale}" if rationale else "")
    output += f"\n\n{win_target.output}" if win_target.output.strip() else ""
    return NodeOutcome(status="passed", output=output, data=data)


async def _agent_judge(
    nctx: NodeContext,
    cfg: CompareNodeConfig,
    candidates: list[dict[str, Any]],
    targets: list[WriterTarget],
    best: str,
) -> tuple[str, str, dict[str, Any]]:
    ex = nctx.ex
    agent = await nctx.resolve_agent(
        profile_id=cfg.judge_profile_id,
        provider=None,
        model=None,
        effort=None,
        role="judge",
        explicit={"role"},
        read_only=True,
    )
    provider, limit_info = await nctx.ensure_provider(agent.provider, purpose="Hakem")
    if provider != agent.provider:
        agent.provider, agent.model, agent.effort = provider, None, None
    sections = []
    per_candidate = max(4000, 40000 // max(1, len(targets)))
    for target, cand in zip(targets, candidates, strict=True):
        diff, _ = await diff_text(nctx, target.worktree_ids, limit=per_candidate)
        gates = "\n".join(f"- {GATE_LABEL.get(k, k)}: {v['status']} — {v['summary']}" for k, v in cand["gates"].items())
        sections.append(
            f"### Aday `{target.node_id}` ({cand['label']})\n**Özet:** {cand['summary']}\n**Kapılar:**\n{gates}\n"
            f"```diff\n{diff}\n```"
        )
    prompt = (
        f"Aynı görevi yapan adayları karşılaştır ve en iyisini seç.\n\n## Görev\n{ex.task.prompt}\n\n"
        f"## Ölçütler\n{cfg.criteria}\n\n## Adaylar\n" + "\n\n".join(sections) + "\n\n---\nYanıtının en sonunda tek "
        f"bir ```json bloğu içinde kararını ver:\n{JUDGE_SCHEMA}"
    )
    cwd, extra_dirs = read_only_location(nctx, ex.target_repos(None))
    system = await nctx.system_append("judge", agent.instructions)

    async def build_request() -> StartSessionRequest:
        return nctx.session_request(agent, cwd=cwd, system_append=system, extra_dirs=extra_dirs, label="Hakem")

    turn = await nctx.run_turn(key="judge", message=prompt, provider=agent.provider, build_request=build_request)
    obj = extract_json(turn.text) or {}
    choice = obj.get("winner")
    ids = {c["node_id"] for c in candidates}
    info: dict[str, Any] = {"judge_provider": agent.provider, "judge_session_id": turn.session_id, **limit_info}
    if choice in ids:
        info["decided_by"] = f"agent:{agent.provider}"
        return str(choice), str(obj.get("rationale") or ""), info
    info.update(decided_by="studiod", judge_fallback=True)
    return best, "Hakemin seçimi okunamadı; kapı sonuçlarına göre en iyi aday seçildi.", info
