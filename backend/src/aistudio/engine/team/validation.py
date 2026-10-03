"""Static team validation (Turkish messages, shown in the team builder)."""

from __future__ import annotations

import re

from aistudio.contracts.teams import TeamMember, TeamRole, TeamSpec, TestMode
from aistudio.engine.team.models import TeamIssue, TeamValidationReport

CLAUDE_EFFORTS: tuple[str, ...] = ("low", "medium", "high", "xhigh", "max")
CODEX_EFFORTS: tuple[str, ...] = ("none", "minimal", "low", "medium", "high", "xhigh")
EFFORTS: dict[str, tuple[str, ...]] = {"claude": CLAUDE_EFFORTS, "codex": CODEX_EFFORTS}
ROLE_TR: dict[str, str] = {"advisor": "Danışman", "lead": "Lider", "worker": "Geliştirici", "tester": "Test ajanı"}
MAX_DEPTH_LIMIT = 8

_MEMBER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def member_depths(spec: TeamSpec) -> dict[str, int]:
    """Depth of every lead/worker reachable from the lead (lead = 0). Cycles are left out."""
    try:
        lead = spec.lead()
    except ValueError:
        return {}
    depths = {lead.id: 0}
    frontier = [lead.id]
    while frontier:
        nxt: list[str] = []
        for mid in frontier:
            for sub in spec.subordinates(mid):
                if sub.id not in depths:
                    depths[sub.id] = depths[mid] + 1
                    nxt.append(sub.id)
        frontier = nxt
    return depths


def subtree(spec: TeamSpec, member_id: str) -> set[str]:
    """``member_id`` and every worker below it."""
    out = {member_id}
    frontier = [member_id]
    while frontier:
        nxt: list[str] = []
        for mid in frontier:
            for sub in spec.subordinates(mid):
                if sub.id not in out:
                    out.add(sub.id)
                    nxt.append(sub.id)
        frontier = nxt
    return out


def chain(spec: TeamSpec, member_id: str) -> list[str]:
    """``member_id`` and its managers up to the lead (nearest first)."""
    out: list[str] = []
    seen: set[str] = set()
    cur: str | None = member_id
    while cur is not None and cur not in seen:
        seen.add(cur)
        out.append(cur)
        try:
            cur = spec.member(cur).parent_id
        except KeyError:
            break
    return out


def advisor_in_chain(spec: TeamSpec, member_id: str) -> TeamMember | None:
    """The nearest advisor attached to the member or to one of its managers."""
    for mid in chain(spec, member_id):
        adv = spec.advisor_of(mid)
        if adv is not None:
            return adv
    return None


def validate_team(spec: TeamSpec) -> TeamValidationReport:
    errors: list[TeamIssue] = []
    warnings: list[TeamIssue] = []

    def err(code: str, message: str, member_id: str | None = None) -> None:
        errors.append(TeamIssue(code=code, message=message, member_id=member_id))

    def warn(code: str, message: str, member_id: str | None = None) -> None:
        warnings.append(TeamIssue(code=code, message=message, member_id=member_id))

    s = spec.settings
    if s.max_parallel_members < 1:
        err("bad_setting", "Aynı anda çalışacak üye sayısı en az 1 olmalı.")
    if not 1 <= s.max_depth <= MAX_DEPTH_LIMIT:
        err("bad_setting", f"En fazla derinlik 1 ile {MAX_DEPTH_LIMIT} arasında olmalı.")
    if s.max_assignments < 1:
        err("bad_setting", "En fazla iş sayısı en az 1 olmalı.")
    if s.test_max_rounds < 0:
        err("bad_setting", "Test tur sınırı negatif olamaz.")
    if s.report_interval_minutes < 1:
        err("bad_setting", "Rapor aralığı en az 1 dakika olmalı.")

    if not spec.members:
        err("empty", "Ekipte hiç üye yok.")
        return TeamValidationReport(ok=False, errors=errors, warnings=warnings)

    seen: set[str] = set()
    for m in spec.members:
        if m.id in seen:
            err("duplicate_member", f"Aynı kimliğe sahip birden fazla üye var: {m.id}", m.id)
        seen.add(m.id)
        if not _MEMBER_ID.match(m.id) or m.id == "engine":
            err(
                "bad_member_id",
                f"Üye kimliği geçersiz: {m.id!r}. Harf veya rakamla başlamalı; yalnız harf, rakam, '-' ve '_' "
                "içermeli ('engine' kullanılamaz).",
                m.id,
            )
        if not m.name.strip():
            err("empty_name", f"Üyenin adı boş: {m.id}", m.id)
        if m.effort is not None and m.profile_id is None and m.effort not in EFFORTS[m.provider]:
            allowed = ", ".join(EFFORTS[m.provider])
            err("bad_effort", f"'{m.name}' için geçersiz effort: {m.effort}. Geçerli değerler: {allowed}.", m.id)
    if errors:
        return TeamValidationReport(ok=False, errors=errors, warnings=warnings)

    by_id = {m.id: m for m in spec.members}
    leads = [m for m in spec.members if m.role == TeamRole.lead]
    if not leads:
        err("no_lead", "Ekipte bir lider olmalı.")
    elif len(leads) > 1:
        err("multiple_leads", "Ekipte yalnız bir lider olabilir: " + ", ".join(m.name for m in leads))
    lead = leads[0] if len(leads) == 1 else None
    if lead is not None and lead.parent_id is not None:
        err("lead_parent", "Liderin üstünde bir üye olamaz.", lead.id)

    children: dict[str, list[TeamMember]] = {}
    for m in spec.members:
        if m.parent_id is not None:
            children.setdefault(m.parent_id, []).append(m)

    for m in spec.members:
        if m.role == TeamRole.lead:
            continue
        if m.parent_id is None:
            err("no_parent", f"'{m.name}' üyesi bir üyeye bağlı olmalı.", m.id)
            continue
        parent = by_id.get(m.parent_id)
        if parent is None:
            err("missing_parent", f"'{m.name}' üyesinin bağlı olduğu üye bulunamadı: {m.parent_id}", m.id)
            continue
        if m.parent_id == m.id:
            err("self_parent", f"'{m.name}' kendisine bağlanamaz.", m.id)
            continue
        if parent.role in (TeamRole.advisor, TeamRole.tester):
            target = "bir danışmana" if parent.role == TeamRole.advisor else "bir test ajanına"
            err(
                "bad_parent",
                f"'{m.name}' {target} bağlanamaz; yalnız lidere veya bir geliştiriciye bağlanabilir.",
                m.id,
            )

    if errors:
        return TeamValidationReport(ok=False, errors=errors, warnings=warnings)

    depths = member_depths(spec)
    for m in spec.members:
        if m.role == TeamRole.worker and m.id not in depths:
            err("not_in_tree", f"'{m.name}' liderin altındaki ağaca bağlı değil (döngü olabilir).", m.id)
        elif m.role == TeamRole.worker and depths[m.id] > s.max_depth:
            err(
                "too_deep",
                f"'{m.name}' çok derinde: {depths[m.id]}. seviye (en fazla {s.max_depth}).",
                m.id,
            )

    advised: dict[str, str] = {}
    for m in spec.members:
        if m.role == TeamRole.advisor:
            assert m.parent_id is not None
            parent = by_id[m.parent_id]
            has_subs = any(c.role == TeamRole.worker for c in children.get(parent.id, []))
            if parent.role != TeamRole.lead and not has_subs:
                err(
                    "advisor_target",
                    f"Danışman '{m.name}' yalnız lidere veya altında üye olan bir üyeye bağlanabilir.",
                    m.id,
                )
            if m.writes:
                err("advisor_writes", f"Danışman '{m.name}' kod yazamaz; yazma izni kapalı olmalı.", m.id)
            if parent.id in advised:
                err(
                    "multiple_advisors",
                    f"'{parent.name}' üyesine birden fazla danışman bağlanmış; en fazla bir danışman olabilir.",
                    m.id,
                )
            advised[parent.id] = m.id
            if children.get(m.id):
                err("advisor_children", f"Danışman '{m.name}' altında üye olamaz.", m.id)
        elif m.role == TeamRole.tester:
            assert m.parent_id is not None
            if children.get(m.id):
                err("tester_children", f"Test ajanı '{m.name}' altında üye olamaz.", m.id)
            if m.parent_id not in depths:
                err("tester_parent", f"Test ajanı '{m.name}' ekip ağacındaki bir üyeye bağlanmalı.", m.id)
                continue
            if m.test_mode == TestMode.dependent:
                target = by_id.get(m.tests_member_id) if m.tests_member_id else None
                if target is None:
                    err(
                        "tester_target",
                        f"Bağımlı test ajanı '{m.name}' için test edeceği üye seçilmeli.",
                        m.id,
                    )
                elif target.role not in (TeamRole.worker, TeamRole.lead) or target.id not in depths:
                    err(
                        "tester_target",
                        f"Bağımlı test ajanı '{m.name}' yalnız bir geliştiriciyi veya lideri test edebilir.",
                        m.id,
                    )
                elif target.id not in subtree(spec, m.parent_id):
                    err(
                        "tester_scope",
                        f"Test ajanı '{m.name}', bağlı olduğu üyenin alt ağacı dışındaki '{target.name}' üyesini "
                        "test edemez.",
                        m.id,
                    )
            elif m.tests_member_id and m.tests_member_id not in subtree(spec, m.parent_id):
                err(
                    "tester_scope",
                    f"Bağımsız test ajanı '{m.name}' yalnız bağlı olduğu üyenin alt ağacını test edebilir.",
                    m.id,
                )

    if lead is not None and not spec.subordinates(lead.id):
        warn("lone_lead", "Liderin altında üye yok; lider işi tek başına yapacak.", lead.id)
    workers = sum(1 for m in spec.members if m.role == TeamRole.worker)
    if workers > s.max_assignments:
        warn("few_assignments", "Üye sayısı en fazla iş sayısından büyük; bazı üyelere iş verilemeyebilir.")
    return TeamValidationReport(ok=not errors, errors=errors, warnings=warnings)


def first_error(report: TeamValidationReport) -> str:
    return report.errors[0].message if report.errors else ""
