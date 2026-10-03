"""Control gates (spec §9). Every gate records its input, check, evidence and decider.

Gate evidence is only what studiod produced itself (command exit codes, diffs, approvals,
structured review findings). An agent saying "tests pass" is never evidence.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal

from aistudio.contracts.agents import StartSessionRequest
from aistudio.contracts.approvals import ApprovalKind, ApprovalStatus
from aistudio.contracts.common import Environment, other_provider
from aistudio.contracts.flows import (
    LOCKED_GATES_FOR_PRODUCTION,
    AgentNodeConfig,
    DeployNodeConfig,
    GateKind,
    GateNodeConfig,
)
from aistudio.core import proc
from aistudio.core.events import EventFilter, Severity
from aistudio.core.text import truncate
from aistudio.engine.boundaries import Violation, check_commands, check_paths
from aistudio.engine.graph import nearest_writer
from aistudio.engine.models import ReviewState
from aistudio.engine.nodes.agent import read_only_location, structured_turns
from aistudio.engine.nodes.base import (
    NodeContext,
    NodeFailure,
    NodeOutcome,
    ResolvedAgent,
    WriterTarget,
    approval_request,
)
from aistudio.engine.structured import SEVERITIES, format_instructions
from aistudio.engine.templates import format_findings

GATE_LABEL: dict[str, str] = {
    "plan_approval": "Plan onayı",
    "boundary_check": "Sınır denetimi",
    "build_test": "Build/test kanıtı",
    "cross_review": "Çapraz inceleme",
    "user_final": "Son onay",
    "deploy_approval": "Deploy onayı",
    "custom_command": "Özel komut",
}
PROVIDER_LABEL: dict[str, str] = {"claude": "Claude", "codex": "Codex"}
OUTPUT_TAIL_CHARS = 4000
DIFF_PROMPT_CHARS = 60000


@dataclass
class GateVerdict:
    status: Literal["passed", "failed", "skipped"]
    summary: str
    evidence: dict[str, Any] = field(default_factory=dict)
    decided_by: str = "studiod"
    feedback: str | None = None
    output: str | None = None
    data: dict[str, Any] = field(default_factory=dict)
    loopable: bool = True
    target_node_id: str | None = None


def _tail(text: str, limit: int = OUTPUT_TAIL_CHARS) -> str:
    if len(text) <= limit:
        return text
    return "…" + text[-(limit - 1) :]


def gate_enabled(nctx: NodeContext, kind: GateKind) -> bool:
    return bool(getattr(nctx.ex.graph.settings.gates, kind.value, True))


async def run_gate_node(nctx: NodeContext) -> NodeOutcome:
    cfg = nctx.node.config
    assert isinstance(cfg, GateNodeConfig)
    kind = cfg.gate
    if not gate_enabled(nctx, kind):
        locked = kind in LOCKED_GATES_FOR_PRODUCTION and await nctx.ex.production_target()
        if not locked:
            await nctx.record_gate(
                kind, "skipped", summary="Kapı bu akışta kapalı olduğu için atlandı.", evidence={"reason": "disabled"}
            )
            return NodeOutcome(
                status="skipped",
                output="Kapı kapalı olduğu için atlandı.",
                data={"gate": kind.value, "skipped": "disabled"},
            )
    verdict = await run_gate_kind(nctx, cfg)
    if verdict.status == "skipped":
        verdict.evidence.setdefault("reason", "nothing_to_check")
    result = await nctx.record_gate(
        kind,
        verdict.status,
        summary=verdict.summary,
        evidence=verdict.evidence,
        decided_by=verdict.decided_by,
        target_node_id=verdict.target_node_id,
    )
    data = {"gate": kind.value, "gate_result_id": result.id, "decided_by": verdict.decided_by, **verdict.data}
    if verdict.target_node_id:
        data["target_node_id"] = verdict.target_node_id
    status = verdict.status
    return NodeOutcome(
        status=status,
        output=verdict.output if verdict.output is not None else verdict.summary,
        data=data,
        error=verdict.summary if status == "failed" else None,
        feedback=verdict.feedback,
        loopable=verdict.loopable,
    )


async def run_gate_kind(
    nctx: NodeContext,
    cfg: GateNodeConfig,
    *,
    target: WriterTarget | None = None,
    key: str = "",
) -> GateVerdict:
    """Run one gate check. ``target`` overrides the default writer target (compare/merge use it)."""
    kind = cfg.gate
    if kind == GateKind.plan_approval:
        return await plan_approval(nctx, cfg, key)
    if target is None and kind in (
        GateKind.boundary_check,
        GateKind.build_test,
        GateKind.cross_review,
        GateKind.user_final,
        GateKind.custom_command,
    ):
        target = nctx.writer_target(cfg.target_node_id or nearest_writer(nctx.ex.topo, nctx.node_id))
    if kind == GateKind.boundary_check:
        return await boundary_check(nctx, target)
    if kind == GateKind.build_test:
        return await build_test(nctx, cfg, target)
    if kind == GateKind.cross_review:
        return await cross_review(nctx, cfg, target, key)
    if kind == GateKind.user_final:
        return await user_final(nctx, target, key)
    if kind == GateKind.deploy_approval:
        return await deploy_approval(nctx, key)
    return await custom_command(nctx, cfg, target)


# --------------------------------------------------------------------------- plan approval


def _plan_source(nctx: NodeContext, cfg: GateNodeConfig) -> str | None:
    if cfg.target_node_id:
        return cfg.target_node_id
    for up in nctx.ex.topo.upstream(nctx.node_id):
        res = nctx.ex.results.get(up)
        if res is not None and res.status == "passed" and (res.output or "").strip():
            return up
    return None


async def plan_approval(nctx: NodeContext, cfg: GateNodeConfig, key: str) -> GateVerdict:
    source = _plan_source(nctx, cfg)
    if source is None:
        raise NodeFailure("Onaylanacak bir plan bulunamadı.")
    plan_text = nctx.ex.output_of(source)
    res = nctx.ex.results.get(source)
    structured = (res.data or {}).get("structured") if res else None
    summary = (structured or {}).get("summary") if isinstance(structured, dict) else None
    approval = await nctx.approval(
        f"{key}plan",
        approval_request(
            ApprovalKind.plan,
            f"Planı onayla: {nctx.ex.task.title}",
            summary=summary or truncate(plan_text, 600),
            payload={"plan": plan_text, "structured": structured, "node_id": source, "editable": True},
        ),
        waiting_reason="Plan onayı bekleniyor",
    )
    evidence: dict[str, Any] = {
        "approval_id": approval.id,
        "status": approval.status.value,
        "note": approval.decision_note,
        "plan_node_id": source,
    }
    decided_by = approval.decided_by or "user"
    if approval.status == ApprovalStatus.approved:
        edited = (approval.decision_payload or {}).get("plan")
        final = plan_text
        if isinstance(edited, str) and edited.strip() and edited.strip() != plan_text.strip():
            final = edited.strip()
            nctx.ex.state.overrides[source] = final
            await nctx.ex.persist_state()
            evidence["edited"] = True
        msg = "Plan onaylandı (kullanıcı düzenledi)." if evidence.get("edited") else "Plan onaylandı."
        return GateVerdict("passed", msg, evidence=evidence, decided_by=decided_by, output=final, target_node_id=source)
    note = (approval.decision_note or "").strip()
    if approval.status in (ApprovalStatus.expired, ApprovalStatus.cancelled):
        return GateVerdict(
            "failed",
            "Plan onayı süresi doldu veya iptal edildi.",
            evidence=evidence,
            decided_by=decided_by,
            loopable=False,
            target_node_id=source,
        )
    return GateVerdict(
        "failed",
        f"Plan reddedildi: {note}" if note else "Plan reddedildi.",
        evidence=evidence,
        decided_by=decided_by,
        feedback=note or "Kullanıcı planı reddetti; planı gözden geçirip yeniden hazırla.",
        target_node_id=source,
    )


# --------------------------------------------------------------------------- boundary check


async def _command_log(nctx: NodeContext, target: WriterTarget) -> list[str]:
    session_ids: set[str] = set()
    sid = target.data.get("session_id")
    if isinstance(sid, str):
        session_ids.add(sid)
    commands: list[str] = []
    for s in session_ids:
        events = await nctx.rt.ctx.events.query(EventFilter(session_id=s, types=["agent.tool.call"]), limit=5000)
        for ev in events:
            if ev.payload.get("kind") != "command":
                continue
            raw = (ev.payload.get("input") or {}).get("command")
            if isinstance(raw, list):
                raw = " ".join(str(x) for x in raw)
            if isinstance(raw, str) and raw.strip():
                commands.append(raw)
    return commands


async def boundary_check(nctx: NodeContext, target: WriterTarget | None) -> GateVerdict:
    if target is None or not target.worktree_ids:
        return GateVerdict("skipped", "Denetlenecek bir değişiklik yok.")
    wm = nctx.rt.worktrees()
    boundaries = await nctx.merged_boundaries(None, target.boundaries)
    violations: list[Violation] = []
    files_by_repo: dict[str, list[str]] = {}
    for wid in target.worktree_ids:
        wt = await wm.get(wid)
        repo = await nctx.repo(wt.repo_id)
        files = await wm.changed_files(wid)
        files_by_repo[repo.name] = files
        violations += check_paths(files, boundaries, repo=repo.name)
    commands = await _command_log(nctx, target) if boundaries.denied_commands else []
    violations += check_commands(commands, boundaries)
    checked = sum(len(v) for v in files_by_repo.values())
    evidence: dict[str, Any] = {
        "changed_files": files_by_repo,
        "commands_checked": len(commands),
        "rules": {
            "forbidden_paths": boundaries.forbidden_paths,
            "readonly_paths": boundaries.readonly_paths,
            "denied_commands": boundaries.denied_commands,
        },
        "violations": [v.model_dump() for v in violations],
    }
    if not violations:
        return GateVerdict(
            "passed",
            f"{checked} değişen dosya ve {len(commands)} komut denetlendi; sınır ihlali yok.",
            evidence=evidence,
            target_node_id=target.node_id,
        )
    await nctx.emit(
        "boundary.violation",
        {
            "target_node_id": target.node_id,
            "violations": [v.model_dump() for v in violations][:50],
            "count": len(violations),
        },
        severity=Severity.critical,
    )
    kind_label = {"forbidden": "yasak yol", "readonly": "salt okunur yol", "denied_command": "yasak komut"}
    lines = [f"- `{v.path}` ({kind_label[v.kind]}, kural: `{v.rule}`)" for v in violations]
    feedback = (
        "Sınır denetimi başarısız: aşağıdaki değişiklikler çalışma alanı sınırlarını ihlal ediyor. Bu dosyalardaki "
        "değişiklikleri geri al ve bu yollara dokunmadan görevi tamamla.\n" + "\n".join(lines)
    )
    return GateVerdict(
        "failed",
        f"{len(violations)} sınır ihlali bulundu.",
        evidence=evidence,
        feedback=feedback,
        target_node_id=target.node_id,
    )


# --------------------------------------------------------------------------- build / test


async def build_test(nctx: NodeContext, cfg: GateNodeConfig, target: WriterTarget | None) -> GateVerdict:
    if target is None or not target.worktree_ids:
        return GateVerdict("skipped", "Build/test çalıştırılacak bir worktree yok.")
    wm = nctx.rt.worktrees()
    timeout = float(await nctx.rt.int_setting("engine.command_timeout_seconds"))
    runs: list[dict[str, Any]] = []
    for wid in target.worktree_ids:
        wt = await wm.get(wid)
        repo = await nctx.repo(wt.repo_id)
        defined = repo.commands.defined()
        names = [n for n in defined if cfg.commands is None or n in cfg.commands]
        for name in names:
            command = defined[name]
            started = time.monotonic()
            try:
                code, output = await wm.run_command(wid, command, timeout=timeout)
            except TimeoutError:
                code, output = -1, f"Komut {int(timeout)} saniyede bitmedi (zaman aşımı)."
            duration_ms = int((time.monotonic() - started) * 1000)
            tail = nctx.rt.ctx.masker.mask(_tail(output))
            entry = {
                "repo_id": repo.id,
                "repo": repo.name,
                "worktree_id": wid,
                "name": name,
                "command": command,
                "exit_code": code,
                "duration_ms": duration_ms,
                "output_tail": tail,
            }
            runs.append(entry)
            await nctx.add_evidence(
                kind="command",
                title=f"{repo.name}: {name} (çıkış kodu {code})",
                content=tail,
                data={k: v for k, v in entry.items() if k != "output_tail"},
            )
            if code != 0 and name == "install":
                break
    if not runs:
        return GateVerdict(
            "skipped",
            "Repo'da tanımlı build/test komutu yok; kanıt üretilemedi.",
            evidence={"commands": []},
            target_node_id=target.node_id,
        )
    failed = [r for r in runs if r["exit_code"] != 0]
    evidence = {"commands": runs, "runner": "studiod", "note": "Komutları ajan değil studiod çalıştırdı."}
    if not failed:
        return GateVerdict(
            "passed",
            f"{len(runs)} komut başarıyla çalıştı.",
            evidence=evidence,
            target_node_id=target.node_id,
        )
    parts = [
        f"$ {r['command']}  ({r['repo']}, çıkış kodu {r['exit_code']})\n```\n{_tail(r['output_tail'], 1500)}\n```"
        for r in failed
    ]
    feedback = "Build/test kanıtı başarısız. Hataları düzelt:\n\n" + "\n\n".join(parts)
    names = ", ".join(f"{r['repo']}:{r['name']}" for r in failed)
    return GateVerdict(
        "failed",
        f"{len(failed)}/{len(runs)} komut başarısız: {names}",
        evidence=evidence,
        feedback=feedback,
        target_node_id=target.node_id,
    )


# --------------------------------------------------------------------------- cross review


def _plan_text_for(nctx: NodeContext, author_id: str) -> str:
    topo = nctx.ex.topo
    for up in topo.upstream(author_id):
        cfg = topo.nodes[up].config
        if isinstance(cfg, GateNodeConfig) and cfg.gate == GateKind.plan_approval:
            return nctx.ex.output_of(up)
        if isinstance(cfg, AgentNodeConfig) and cfg.output_format == "plan":
            return nctx.ex.output_of(up)
    return ""


async def diff_text(
    nctx: NodeContext, worktree_ids: list[str], limit: int = DIFF_PROMPT_CHARS
) -> tuple[str, list[dict]]:
    wm = nctx.rt.worktrees()
    chunks: list[str] = []
    stats: list[dict[str, Any]] = []
    for wid in worktree_ids:
        wt = await wm.get(wid)
        repo = await nctx.repo(wt.repo_id)
        diff = await wm.diff(wid, include_patch=True)
        stats.append(
            {
                "repo": repo.name,
                "worktree_id": wid,
                "branch": wt.branch,
                "files": [
                    {"path": f.path, "status": f.status, "additions": f.additions, "deletions": f.deletions}
                    for f in diff.files
                ],
                "additions": diff.additions,
                "deletions": diff.deletions,
            }
        )
        for f in diff.files:
            header = f"# {repo.name}/{f.path} ({f.status}, +{f.additions} -{f.deletions})"
            chunks.append(header + ("\n" + f.patch if f.patch else ""))
    text = "\n\n".join(chunks)
    return truncate(text, limit), stats


async def cross_review(nctx: NodeContext, cfg: GateNodeConfig, target: WriterTarget | None, key: str) -> GateVerdict:
    if target is None:
        raise NodeFailure("Çapraz incelemenin inceleyeceği yazar düğümü bulunamadı.")
    ex = nctx.ex
    author_provider = target.provider or await ex.default_provider()
    reviewer_provider = other_provider(author_provider)
    profile = None
    overridden = False
    if cfg.reviewer_profile_id:
        profile = await nctx.rt.agents().resolve_profile(cfg.reviewer_profile_id)
        overridden = profile.provider == author_provider
    use_profile = profile is not None and not overridden
    agent = ResolvedAgent(
        provider=reviewer_provider,
        model=cfg.reviewer_model or (profile.model if use_profile and profile else None),
        effort=profile.effort if use_profile and profile else None,
        role="reviewer",
        boundaries=await nctx.merged_boundaries(profile, None, read_only=True),
        instructions=profile.instructions if profile else "",
        profile_id=profile.id if use_profile and profile else None,
    )
    provider, limit_info = await nctx.ensure_provider(
        reviewer_provider,
        purpose="Çapraz inceleme",
        forbidden=author_provider,
        allow_switch=False,
        same_provider_review=True,
    )
    if provider != reviewer_provider:
        agent.provider, agent.model, agent.effort = provider, None, None
    if agent.provider == author_provider and "same_provider_approved_by" not in limit_info:
        raise NodeFailure("Çapraz inceleme kuralı: inceleyen, yazarla aynı sağlayıcıda olamaz.")

    diff, stats = await diff_text(nctx, target.worktree_ids)
    plan = _plan_text_for(nctx, target.node_id)
    previous = ex.state.review.findings if ex.state.review and ex.state.review.gate == nctx.node_id else []
    parts = [
        "Başka bir modelin yaptığı değişikliği bağımsız olarak incele. Dosyaları değiştirme.",
        f"## Görev\n{ex.task.prompt}",
    ]
    if plan.strip():
        parts.append(f"## Onaylanan plan\n{truncate(plan, 6000)}")
    if cfg.review_focus:
        parts.append(f"## İnceleme odağı\n{cfg.review_focus}")
    if target.output.strip():
        parts.append(f"## Yazarın özeti\n{truncate(target.output, 3000)}")
    if previous:
        parts.append(
            "## Önceki turun bulguları\nBunların düzeltilip düzeltilmediğini özellikle kontrol et:\n"
            + format_findings(previous)
        )
    parts.append(f"## Değişiklikler\n```diff\n{diff or '(boş diff)'}\n```")
    blocking_names = ", ".join(cfg.blocking_severities)
    parts.append(
        f"'{blocking_names}' önem derecesindeki bulgular işi yazara geri gönderir; derecelendirmeyi buna göre "
        "dürüstçe yap."
    )
    prompt = "\n\n".join(parts) + format_instructions("findings")

    wm = nctx.rt.worktrees()
    first = await wm.get(target.worktree_ids[0]) if target.worktree_ids else None
    if first is not None:
        cwd, extra_dirs = first.path, []
    else:
        cwd, extra_dirs = read_only_location(nctx, ex.target_repos(None))
    system = await nctx.system_append("reviewer", agent.instructions)

    async def build_request() -> StartSessionRequest:
        return nctx.session_request(
            agent, cwd=cwd, system_append=system, extra_dirs=extra_dirs, label=f"{nctx.node.label} · inceleyen"
        )

    reuse_key = f"review:{nctx.node_id}:{target.node_id}:{agent.provider}"
    turn = await nctx.run_turn(
        key=f"{key}review", message=prompt, provider=agent.provider, build_request=build_request, reuse_key=reuse_key
    )
    parsed, _ = await structured_turns(
        nctx,
        fmt="findings",
        text=turn.text,
        provider=agent.provider,
        build_request=build_request,
        reuse_key=reuse_key,
        key=f"{key}review_format",
    )
    if parsed is None:
        raise NodeFailure("İnceleyicinin bulguları yapılandırılmış biçimde okunamadı.")
    findings: list[dict[str, Any]] = parsed["findings"]
    blocking = [f for f in findings if f["severity"] in cfg.blocking_severities]
    counts = {s: sum(1 for f in findings if f["severity"] == s) for s in SEVERITIES}
    evidence: dict[str, Any] = {
        "author_node_id": target.node_id,
        "author_provider": author_provider,
        "reviewer_provider": agent.provider,
        "reviewer_model": agent.model,
        "reviewer_session_id": turn.session_id,
        "verdict": parsed.get("verdict"),
        "summary": parsed.get("summary"),
        "findings": findings,
        "counts": counts,
        "blocking_severities": cfg.blocking_severities,
        "blocking_count": len(blocking),
        "diffstat": stats,
        **({"reviewer_profile_overridden": True} if overridden else {}),
        **limit_info,
    }
    await nctx.add_evidence(
        kind="review",
        title=f"Çapraz inceleme ({PROVIDER_LABEL.get(agent.provider, agent.provider)}): {len(findings)} bulgu",
        content=format_findings(findings) or "Bulgu yok.",
        data={"counts": counts, "blocking_count": len(blocking), "reviewer_provider": agent.provider},
    )
    decided_by = f"agent:{agent.provider}"
    data = {"findings": findings, "counts": counts, "reviewer_provider": agent.provider, "session_id": turn.session_id}
    if blocking:
        ex.state.review = ReviewState(
            findings=findings, gate=nctx.node_id, round=ex.state.loops.get(nctx.node_id, 0) + 1
        )
        await ex.persist_state()
        others = [f for f in findings if f not in blocking]
        feedback = "Çapraz inceleme engelleyici bulgular buldu. Bunların hepsini düzelt:\n" + format_findings(blocking)
        if others:
            feedback += "\n\nDiğer bulgular (uygunsa düzelt):\n" + format_findings(others)
        return GateVerdict(
            "failed",
            f"{len(blocking)} engelleyici bulgu ({len(findings)} bulgu).",
            evidence=evidence,
            decided_by=decided_by,
            feedback=feedback,
            output=format_findings(findings),
            data=data,
            target_node_id=target.node_id,
        )
    if ex.state.review is not None and ex.state.review.gate == nctx.node_id:
        ex.state.review = None
        await ex.persist_state()
    return GateVerdict(
        "passed",
        f"{len(findings)} bulgu, engelleyici yok.",
        evidence=evidence,
        decided_by=decided_by,
        output=format_findings(findings) or "Bulgu yok.",
        data=data,
        target_node_id=target.node_id,
    )


# --------------------------------------------------------------------------- user final


async def final_summary(nctx: NodeContext, target: WriterTarget | None) -> tuple[str, dict[str, Any]]:
    ex = nctx.ex
    stats: list[dict[str, Any]] = []
    if target is not None and target.worktree_ids and nctx.rt.maybe_worktrees() is not None:
        _, stats = await diff_text(nctx, target.worktree_ids, limit=0)
    gates = []
    for nid, g in ex.gate_cache.items():
        if nid == nctx.node_id:
            continue
        gates.append(
            {
                "node_id": nid,
                "label": ex.topo.nodes[nid].label if nid in ex.topo.nodes else nid,
                "kind": g.kind,
                "status": g.status,
                "summary": g.summary,
                "attempt": g.attempt,
            }
        )
    evidence = await nctx.rt.store.evidence(run_id=ex.run_id)
    status_tr = {"passed": "geçti", "failed": "başarısız", "skipped": "atlandı"}
    files = sum(len(s["files"]) for s in stats)
    adds = sum(int(s["additions"]) for s in stats)
    dels = sum(int(s["deletions"]) for s in stats)
    lines = [f"**Görev:** {ex.task.title}"]
    if target is not None and target.output.strip():
        lines.append(f"**Ajanın özeti:**\n{truncate(target.output, 1500)}")
    if stats:
        lines.append(f"**Değişiklikler:** {files} dosya, +{adds} −{dels}")
    if gates:
        lines.append(
            "**Kapılar:**\n"
            + "\n".join(f"- {g['label']}: {status_tr.get(g['status'], g['status'])} — {g['summary']}" for g in gates)
        )
    payload = {
        "diffstat": stats,
        "gates": gates,
        "evidence": [
            {"id": e.id, "title": e.title, "kind": e.kind, "source": e.source, "label": e.label} for e in evidence
        ],
        "writer_node_id": target.node_id if target else None,
        "writer_output": target.output if target else None,
    }
    return "\n\n".join(lines), payload


async def user_final(nctx: NodeContext, target: WriterTarget | None, key: str) -> GateVerdict:
    summary, payload = await final_summary(nctx, target)
    approval = await nctx.approval(
        f"{key}final",
        approval_request(
            ApprovalKind.final,
            f"Son onay: {nctx.ex.task.title}",
            summary=summary,
            payload={"summary": summary, **payload},
        ),
        waiting_reason="Son onay bekleniyor",
    )
    evidence = {"approval_id": approval.id, "status": approval.status.value, "note": approval.decision_note}
    decided_by = approval.decided_by or "user"
    if approval.status == ApprovalStatus.approved:
        return GateVerdict(
            "passed", "Kullanıcı son onayı verdi.", evidence=evidence, decided_by=decided_by, output=summary
        )
    note = (approval.decision_note or "").strip()
    return GateVerdict(
        "failed",
        f"Son onay verilmedi: {note}" if note else "Son onay verilmedi.",
        evidence=evidence,
        decided_by=decided_by,
        feedback=note or "Kullanıcı son onayı vermedi; işi gözden geçir ve iyileştir.",
        loopable=approval.status == ApprovalStatus.rejected,
        target_node_id=target.node_id if target else None,
    )


# --------------------------------------------------------------------------- deploy approval


async def deploy_approval(nctx: NodeContext, key: str) -> GateVerdict:
    ex = nctx.ex
    deploy = nctx.rt.deploy()
    profiles: list[dict[str, Any]] = []
    production = False
    for nid in ex.topo.descendants(nctx.node_id):
        cfg = ex.topo.nodes[nid].config
        if not isinstance(cfg, DeployNodeConfig):
            continue
        entry: dict[str, Any] = {"node_id": nid, "profile_id": cfg.profile_id}
        if deploy is not None:
            try:
                p = await deploy.get_profile(cfg.profile_id)
                entry.update(name=p.name, environment=p.environment.value, kind=p.kind)
                production = production or p.environment == Environment.production
            except Exception:
                entry["error"] = "Profil okunamadı."
        profiles.append(entry)
    production = production or await ex.production_target()
    names = ", ".join(str(p.get("name") or p["profile_id"]) for p in profiles) or "deploy"
    summary, payload = await final_summary(nctx, nctx.writer_target(nearest_writer(ex.topo, nctx.node_id)))
    approval = await nctx.approval(
        f"{key}deploy",
        approval_request(
            ApprovalKind.deploy,
            f"Deploy onayı: {names}",
            summary=summary,
            payload={"profiles": profiles, **payload},
            production=production,
            severity=Severity.critical if production else Severity.high,
        ),
        waiting_reason="Deploy onayı bekleniyor",
    )
    evidence = {
        "approval_id": approval.id,
        "status": approval.status.value,
        "production": production,
        "profiles": profiles,
        "note": approval.decision_note,
    }
    decided_by = approval.decided_by or "user"
    if approval.status == ApprovalStatus.approved:
        return GateVerdict("passed", "Deploy onaylandı.", evidence=evidence, decided_by=decided_by)
    note = (approval.decision_note or "").strip()
    return GateVerdict(
        "failed",
        f"Deploy onaylanmadı: {note}" if note else "Deploy onaylanmadı.",
        evidence=evidence,
        decided_by=decided_by,
        feedback=note or None,
        loopable=approval.status == ApprovalStatus.rejected,
    )


# --------------------------------------------------------------------------- custom command


async def custom_command(nctx: NodeContext, cfg: GateNodeConfig, target: WriterTarget | None) -> GateVerdict:
    command = (cfg.command or "").strip()
    if not command:
        raise NodeFailure("Özel komut kapısı için komut tanımlı değil.")
    timeout = float(await nctx.rt.int_setting("engine.command_timeout_seconds"))
    runs: list[dict[str, Any]] = []
    if target is not None and target.worktree_ids:
        wm = nctx.rt.worktrees()
        for wid in target.worktree_ids:
            wt = await wm.get(wid)
            repo = await nctx.repo(wt.repo_id)
            started = time.monotonic()
            try:
                code, output = await wm.run_command(wid, command, timeout=timeout)
            except TimeoutError:
                code, output = -1, "Zaman aşımı."
            runs.append(
                {
                    "repo": repo.name,
                    "worktree_id": wid,
                    "exit_code": code,
                    "duration_ms": int((time.monotonic() - started) * 1000),
                    "output_tail": nctx.rt.ctx.masker.mask(_tail(output)),
                }
            )
    else:
        for repo in nctx.ex.target_repos(None):
            if repo.host_id is not None:
                continue
            try:
                done = await proc.run(["/bin/sh", "-c", command], cwd=repo.path, timeout=timeout)
                code, output, dur = done.returncode, done.stdout + done.stderr, done.duration_ms
            except TimeoutError:
                code, output, dur = -1, "Zaman aşımı.", int(timeout * 1000)
            runs.append(
                {
                    "repo": repo.name,
                    "worktree_id": None,
                    "exit_code": code,
                    "duration_ms": dur,
                    "output_tail": nctx.rt.ctx.masker.mask(_tail(output)),
                }
            )
    if not runs:
        return GateVerdict("skipped", "Komutun çalıştırılacağı bir repo yok.")
    for r in runs:
        await nctx.add_evidence(
            kind="command",
            title=f"{r['repo']}: {command} (çıkış kodu {r['exit_code']})",
            content=r["output_tail"],
            data={"command": command, "exit_code": r["exit_code"], "duration_ms": r["duration_ms"]},
        )
    failed = [r for r in runs if r["exit_code"] != 0]
    evidence = {"command": command, "runs": runs, "runner": "studiod"}
    if failed:
        feedback = f"`{command}` başarısız oldu:\n" + "\n".join(
            f"```\n{_tail(r['output_tail'], 1500)}\n```" for r in failed
        )
        return GateVerdict(
            "failed",
            f"Komut {len(failed)} repoda başarısız oldu.",
            evidence=evidence,
            feedback=feedback,
            target_node_id=target.node_id if target else None,
        )
    return GateVerdict(
        "passed", "Komut başarıyla çalıştı.", evidence=evidence, target_node_id=target.node_id if target else None
    )
