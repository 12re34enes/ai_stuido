"""Turkish prompts and summaries exchanged with team members."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from aistudio.contracts.teams import TeamMember, TeamRole, TeamSpec, TestMode
from aistudio.core.text import truncate
from aistudio.engine.structured import format_instructions
from aistudio.engine.team.models import InboxItem, TeamAssignment, TeamTestVerdict
from aistudio.engine.team.validation import advisor_in_chain
from aistudio.engine.templates import format_findings

PROVIDER_LABEL: dict[str, str] = {"claude": "Claude", "codex": "Codex"}
STATUS_TR: dict[str, str] = {
    "pending": "bekliyor",
    "blocked": "engellendi",
    "running": "çalışıyor",
    "testing": "test ediliyor",
    "completed": "tamamlandı",
    "failed": "başarısız",
    "cancelled": "iptal edildi",
}
VERDICT_TR: dict[str, str] = {"passed": "geçti", "failed": "başarısız", "error": "okunamadı"}
NO_ADVICE = "Öneri yok."


def member_tag(m: TeamMember, *, provider: str | None = None, model: str | None = None) -> str:
    parts = [PROVIDER_LABEL.get(provider or m.provider, provider or m.provider)]
    if model or m.model:
        parts.append(str(model or m.model))
    if m.effort:
        parts.append(f"effort {m.effort}")
    return " · ".join(parts)


def roster(spec: TeamSpec, member_id: str) -> str:
    """Direct subordinates (who to delegate to) and the testers/advisor around them."""
    subs = spec.subordinates(member_id)
    if not subs:
        return ""
    lines = ["## Ekibin (doğrudan bağlı üyelerin)"]
    for s in subs:
        line = f"- `{s.id}` — {s.name} ({member_tag(s)})"
        if not s.writes:
            line += " · salt okuma"
        lines.append(line)
        if s.instructions.strip():
            lines.append(f"  Görevi: {truncate(s.instructions.strip(), 600)}")
        below = spec.subordinates(s.id)
        if below:
            lines.append(f"  Altında {len(below)} üye var; işi onlara da bölebilir.")
        for t in spec.testers_of(s.id):
            lines.append(f"  Her işinden sonra `{t.name}` çıktısını test eder; başarısızlık ona düzeltme olarak döner.")
    for t in spec.members:
        if t.role == TeamRole.tester and t.test_mode == TestMode.independent and t.parent_id == member_id:
            when = (
                "her birleştirmeden sonra"
                if spec.settings.independent_tests_trigger == "after_each_merge"
                else "sen bitirmeden önce"
            )
            lines.append(f"- Bağımsız test: `{t.name}` birleştirilmiş çalışmanı {when} test eder.")
    return "\n".join(lines)


def team_rules(spec: TeamSpec, member: TeamMember, tool_names: Iterable[str]) -> str:
    tools = set(tool_names)
    lines = [
        "## Ekip kuralları",
        f"Bir AI Studio ekibinde **{member.name}** olarak çalışıyorsun "
        f"({'lider' if member.role == TeamRole.lead else 'üye'}).",
    ]
    if member.instructions.strip():
        lines.append(f"Rolün: {member.instructions.strip()}")
    if "team_delegate" in tools:
        lines += [
            "- İşi doğrudan bağlı üyelerine `team_delegate` ile böl: her iş için kısa bir başlık ve ayrıntılı, kendi "
            "başına anlaşılır talimat yaz. Bir iş başka bir işin sonucuna ihtiyaç duyuyorsa `depends_on` ile belirt.",
            "- Sonuçları `team_wait` ile bekle. Üyelerin değişiklikleri senin branch'ine otomatik birleştirilir; "
            "çakışma olursa sonuçta çakışan dosyalarla bildirilir ve çözmek sana kalır.",
            "- Kendi yapman daha kısa sürecek küçük işleri devretme.",
        ]
    else:
        lines.append("- Sana verilen işi kendi çalışma dizininde yap; başka üyelere iş veremezsin.")
    if "team_consult" in tools:
        lines.append(
            "- Takıldığında veya önemli bir karar verirken `team_consult` ile danışmana sor; ilerlemeyi "
            "`team_report` ile bildirebilirsin."
        )
    if "team_finish" in tools:
        lines.append("- İş tamamen bitince `team_finish` ile yaptıklarını kısa ve somut biçimde özetle.")
    lines.append(
        "- Testleri ve build'i studio ayrıca çalıştırır; senin 'testler geçti' demen kanıt sayılmaz. Değişiklikleri "
        "commit etmen gerekmez, studio commit eder."
    )
    team_roster = roster(spec, member.id)
    if team_roster:
        lines += ["", team_roster]
    return "\n".join(lines)


def lead_message(prompt: str, spec: TeamSpec, lead: TeamMember) -> str:
    parts = [prompt.strip()]
    team_roster = roster(spec, lead.id)
    if team_roster:
        parts.append(team_roster)
        parts.append(
            "Görevi ekibinle yürüt: işleri `team_delegate` ile dağıt, `team_wait` ile sonuçları bekle, gerekirse "
            "düzeltme işleri ver ve en sonda `team_finish` ile özetle."
        )
    else:
        parts.append("Bu görevi kendin yap ve bitince `team_finish` ile özetle.")
    return "\n\n".join(p for p in parts if p)


def assignment_message(
    a: TeamAssignment,
    *,
    from_name: str,
    deps: Sequence[TeamAssignment],
    spec: TeamSpec,
    member: TeamMember,
    note: str | None = None,
) -> str:
    parts = [f"## Yeni iş: {a.title}\nİş kimliği: `{a.id}` · Veren: {from_name}", a.instructions.strip()]
    if deps:
        lines = ["## Bağımlı olduğun işlerin sonuçları"]
        for d in deps:
            status = STATUS_TR.get(d.status, d.status)
            lines.append(f"- **{d.title}** ({status}): {truncate(d.result_summary or '', 1500)}")
        parts.append("\n".join(lines))
    if note:
        parts.append(f"## Not\n{note}")
    team_roster = roster(spec, member.id)
    if team_roster:
        parts.append(team_roster)
    parts.append("Bitince `team_finish` ile yaptıklarını özetle.")
    return "\n\n".join(p for p in parts if p)


def merge_line(a: TeamAssignment) -> str:
    if a.merge is None:
        return ""
    if a.merge.status == "clean":
        return "Birleştirme: temiz (branch'ine eklendi)."
    if a.merge.status == "skipped":
        return "Birleştirme: değişiklik yok."
    files = ", ".join(f"`{p}`" for p in a.merge.conflicts[:20]) or "ayrıntı yok"
    return f"Birleştirme: ÇAKIŞMA — çakışan dosyalar: {files}. Bu iş branch'ine birleştirilmedi; çözmek sana kalır."


def verdict_line(v: TeamTestVerdict) -> str:
    kind = "bağımlı" if v.mode == "dependent" else "bağımsız"
    text = f"- {v.tester} ({kind}, tur {v.round}): {VERDICT_TR.get(v.status, v.status)}"
    if v.summary:
        text += f" — {truncate(v.summary, 400)}"
    return text


def format_results(results: Sequence[TeamAssignment], names: dict[str, str]) -> str:
    blocks: list[str] = []
    for a in results:
        lines = [
            f"### {a.title} — {names.get(a.to_member, a.to_member)} ({STATUS_TR.get(a.status, a.status)})",
            f"İş kimliği: `{a.id}`",
        ]
        if a.result_summary:
            lines.append(f"Özet: {truncate(a.result_summary, 3000)}")
        if a.error:
            lines.append(f"Hata: {a.error}")
        merge = merge_line(a)
        if merge:
            lines.append(merge)
        if a.tests:
            lines.append("Testler:")
            lines += [verdict_line(v) for v in a.tests]
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def inbox_text(items: Sequence[InboxItem]) -> str:
    titles = {
        "advice": "Danışmanın önerisi",
        "test": "Test sonucu",
        "user": "Kullanıcıdan mesaj",
        "note": "Not",
    }
    return "\n\n".join(f"## {titles[i.kind]}\n{i.text.strip()}" for i in items if i.text.strip())


def delivery_message(results: Sequence[TeamAssignment], items: Sequence[InboxItem], names: dict[str, str]) -> str:
    parts: list[str] = []
    if results:
        parts.append("## Ekipten sonuçlar\n" + format_results(results, names))
    extra = inbox_text(items)
    if extra:
        parts.append(extra)
    parts.append(
        "Sonuçları değerlendir: gerekiyorsa yeni işler ver veya düzelt; iş tamamen bittiyse `team_finish` ile özetle."
    )
    return "\n\n".join(parts)


def fix_message(verdicts: Sequence[TeamTestVerdict], round_no: int, max_rounds: int) -> str:
    lines = [f"## Testler başarısız (düzeltme turu {round_no}/{max_rounds})"]
    for v in verdicts:
        lines.append(f"### {v.tester}\n{truncate(v.summary, 1500)}")
        found = format_findings(v.findings)
        if found:
            lines.append(found)
    lines.append("Bu sorunları düzelt; bitince `team_finish` ile ne değiştirdiğini özetle.")
    return "\n\n".join(lines)


def tester_prompt(
    tester: TeamMember,
    *,
    mode: str,
    subject_name: str,
    title: str,
    instructions: str,
    summary: str,
    changed_files: Sequence[str],
) -> str:
    if mode == "dependent":
        intro = f"`{subject_name}` üyesinin aşağıdaki işini test et. Çalışma dizini bu üyenin worktree'si."
    else:
        intro = (
            f"`{subject_name}` üyesinin birleştirilmiş çalışmasını bütün olarak test et. Çalışma dizini bu üyenin "
            "worktree'si."
        )
    parts = [intro, f"## İş\n{title}\n{instructions.strip()}"]
    if summary.strip():
        parts.append(f"## Üyenin özeti\n{truncate(summary, 3000)}")
    if changed_files:
        shown = "\n".join(f"- {p}" for p in changed_files[:80])
        parts.append(f"## Değişen dosyalar\n{shown}")
    if tester.test_command:
        parts.append(f"## Çalıştırman gereken komut\n`{tester.test_command}`")
    if tester.instructions.strip():
        parts.append(f"## Test odağın\n{tester.instructions.strip()}")
    if not tester.writes:
        parts.append("Dosya değiştirme; yalnız test et ve raporla.")
    parts.append(
        'İş doğru çalışıyorsa "verdict": "pass" ver. Hataları önem derecesiyle bildir; critical ve high bulgular '
        "işi düzeltme için geri gönderir."
    )
    return "\n\n".join(parts) + format_instructions("findings")


def report_prompt(*, kind: str, about: str, body: str, reports: Sequence[str] = ()) -> str:
    title = {"assignment": "İş tamamlandı", "periodic": "Dönemsel ilerleme raporu", "member": "Üyeden rapor"}.get(
        kind, "Rapor"
    )
    parts = [f"## {title}: {about}", body.strip()]
    if reports:
        parts.append("## Üyelerin raporları\n" + "\n".join(f"- {truncate(r, 800)}" for r in reports))
    parts.append(f"Kısa ve uygulanabilir bir öneri ver. Önerin yoksa yalnız '{NO_ADVICE}' yaz.")
    return "\n\n".join(p for p in parts if p)


def consult_prompt(*, caller: TeamMember, question: str, reports: Sequence[str] = ()) -> str:
    parts = [f"## Danışma sorusu — {caller.name}", question.strip()]
    if reports:
        parts.append("## Son raporlar\n" + "\n".join(f"- {truncate(r, 800)}" for r in reports))
    parts.append("Kısa, net ve uygulanabilir yanıt ver.")
    return "\n\n".join(parts)


def advisor_system(spec: TeamSpec, advisor: TeamMember) -> str:
    target = spec.member(advisor.parent_id) if advisor.parent_id else None
    lines = [
        "## Ekip danışmanlığı",
        f"Bir AI Studio ekibinin danışmanısın ({advisor.name}). Kod yazmaz, dosya değiştirmezsin.",
    ]
    if target is not None:
        lines.append(
            f"'{target.name}' üyesine ve onun ekibine danışmanlık ediyorsun. Raporları değerlendir, sorulara kısa ve "
            "uygulanabilir yanıt ver."
        )
    if advisor.instructions.strip():
        lines.append(f"Odağın: {advisor.instructions.strip()}")
    return "\n".join(lines)


def tester_system(tester: TeamMember) -> str:
    lines = [
        "## Ekip test ajanı",
        f"Bir AI Studio ekibinin test ajanısın ({tester.name}). Sana verilen işi test eder, sonucu yapılandırılmış "
        "bulgularla bildirirsin.",
    ]
    if tester.instructions.strip():
        lines.append(f"Odağın: {tester.instructions.strip()}")
    return "\n".join(lines)


def has_advisor(spec: TeamSpec, member_id: str) -> bool:
    return advisor_in_chain(spec, member_id) is not None
