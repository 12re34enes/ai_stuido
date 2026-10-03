"""Built-in team templates (stable ids, Turkish names). Read-only; users save copies to change them.

Providers are mixed on purpose: Claude leads (planning, integration), Codex reviews/tests, so the
work is seen by both models. Efforts follow the role: lead high, workers medium, testers low.
"""

from __future__ import annotations

from aistudio.contracts.teams import (
    ReportMode,
    Team,
    TeamMember,
    TeamPosition,
    TeamRole,
    TeamSettings,
    TeamSpec,
    TestMode,
)

DEFAULT_TEAM_ID = "hizli-ekip"

LEAD_INSTRUCTIONS = (
    "Görevi anla, uygulanabilir parçalara böl ve her parçayı en uygun üyeye ver. Üyelerin sonuçlarını kontrol et, "
    "çakışmaları çöz ve işi tutarlı bir bütün olarak bitir."
)
DEV_INSTRUCTIONS = "Sana verilen işi temiz, test edilebilir kodla yap; kapsam dışına çıkma."
SUB_INSTRUCTIONS = "Yöneticinin verdiği küçük ve net işi yap; bitirince kısa bir özet ver."


def _m(
    member_id: str,
    name: str,
    role: TeamRole,
    *,
    parent: str | None,
    provider: str = "claude",
    effort: str | None = None,
    instructions: str = "",
    x: float = 0,
    y: float = 0,
    **kw: object,
) -> TeamMember:
    return TeamMember.model_validate(
        {
            "id": member_id,
            "name": name,
            "role": role,
            "parent_id": parent,
            "provider": provider,
            "effort": effort,
            "instructions": instructions,
            "position": TeamPosition(x=x, y=y),
            **kw,
        }
    )


def _danismanli() -> TeamSpec:
    return TeamSpec(
        members=[
            _m(
                "advisor",
                "Danışman",
                TeamRole.advisor,
                parent="lead",
                provider="codex",
                effort="high",
                writes=False,
                instructions="Mimari, risk ve kalite açısından lideri yönlendir; kod yazma.",
                x=-260,
                y=0,
            ),
            _m("lead", "Lider", TeamRole.lead, parent=None, effort="high", instructions=LEAD_INSTRUCTIONS, x=0, y=0),
            _m(
                "dev-1",
                "Geliştirici 1",
                TeamRole.worker,
                parent="lead",
                effort="medium",
                instructions=DEV_INSTRUCTIONS,
                x=-260,
                y=180,
            ),
            _m(
                "dev-2",
                "Geliştirici 2",
                TeamRole.worker,
                parent="lead",
                provider="codex",
                effort="medium",
                instructions=DEV_INSTRUCTIONS,
                x=0,
                y=180,
            ),
            _m(
                "dev-3",
                "Geliştirici 3",
                TeamRole.worker,
                parent="lead",
                effort="medium",
                instructions=DEV_INSTRUCTIONS,
                x=260,
                y=180,
            ),
        ],
        settings=TeamSettings(report_mode=ReportMode.each_assignment, max_parallel_members=3),
    )


def _derin() -> TeamSpec:
    members = [_m("lead", "Lider", TeamRole.lead, parent=None, effort="high", instructions=LEAD_INSTRUCTIONS, x=0)]
    providers = ("claude", "codex", "claude")
    for i, provider in enumerate(providers, start=1):
        x = (i - 2) * 360.0
        members.append(
            _m(
                f"dev-{i}",
                f"Geliştirici {i}",
                TeamRole.worker,
                parent="lead",
                provider=provider,
                effort="medium",
                instructions=DEV_INSTRUCTIONS + " İşi gerekirse alt ajanlarına böl ve sonuçlarını birleştir.",
                x=x,
                y=180,
            )
        )
        for j, suffix in enumerate(("a", "b")):
            members.append(
                _m(
                    f"dev-{i}-{suffix}",
                    f"Alt ajan {i}{suffix.upper()}",
                    TeamRole.worker,
                    parent=f"dev-{i}",
                    provider="codex" if provider == "claude" else "claude",
                    effort="low",
                    instructions=SUB_INSTRUCTIONS,
                    x=x - 90 + 180 * j,
                    y=360,
                )
            )
    return TeamSpec(members=members, settings=TeamSettings(max_parallel_members=4, max_depth=2))


def _arayuz_test() -> TeamSpec:
    return TeamSpec(
        members=[
            _m("lead", "Lider", TeamRole.lead, parent=None, effort="high", instructions=LEAD_INSTRUCTIONS, x=0),
            _m(
                "ui",
                "Arayüz geliştirici",
                TeamRole.worker,
                parent="lead",
                effort="medium",
                instructions="Arayüz bileşenlerini, durumları ve erişilebilirliği uygula.",
                x=-220,
                y=180,
            ),
            _m(
                "api",
                "API geliştirici",
                TeamRole.worker,
                parent="lead",
                provider="codex",
                effort="medium",
                instructions="API uç noktalarını, doğrulamayı ve hata durumlarını uygula.",
                x=220,
                y=180,
            ),
            _m(
                "e2e",
                "E2E test ajanı",
                TeamRole.tester,
                parent="ui",
                provider="codex",
                effort="low",
                writes=False,
                test_mode=TestMode.dependent,
                tests_member_id="ui",
                instructions="Arayüz değişikliklerini kullanıcı akışları üzerinden uçtan uca test et.",
                x=-220,
                y=360,
            ),
            _m(
                "qa",
                "Kalite kontrol",
                TeamRole.tester,
                parent="lead",
                provider="codex",
                effort="low",
                writes=False,
                test_mode=TestMode.independent,
                instructions="Birleştirilmiş çalışmayı bütün olarak test et; arayüz ile API uyumuna dikkat et.",
                x=440,
                y=0,
            ),
        ],
        settings=TeamSettings(max_parallel_members=3, independent_tests_trigger="at_end"),
    )


def _hizli() -> TeamSpec:
    return TeamSpec(
        members=[
            _m("lead", "Lider", TeamRole.lead, parent=None, effort="high", instructions=LEAD_INSTRUCTIONS, x=0),
            _m(
                "dev",
                "Geliştirici",
                TeamRole.worker,
                parent="lead",
                provider="codex",
                effort="medium",
                instructions=DEV_INSTRUCTIONS,
                x=0,
                y=180,
            ),
            _m(
                "test",
                "Test ajanı",
                TeamRole.tester,
                parent="dev",
                effort="low",
                writes=False,
                test_mode=TestMode.dependent,
                tests_member_id="dev",
                instructions="Geliştiricinin her işini çalıştırarak doğrula; hataları önem derecesiyle bildir.",
                x=0,
                y=360,
            ),
        ],
        settings=TeamSettings(max_parallel_members=2, test_max_rounds=2),
    )


def builtin_teams() -> list[Team]:
    return [
        Team(
            id="danismanli-ekip",
            name="Danışmanlı ekip",
            description=(
                "Bir danışman lideri yönlendirir; lider işi üç geliştiriciye böler ve sonuçları birleştirir. "
                "Danışman her iş bitince rapor alır."
            ),
            builtin=True,
            spec=_danismanli(),
        ),
        Team(
            id="derin-ekip",
            name="Derin ekip",
            description=(
                "Lider ve üç geliştirici; her geliştiricinin iki alt ajanı var. Büyük işleri iki seviyede "
                "paralel böler."
            ),
            builtin=True,
            spec=_derin(),
        ),
        Team(
            id="arayuz-test-ekibi",
            name="Arayüz ve test ekibi",
            description=(
                "Lider, arayüz ve API geliştiricileri. E2E test ajanı arayüzün her işini test eder; kalite "
                "kontrol ajanı en sonda bütünü test eder."
            ),
            builtin=True,
            spec=_arayuz_test(),
        ),
        Team(
            id="hizli-ekip",
            name="Hızlı ekip",
            description="Lider ve bir geliştirici; test ajanı geliştiricinin her işini doğrular. Küçük işler için.",
            builtin=True,
            spec=_hizli(),
        ),
    ]


def builtin_team(team_id: str) -> Team | None:
    for t in builtin_teams():
        if t.id == team_id:
            return t
    return None
