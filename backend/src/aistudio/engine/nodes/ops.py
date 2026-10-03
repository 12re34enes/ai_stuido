"""``merge``, ``git``, ``deploy`` and ``human`` nodes."""

from __future__ import annotations

import json
from typing import Any

from aistudio.contracts.agents import StartSessionRequest
from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.contracts.flows import (
    DeployNodeConfig,
    GateKind,
    GateNodeConfig,
    GitNodeConfig,
    HumanNodeConfig,
    MergeNodeConfig,
    NodeKind,
)
from aistudio.contracts.gitops import MergePreview, Worktree
from aistudio.contracts.workspaces import Repo
from aistudio.core.events import Severity
from aistudio.core.text import truncate
from aistudio.engine.graph import nearest_writer
from aistudio.engine.nodes.base import NodeContext, NodeFailure, NodeOutcome, WriterTarget, approval_request
from aistudio.engine.nodes.gates import GATE_LABEL, final_summary, gate_enabled, run_gate_kind

MERGE_PATCH_CHARS = 40000


def _writer(nctx: NodeContext) -> WriterTarget:
    target = nctx.writer_target(nearest_writer(nctx.ex.topo, nctx.node_id))
    if target is None or not target.worktree_ids:
        raise NodeFailure("Bu düğümün üzerinde çalışacağı bir worktree yok.")
    return target


# --------------------------------------------------------------------------- merge


async def _resolve_conflicts(
    nctx: NodeContext, target: WriterTarget, wt: Worktree, repo: Repo, target_ref: str, preview: MergePreview
) -> None:
    await nctx.emit(
        "conflict.detected",
        {"worktree_id": wt.id, "repo": repo.name, "target_ref": target_ref, "conflicts": preview.conflicts},
        severity=Severity.normal,
    )
    agent = await nctx.resolve_agent(
        profile_id=None,
        provider=target.provider,
        model=target.model if target.provider else None,
        effort=None,
        role="writer",
        explicit={"role"},
        node_boundaries=target.boundaries,
    )
    provider, _ = await nctx.ensure_provider(agent.provider, purpose="Çakışma çözümü")
    if provider != agent.provider:
        agent.provider, agent.model = provider, None
    files = "\n".join(f"- {c}" for c in preview.conflicts) or "- (git listesine bak)"
    prompt = (
        f"Bu worktree'deki `{wt.branch}` branch'i `{target_ref}` ile birleştirilirken çakışma çıkıyor.\n\n"
        f"1. `git merge {target_ref}` çalıştır (yerel ref'i kullan).\n"
        f"2. Çakışan dosyaları iki tarafın amacını da koruyarak çöz:\n{files}\n"
        "3. Çözümün testleri bozmadığından emin ol ve merge commit'ini oluştur.\n\n"
        f"## Görev\n{nctx.ex.task.prompt}"
    )
    system = await nctx.system_append("writer")

    async def build_request() -> StartSessionRequest:
        return nctx.session_request(
            agent, cwd=wt.path, system_append=system, worktree_id=wt.id, label=f"{nctx.node.label} · çakışma çözümü"
        )

    await nctx.run_turn(key=f"resolve:{wt.id}", message=prompt, provider=agent.provider, build_request=build_request)
    wm = nctx.rt.worktrees()
    await wm.commit_all(wt.id, f"{nctx.ex.task.title}\n\nÇakışmalar çözüldü ({target_ref}) · AI Studio")
    resolved = WriterTarget(
        node_id=target.node_id,
        worktree_ids=[wt.id],
        provider=agent.provider,
        model=agent.model,
        output=target.output,
        data=target.data,
        boundaries=target.boundaries,
    )
    for kind in (GateKind.boundary_check, GateKind.build_test):
        if not gate_enabled(nctx, kind):
            continue
        verdict = await run_gate_kind(nctx, GateNodeConfig(gate=kind), target=resolved, key=f"resolve:{wt.id}:")
        await nctx.record_gate(
            kind,
            verdict.status,
            summary=f"Çakışma çözümü: {verdict.summary}",
            evidence={**verdict.evidence, "conflict_resolution": True},
            decided_by=verdict.decided_by,
            target_node_id=target.node_id,
        )
        if verdict.status == "failed":
            raise NodeFailure(f"Çakışma çözümü {GATE_LABEL[kind.value]} kapısından geçemedi: {verdict.summary}")


async def run_merge_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, MergeNodeConfig)
    target = _writer(nctx)
    wm = nctx.rt.worktrees()
    items: list[tuple[Worktree, Repo, str, MergePreview]] = []
    resolved_any = False
    for wid in target.worktree_ids:
        wt = await wm.get(wid)
        repo = await nctx.repo(wt.repo_id)
        target_ref = cfg.target_ref or repo.default_branch
        preview = await wm.merge_preview(wid, target_ref)
        if not preview.clean:
            if not cfg.resolve_conflicts_with_agent:
                return NodeOutcome(
                    status="failed",
                    error=f"{repo.name}: {target_ref} ile çakışma var: {', '.join(preview.conflicts)}",
                    data={"conflicts": {repo.name: preview.conflicts}},
                    loopable=False,
                )
            await _resolve_conflicts(nctx, target, wt, repo, target_ref, preview)
            resolved_any = True
            preview = await wm.merge_preview(wid, target_ref)
            if not preview.clean:
                return NodeOutcome(
                    status="failed",
                    error=f"{repo.name}: ajan çakışmaları çözemedi: {', '.join(preview.conflicts)}",
                    data={"conflicts": {repo.name: preview.conflicts}},
                    loopable=False,
                )
        items.append((wt, repo, target_ref, preview))

    if cfg.require_approval:
        merges = []
        for wt, repo, ref, preview in items:
            diff = preview.diff
            patch = ""
            if diff is not None:
                patch = truncate("\n".join(f.patch or "" for f in diff.files), MERGE_PATCH_CHARS)
            merges.append(
                {
                    "repo": repo.name,
                    "worktree_id": wt.id,
                    "branch": wt.branch,
                    "target_ref": ref,
                    "files": [f.path for f in diff.files] if diff else [],
                    "additions": diff.additions if diff else 0,
                    "deletions": diff.deletions if diff else 0,
                    "patch": patch,
                }
            )
        approval = await nctx.approval(
            "merge",
            approval_request(
                ApprovalKind.merge,
                f"Birleştirme onayı: {nctx.ex.task.title}",
                summary="\n".join(
                    f"- {m['repo']}: {m['branch']} → {m['target_ref']} ({len(m['files'])} dosya)" for m in merges
                ),
                payload={"merges": merges, "strategy": cfg.strategy, "conflicts_resolved": resolved_any},
            ),
            waiting_reason="Birleştirme onayı bekleniyor",
        )
        if approval.status != ApprovalStatus.approved:
            note = (approval.decision_note or "").strip()
            return NodeOutcome(
                status="failed",
                error=f"Birleştirme onaylanmadı: {note}" if note else "Birleştirme onaylanmadı.",
                feedback=note or None,
                loopable=approval.status == ApprovalStatus.rejected,
            )

    merged: list[dict[str, Any]] = []
    for wt, repo, ref, _ in items:
        result = await wm.merge(
            wt.id,
            target_ref=ref,
            strategy=cfg.strategy,
            message=f"{nctx.ex.task.title}\n\nAI Studio görev: {nctx.ex.task.id}",
        )
        if not result.merged:
            detail = result.message or ", ".join(result.conflicts) or "bilinmeyen hata"
            return NodeOutcome(
                status="failed",
                error=f"{repo.name}: birleştirme başarısız: {detail}",
                data={"merged": merged},
                loopable=False,
            )
        merged.append(
            {
                "repo_id": repo.id,
                "repo": repo.name,
                "worktree_id": wt.id,
                "target_ref": ref,
                "commit_sha": result.commit_sha,
            }
        )
    output = "\n".join(f"{m['repo']}: {m['target_ref']} ← {m['commit_sha'] or ''}".rstrip() for m in merged)
    return NodeOutcome(
        status="passed",
        output=f"Birleştirildi.\n{output}",
        data={
            "merged": merged,
            "strategy": cfg.strategy,
            "conflicts_resolved": resolved_any,
            "merge_commits": [m["commit_sha"] for m in merged if m["commit_sha"]],
        },
    )


# --------------------------------------------------------------------------- git


async def run_git_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, GitNodeConfig)
    target = _writer(nctx)
    wm = nctx.rt.worktrees()
    if cfg.action == "push":
        remote_branch = None
        if cfg.push_branch_template:
            remote_branch = (await nctx.render(cfg.push_branch_template)).strip() or None
        pushed = []
        for wid in target.worktree_ids:
            wt = await wm.get(wid)
            await wm.push(wid, remote_branch=remote_branch)
            pushed.append({"worktree_id": wid, "repo_id": wt.repo_id, "branch": remote_branch or wt.branch})
        return NodeOutcome(
            status="passed",
            output="Push edildi: " + ", ".join(p["branch"] for p in pushed),
            data={"pushed": pushed, "action": "push"},
        )

    hosting = nctx.rt.git_hosting()
    if hosting is None:
        raise NodeFailure("Git barındırma servisi hazır değil; PR açılamadı.")
    title = (await nctx.render(cfg.title_template)).strip() or nctx.ex.task.title
    if cfg.body_template:
        body = await nctx.render(cfg.body_template)
    else:
        summary, _ = await final_summary(nctx, target)
        body = f"## Görev\n{nctx.ex.task.prompt}\n\n{summary}\n\n_AI Studio ile hazırlandı._"
    prs: list[dict[str, Any]] = []
    for wid in target.worktree_ids:
        wt = await wm.get(wid)
        repo = await nctx.repo(wt.repo_id)
        await wm.push(wid)
        base = cfg.base_ref or nctx.ex.task.base_ref or repo.default_branch
        pr = await hosting.open_pull_request(
            repo.id, head=wt.branch, base=base, title=title, body=body, draft=cfg.draft
        )
        if cfg.watch:
            await hosting.watch(repo.id, pr.number, task_id=nctx.ex.task.id, autofix=cfg.autofix)
        prs.append({**pr.model_dump(mode="json"), "watching": cfg.watch})
    return NodeOutcome(
        status="passed",
        output="\n".join(f"{p['title']}: {p['url']}" for p in prs),
        data={"pull_requests": prs, "action": "open_pr"},
    )


# --------------------------------------------------------------------------- deploy


async def run_deploy_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, DeployNodeConfig)
    deploy = nctx.rt.deploy()
    if deploy is None:
        raise NodeFailure("Deploy servisi hazır değil; deploy yapılamadı.")
    ex = nctx.ex
    ref: str | None = None
    for up in ex.topo.upstream(nctx.node_id):
        res = ex.results.get(up)
        if res is None or res.status != "passed":
            continue
        data = res.data or {}
        if ex.topo.nodes[up].kind == NodeKind.merge and data.get("merge_commits"):
            ref = str(data["merge_commits"][0])
            break
        branches = data.get("branches")
        if isinstance(branches, dict) and branches:
            ref = str(next(iter(branches.values())))
            break
    summary, _ = await final_summary(nctx, nctx.writer_target(nearest_writer(ex.topo, nctx.node_id)))
    # Hand the flow's passed deploy_approval gate to the service so the user isn't asked twice;
    # the service re-validates it (same task/run/profile, production, recency, single use).
    gate_approval: str | None = None
    for nid in ex.topo.ancestors(nctx.node_id):
        gcfg = ex.topo.nodes[nid].config
        cached = ex.gate_cache.get(nid)
        if (
            isinstance(gcfg, GateNodeConfig)
            and gcfg.gate == GateKind.deploy_approval
            and cached is not None
            and cached.status == "passed"
            and cached.evidence.get("approval_id")
        ):
            gate_approval = str(cached.evidence["approval_id"])
    result = await deploy.deploy(
        cfg.profile_id,
        ref=ref,
        actor="engine",
        task_id=ex.task.id,
        run_id=ex.run_id,
        summary=summary,
        approval_id=gate_approval,
    )
    data = result.model_dump(mode="json")
    data["log"] = truncate(result.log, 8000)
    if result.status == "succeeded":
        return NodeOutcome(status="passed", output=f"Deploy başarılı ({result.environment.value}).", data=data)
    return NodeOutcome(
        status="failed", error=f"Deploy {result.status}: {truncate(result.log, 500)}", data=data, loopable=False
    )


# --------------------------------------------------------------------------- human


async def run_human_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, HumanNodeConfig)
    instructions = await nctx.render(cfg.instructions)
    approval = await nctx.approval(
        "human",
        approval_request(
            ApprovalKind.custom,
            nctx.node.label,
            summary=instructions,
            payload={"type": "human", "instructions": instructions, "input_schema": cfg.input_schema},
        ),
        waiting_reason="Kullanıcı adımı bekleniyor",
    )
    payload = dict(approval.decision_payload or {})
    if approval.status != ApprovalStatus.approved:
        note = (approval.decision_note or "").strip()
        return NodeOutcome(
            status="failed",
            error=f"Kullanıcı adımı reddedildi: {note}" if note else "Kullanıcı adımı reddedildi.",
            data=payload or None,
            feedback=note or None,
            loopable=approval.status == ApprovalStatus.rejected,
        )
    text = payload.get("text") or payload.get("answer")
    if not isinstance(text, str):
        text = json.dumps(payload, ensure_ascii=False) if payload else (approval.decision_note or "Tamamlandı.")
    return NodeOutcome(
        status="passed",
        output=text,
        data={**payload, "decided_by": approval.decided_by, "note": approval.decision_note},
    )
