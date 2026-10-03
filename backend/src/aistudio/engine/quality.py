"""Quality score (spec §18) and agent performance history.

Quality score of a completed run, 0..100, with a transparent formula::

    score = 100 × Σ(weight × value) / Σ(weight)      over the components that apply

    gates_first_pass  30%  share of gate checks that passed on their first attempt
    review            25%  1 − (40·critical + 15·high + 5·medium + 1·low) / 100 over all review rounds
    tests             25%  share of studiod-run build/test commands that passed in the latest check
    rework            10%  1 − 0.25 × loop-backs (review/build/approval rounds)
    user_rating       10%  (rating − 1) / 4 for a 1..5 user rating

A component that does not apply (no reviews, no commands, no rating...) is left out and its
weight is redistributed over the others.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import TYPE_CHECKING, Any

from aistudio.core.clock import utcnow
from aistudio.core.events import Severity
from aistudio.engine.models import AgentStat, AgentStatsReport, GateResult, QualityBreakdown, QualityComponent, RunState

if TYPE_CHECKING:
    from aistudio.engine.runtime import EngineRuntime

WEIGHTS: dict[str, float] = {
    "gates_first_pass": 30.0,
    "review": 25.0,
    "tests": 25.0,
    "rework": 10.0,
    "user_rating": 10.0,
}
SEVERITY_PENALTY: dict[str, float] = {"critical": 40.0, "high": 15.0, "medium": 5.0, "low": 1.0}
FORMULA = (
    "Puan = 100 × Σ(ağırlık × değer) / Σ(ağırlık). Uygulanamayan bileşenler hesaba katılmaz, ağırlıkları "
    "diğerlerine dağıtılır. Ağırlıklar: kapıların ilk denemede geçmesi %30, inceleme bulguları %25, "
    "build/test komutları %25, tekrar turları %10, kullanıcı puanı %10."
)


def compute_quality(
    gates: list[GateResult], state: RunState, rating: int | None, *, run_id: str | None = None
) -> QualityBreakdown:
    components: list[QualityComponent] = []

    # gates passing on their first attempt
    groups: dict[tuple[str, str, str | None], list[GateResult]] = defaultdict(list)
    for g in gates:
        groups[(g.node_id, g.kind, g.target_node_id)].append(g)
    firsts = [min(items, key=lambda x: (x.attempt, x.created_at)) for items in groups.values()]
    counted = [g for g in firsts if g.status != "skipped"]
    first_pass = sum(1 for g in counted if g.status == "passed")
    components.append(
        QualityComponent(
            key="gates_first_pass",
            label="Kapıların ilk denemede geçmesi",
            weight=WEIGHTS["gates_first_pass"],
            value=(first_pass / len(counted)) if counted else None,
            detail=f"{first_pass}/{len(counted)} kapı ilk denemede geçti." if counted else "Çalışan kapı yok.",
            raw={"first_pass": first_pass, "gates": len(counted)},
        )
    )

    # review findings across every review round
    reviews = [g for g in gates if g.kind == "cross_review" and g.status != "skipped"]
    counts = {s: 0 for s in SEVERITY_PENALTY}
    for g in reviews:
        for f in g.evidence.get("findings") or []:
            sev = str(f.get("severity", "medium")) if isinstance(f, dict) else "medium"
            counts[sev if sev in counts else "medium"] += 1
    penalty = sum(SEVERITY_PENALTY[s] * n for s, n in counts.items())
    components.append(
        QualityComponent(
            key="review",
            label="İnceleme bulgularının ağırlığı",
            weight=WEIGHTS["review"],
            value=max(0.0, 1.0 - penalty / 100.0) if reviews else None,
            detail=(
                f"{len(reviews)} inceleme turunda {counts['critical']} kritik, {counts['high']} yüksek, "
                f"{counts['medium']} orta, {counts['low']} düşük bulgu (ceza {penalty:g})."
                if reviews
                else "Çapraz inceleme yapılmadı."
            ),
            raw={"rounds": len(reviews), "counts": counts, "penalty": penalty},
        )
    )

    # tests: latest build_test per gate node
    latest_tests: dict[tuple[str, str | None], GateResult] = {}
    for g in gates:
        if g.kind == "build_test" and g.status != "skipped":
            latest_tests[(g.node_id, g.target_node_id)] = g
    total_cmds = passed_cmds = 0
    for g in latest_tests.values():
        for c in g.evidence.get("commands") or []:
            total_cmds += 1
            passed_cmds += 1 if c.get("exit_code") == 0 else 0
    components.append(
        QualityComponent(
            key="tests",
            label="Build/test komutları",
            weight=WEIGHTS["tests"],
            value=(passed_cmds / total_cmds) if total_cmds else None,
            detail=f"Son kontrolde {passed_cmds}/{total_cmds} komut başarılı." if total_cmds else "Komut çalışmadı.",
            raw={"passed": passed_cmds, "total": total_cmds},
        )
    )

    loops = sum(state.loops.values())
    components.append(
        QualityComponent(
            key="rework",
            label="Tekrar turları",
            weight=WEIGHTS["rework"],
            value=max(0.0, 1.0 - 0.25 * loops),
            detail=f"{loops} kez geri dönüldü." if loops else "Geri dönüş olmadı.",
            raw={"loops": loops, "by_node": dict(state.loops)},
        )
    )

    components.append(
        QualityComponent(
            key="user_rating",
            label="Kullanıcı puanı",
            weight=WEIGHTS["user_rating"],
            value=((rating - 1) / 4.0) if rating is not None else None,
            detail=f"Kullanıcı puanı {rating}/5." if rating is not None else "Kullanıcı puanı verilmedi.",
            raw={"rating": rating},
        )
    )

    applicable = [c for c in components if c.value is not None]
    total_weight = sum(c.weight for c in applicable)
    score = (
        round(100.0 * sum(c.weight * (c.value or 0.0) for c in applicable) / total_weight, 1) if total_weight else None
    )
    return QualityBreakdown(score=score, components=components, formula=FORMULA, run_id=run_id, computed_at=utcnow())


async def compute_for_run(rt: EngineRuntime, task_id: str, run_id: str) -> QualityBreakdown:
    row = await rt.store.run_row(run_id)
    task_row = await rt.store.task_row(task_id)
    gates = await rt.store.gate_results(run_id)
    state = RunState.model_validate(row["state"] or {})
    return compute_quality(gates, state, task_row["rating"], run_id=run_id)


async def compute_and_store(rt: EngineRuntime, task_id: str, run_id: str) -> QualityBreakdown:
    breakdown = await compute_for_run(rt, task_id, run_id)
    dumped = breakdown.model_dump(mode="json")
    await rt.store.update_run(run_id, quality=dumped)
    await rt.store.update_task(task_id, quality_score=breakdown.score, quality=dumped)
    task_row = await rt.store.task_row(task_id)
    await rt.emit(
        "task.quality",
        {"task_id": task_id, "run_id": run_id, "score": breakdown.score},
        severity=Severity.info,
        workspace_id=task_row["workspace_id"],
        task_id=task_id,
        run_id=run_id,
    )
    return breakdown


# --------------------------------------------------------------------------- agent performance

ROLE_TR: dict[str, str] = {
    "writer": "kod yazma",
    "planner": "planlama",
    "tester": "test yazma",
    "reviewer": "inceleme",
    "advisor": "danışmanlık",
    "judge": "hakemlik",
    "synthesizer": "sentez",
}
PROVIDER_LABEL: dict[str, str] = {"claude": "Claude", "codex": "Codex"}


_Key = tuple[str | None, str, str | None]


async def agent_stats(
    rt: EngineRuntime, *, workspace_id: str | None = None, since: datetime | None = None
) -> AgentStatsReport:
    runs = await rt.store.run_rows(workspace_id=workspace_id, since=since)
    run_task = {r["id"]: r["task_id"] for r in runs}
    if not run_task:
        return AgentStatsReport(since=since)
    node_rows = [r for r in await rt.store.all_node_run_rows(since=since) if r["run_id"] in run_task]
    gate_rows = await rt.store.gate_results(run_ids=list(run_task))
    task_quality: dict[str, float | None] = {}
    for tid in set(run_task.values()):
        try:
            task_quality[tid] = (await rt.store.task_row(tid))["quality_score"]
        except Exception:
            task_quality[tid] = None

    stats: dict[_Key, AgentStat] = {}
    durations: dict[_Key, list[float]] = defaultdict(list)
    tasks_by_key: dict[_Key, set[str]] = defaultdict(set)
    by_node: dict[tuple[str, str], list[tuple[datetime, _Key]]] = defaultdict(list)

    for r in node_rows:
        data = r["data"] or {}
        provider = data.get("provider")
        if r["kind"] not in ("agent", "advisor", "synthesis") or provider not in ("claude", "codex"):
            continue
        key: _Key = (data.get("profile_id"), provider, data.get("model"))
        st = stats.setdefault(key, AgentStat(profile_id=key[0], provider=provider, model=key[2]))
        if r["status"] in ("passed", "failed"):
            st.node_runs += 1
            if r["status"] == "passed":
                st.passed += 1
            else:
                st.failed += 1
            if r["started_at"] and r["finished_at"]:
                durations[key].append((r["finished_at"] - r["started_at"]).total_seconds())
        role = str(data.get("role") or r["kind"])
        st.roles[role] = st.roles.get(role, 0) + 1
        tasks_by_key[key].add(run_task[r["run_id"]])
        by_node[(r["run_id"], r["node_id"])].append((r["created_at"], key))

    groups: dict[tuple[str, str, str, str], list[GateResult]] = defaultdict(list)
    for g in gate_rows:
        if g.target_node_id and g.status != "skipped":
            groups[(g.run_id, g.node_id, g.kind, g.target_node_id)].append(g)
    for (run_id, _node, _kind, target), items in groups.items():
        first = min(items, key=lambda x: (x.attempt, x.created_at))
        authors = sorted(by_node.get((run_id, target), []), key=lambda x: x[0])
        before = [k for ts, k in authors if ts <= first.created_at]
        if not before:
            continue
        st = stats[before[-1]]
        st.gate_checks += 1
        st.gate_first_pass += 1 if first.status == "passed" else 0

    limits = rt.limits()
    usage_cache: dict[str, Any] = {}
    for key, st in stats.items():
        finished = st.passed + st.failed
        st.success_rate = round(st.passed / finished, 3) if finished else None
        d = durations.get(key)
        st.avg_duration_s = round(sum(d) / len(d), 1) if d else None
        st.gate_first_pass_rate = round(st.gate_first_pass / st.gate_checks, 3) if st.gate_checks else None
        tids = tasks_by_key[key]
        st.tasks = len(tids)
        qs = [q for q in (task_quality.get(t) for t in tids) if q is not None]
        st.avg_quality = round(sum(qs) / len(qs), 1) if qs else None
        if limits is not None:
            five = weekly = 0.0
            seen = False
            for tid in list(tids)[:200]:
                if tid not in usage_cache:
                    try:
                        usage_cache[tid] = await limits.task_usage(tid)
                    except Exception:
                        usage_cache[tid] = None
                usage = usage_cache[tid]
                if usage is None:
                    continue
                per = usage.by_provider.get(st.provider) or {}
                if per:
                    seen = True
                    five += float(per.get("five_hour_percent_spent", 0.0))
                    weekly += float(per.get("weekly_percent_spent", 0.0))
            if seen:
                st.five_hour_percent_spent = round(five, 2)
                st.weekly_percent_spent = round(weekly, 2)

    ordered = sorted(stats.values(), key=lambda s: (-(s.node_runs), s.provider, s.model or ""))
    return AgentStatsReport(stats=ordered, recommendations=_recommendations(ordered), since=since)


def _recommendations(stats: list[AgentStat]) -> list[str]:
    out: list[str] = []
    roles = sorted({role for s in stats for role in s.roles})
    for role in roles:
        candidates = [s for s in stats if s.roles.get(role, 0) >= 3 and s.success_rate is not None]
        if len(candidates) < 2:
            continue
        best = max(candidates, key=lambda s: (s.success_rate or 0.0, s.avg_quality or 0.0))
        rest = [c for c in candidates if c is not best]
        if all((best.success_rate or 0) > (c.success_rate or 0) for c in rest):
            name = PROVIDER_LABEL.get(best.provider, best.provider) + (f" ({best.model})" if best.model else "")
            out.append(
                f"{ROLE_TR.get(role, role).capitalize()} işlerinde {name} daha başarılı: "
                f"%{round((best.success_rate or 0) * 100)} başarı, {best.roles.get(role, 0)} koşu."
            )
    best_gate = [s for s in stats if s.gate_checks >= 3 and s.gate_first_pass_rate is not None]
    if len(best_gate) >= 2:
        top = max(best_gate, key=lambda s: s.gate_first_pass_rate or 0.0)
        name = PROVIDER_LABEL.get(top.provider, top.provider) + (f" ({top.model})" if top.model else "")
        out.append(f"Kapılardan ilk denemede en sık geçen: {name} (%{round((top.gate_first_pass_rate or 0) * 100)}).")
    return out
