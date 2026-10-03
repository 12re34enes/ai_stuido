"""Team validation, built-in templates, the team catalog and team mode graphs."""

from __future__ import annotations

from typing import Any

import pytest
from engine_support import EngineEnv
from team_support import member, spec, team_graph

from aistudio.contracts.flows import FlowGraph, FlowMode, FlowNode, TeamNodeConfig
from aistudio.contracts.teams import TeamRole, TeamSpec
from aistudio.core.errors import Conflict, NotFound, ValidationFailed
from aistudio.engine.modes import build_mode_graph
from aistudio.engine.team.models import TeamCreate, TeamUpdate
from aistudio.engine.team.templates import DEFAULT_TEAM_ID, builtin_teams
from aistudio.engine.team.validation import validate_team
from aistudio.engine.validation import validate_graph


def codes(team: TeamSpec) -> list[str]:
    return [e.code for e in validate_team(team).errors]


def messages(team: TeamSpec) -> str:
    return " | ".join(e.message for e in validate_team(team).errors)


LEAD = member("lead", "Lider", "lead")


# --------------------------------------------------------------------------- built-ins


def test_builtin_templates_are_valid_and_stable() -> None:
    teams = {t.id: t for t in builtin_teams()}
    assert list(teams) == ["danismanli-ekip", "derin-ekip", "arayuz-test-ekibi", "hizli-ekip"]
    assert DEFAULT_TEAM_ID in teams
    for t in teams.values():
        report = validate_team(t.spec)
        assert report.ok, (t.id, report.errors)
        assert t.builtin and t.name and t.description and t.name[0].isupper()
        assert t.spec.lead().provider == "claude" and t.spec.lead().effort == "high"
        assert {m.provider for m in t.spec.members} == {"claude", "codex"}  # providers are mixed
        assert all(m.position is not None for m in t.spec.members)

    advised = teams["danismanli-ekip"].spec
    assert [m.role for m in advised.members].count(TeamRole.worker) == 3
    advisor = next(m for m in advised.members if m.role == TeamRole.advisor)
    assert advisor.parent_id == "lead" and not advisor.writes

    deep = teams["derin-ekip"].spec
    assert len(deep.subordinates("lead")) == 3
    assert all(len(deep.subordinates(d.id)) == 2 for d in deep.subordinates("lead"))

    ui = teams["arayuz-test-ekibi"].spec
    assert [t.name for t in ui.testers_of("ui")] == ["E2E test ajanı"]
    qa = ui.member("qa")
    assert qa.test_mode == "independent" and qa.parent_id == "lead"

    fast = teams["hizli-ekip"].spec
    assert [m.role.value for m in fast.members] == ["lead", "worker", "tester"]
    assert fast.testers_of("dev")[0].effort == "low"


# --------------------------------------------------------------------------- validation


def test_lead_rules() -> None:
    assert codes(spec()) == ["empty"]
    assert codes(spec(member("dev", "Dev", "worker", "lead"))) == ["no_lead", "missing_parent"]
    assert "Ekipte bir lider olmalı." in messages(spec(member("dev", "Dev", "worker", "lead")))
    assert codes(spec(member("a", "A", "advisor", None, writes=False))) == ["no_lead", "no_parent"]
    two = spec(LEAD, member("lead2", "İkinci", "lead"))
    assert codes(two) == ["multiple_leads"]
    assert "yalnız bir lider" in messages(two)
    assert codes(spec(member("lead", "Lider", "lead", "lead"))) == ["lead_parent"]


def test_ids_names_and_efforts() -> None:
    assert codes(spec(LEAD, member("lead", "Kopya", "worker", "lead"))) == ["duplicate_member"]
    assert codes(spec(LEAD, member("kötü id", "X", "worker", "lead"))) == ["bad_member_id"]
    assert codes(spec(LEAD, member("engine", "X", "worker", "lead"))) == ["bad_member_id"]
    assert codes(spec(LEAD, member("dev", " ", "worker", "lead"))) == ["empty_name"]
    bad = spec(LEAD, member("dev", "Dev", "worker", "lead", provider="codex", effort="max"))
    assert codes(bad) == ["bad_effort"]
    assert "Geçerli değerler: none, minimal, low, medium, high, xhigh" in messages(bad)
    assert validate_team(spec(LEAD, member("dev", "Dev", "worker", "lead", effort="xhigh"))).ok
    # with a profile the effort is the profile's business
    assert validate_team(spec(LEAD, member("dev", "Dev", "worker", "lead", effort="?", profile_id="p"))).ok


def test_tree_rules() -> None:
    cycle = spec(LEAD, member("a", "A", "worker", "b"), member("b", "B", "worker", "a"))
    assert sorted(codes(cycle)) == ["not_in_tree", "not_in_tree"]
    deep = spec(LEAD, member("a", "A", "worker", "lead"), member("a1", "A1", "worker", "a"), max_depth=1)
    assert codes(deep) == ["too_deep"] and "en fazla 1" in messages(deep)
    under_tester = spec(
        LEAD,
        member("dev", "Dev", "worker", "lead"),
        member("qa", "QA", "tester", "dev", writes=False, tests_member_id="dev"),
        member("x", "X", "worker", "qa"),
    )
    assert "bad_parent" in codes(under_tester) and "test ajanına bağlanamaz" in messages(under_tester)
    orphan = spec(LEAD, member("dev", "Dev", "worker"))
    assert codes(orphan) == ["no_parent"]
    lone = validate_team(spec(LEAD))
    assert lone.ok and [w.code for w in lone.warnings] == ["lone_lead"]


def test_advisor_rules() -> None:
    writes = spec(member("adv", "Danışman", "advisor", "lead", writes=True), LEAD)
    assert codes(writes) == ["advisor_writes"] and "kod yazamaz" in messages(writes)
    leaf = spec(LEAD, member("dev", "Dev", "worker", "lead"), member("adv", "D", "advisor", "dev", writes=False))
    assert codes(leaf) == ["advisor_target"]
    manager = spec(
        LEAD,
        member("dev", "Dev", "worker", "lead"),
        member("sub", "Alt", "worker", "dev"),
        member("adv", "D", "advisor", "dev", writes=False),
    )
    assert validate_team(manager).ok
    two = spec(
        LEAD, member("a1", "D1", "advisor", "lead", writes=False), member("a2", "D2", "advisor", "lead", writes=False)
    )
    assert codes(two) == ["multiple_advisors"]
    children = spec(LEAD, member("adv", "D", "advisor", "lead", writes=False), member("x", "X", "worker", "adv"))
    assert "bad_parent" in codes(children) and "danışmana bağlanamaz" in messages(children)


def test_tester_rules() -> None:
    no_target = spec(LEAD, member("dev", "Dev", "worker", "lead"), member("qa", "QA", "tester", "dev", writes=False))
    assert codes(no_target) == ["tester_target"] and "test edeceği üye seçilmeli" in messages(no_target)
    tests_advisor = spec(
        LEAD,
        member("adv", "D", "advisor", "lead", writes=False),
        member("qa", "QA", "tester", "lead", writes=False, tests_member_id="adv"),
    )
    assert codes(tests_advisor) == ["tester_target"]
    out_of_scope = spec(
        LEAD,
        member("a", "A", "worker", "lead"),
        member("b", "B", "worker", "lead"),
        member("qa", "QA", "tester", "a", writes=False, tests_member_id="b"),
    )
    assert codes(out_of_scope) == ["tester_scope"]
    independent_scope = spec(
        LEAD,
        member("a", "A", "worker", "lead"),
        member("b", "B", "worker", "lead"),
        member("qa", "QA", "tester", "a", writes=False, test_mode="independent", tests_member_id="b"),
    )
    assert codes(independent_scope) == ["tester_scope"]
    assert "alt ağacını" in messages(independent_scope)
    ok_team = spec(
        LEAD,
        member("a", "A", "worker", "lead"),
        member("qa", "QA", "tester", "lead", writes=False, tests_member_id="a"),
        member("lead-qa", "Lider testi", "tester", "lead", writes=False, tests_member_id="lead"),
        member("all", "Bütün", "tester", "lead", writes=False, test_mode="independent"),
    )
    assert validate_team(ok_team).ok


@pytest.mark.parametrize(
    ("settings", "fragment"),
    [
        ({"max_parallel_members": 0}, "en az 1 olmalı"),
        ({"max_depth": 0}, "1 ile 8 arasında"),
        ({"max_assignments": 0}, "En fazla iş sayısı"),
        ({"test_max_rounds": -1}, "negatif olamaz"),
        ({"report_interval_minutes": 0}, "en az 1 dakika"),
    ],
)
def test_settings_rules(settings: dict[str, Any], fragment: str) -> None:
    team = spec(LEAD, **settings)
    assert "bad_setting" in codes(team) and fragment in messages(team)


# --------------------------------------------------------------------------- graphs & tasks


async def test_team_mode_graph_and_flow_validation() -> None:
    graph = build_mode_graph(FlowMode.team)
    assert [n.id for n in graph.nodes] == ["team", "boundary", "build", "review", "final"]
    cfg = graph.node("team").config
    assert isinstance(cfg, TeamNodeConfig) and cfg.team is None and cfg.team_id is None
    assert (await validate_graph(graph)).ok  # gates find the team as their writer
    roundtrip = FlowGraph.model_validate(graph.model_dump(mode="json"))
    assert isinstance(roundtrip.node("team").config, TeamNodeConfig)

    bad = spec(LEAD, member("lead2", "İki", "lead"))
    report = await validate_graph(team_graph(bad))
    assert [e.code for e in report.errors] == ["team_invalid"]
    assert "Ekip geçersiz" in report.errors[0].message

    async def resolve(team_id: str) -> TeamSpec | None:
        return None

    unknown = FlowGraph(nodes=[FlowNode(id="team", label="Ekip", config=TeamNodeConfig(team_id="yok"))])
    report = await validate_graph(unknown, resolve_team=resolve)
    assert [e.code for e in report.errors] == ["team_not_found"]
    broken = FlowGraph(
        nodes=[FlowNode(id="team", label="Ekip", config=TeamNodeConfig(prompt_template="{{ input.prompt "))]
    )
    assert [e.code for e in (await validate_graph(broken)).errors] == ["template"]


async def test_tasks_choose_their_team(env: EngineEnv) -> None:
    with pytest.raises(ValidationFailed, match="Ekip şablonu bulunamadı"):
        await env.create(FlowMode.team, team_id="yok", start=False)
    with pytest.raises(ValidationFailed, match="Ekip geçersiz: Ekipte yalnız bir lider"):
        await env.create(FlowMode.team, team=spec(LEAD, member("l2", "L2", "lead")), start=False)

    # a team without an explicit mode means mode=team
    from aistudio.contracts.engine import TaskCreate

    task = await env.engine.create_task(
        TaskCreate(workspace_id=env.workspace.id, title="Derin", prompt="Büyük iş", team_id="derin-ekip", start=False)
    )
    assert task.mode == FlowMode.team
    graph = await env.engine.resolve_graph(task)
    cfg = graph.node("team").config
    assert isinstance(cfg, TeamNodeConfig) and cfg.team_id == "derin-ekip"
    assert await env.engine.required_providers(graph, env.workspace.id) == {"claude", "codex"}

    inline = spec(LEAD, member("dev", "Dev", "worker", "lead", provider="codex"))
    task2 = await env.create(FlowMode.team, team=inline, start=False)
    cfg2 = (await env.engine.resolve_graph(task2)).node("team").config
    assert isinstance(cfg2, TeamNodeConfig) and cfg2.team == inline

    plain = await env.create(FlowMode.team, start=False)
    cfg3 = (await env.engine.resolve_graph(plain)).node("team").config
    assert isinstance(cfg3, TeamNodeConfig) and cfg3.team is None and cfg3.team_id is None
    await env.engine.delete_task(task2.id)
    assert await env.engine.rt.team_store.task_team(task2.id) is None


# --------------------------------------------------------------------------- catalog


async def test_team_catalog_versions(env: EngineEnv) -> None:
    catalog = env.engine.teams.catalog
    teams = await catalog.list(env.workspace.id)
    assert [t.id for t in teams][:4] == ["danismanli-ekip", "derin-ekip", "arayuz-test-ekibi", "hizli-ekip"]
    team_spec = spec(LEAD, member("dev", "Dev", "worker", "lead", provider="codex"))
    created = await catalog.create(
        TeamCreate(workspace_id=env.workspace.id, name="Benim ekibim", description="Deneme", spec=team_spec)
    )
    assert created.version == 1 and not created.builtin and created.workspace_id == env.workspace.id
    updated = await catalog.update(created.id, TeamUpdate(name="Yeni ad"))
    assert updated.version == 2 and updated.name == "Yeni ad" and updated.spec == team_spec
    assert updated.created_at == created.created_at
    assert [v.version for v in await catalog.versions(created.id)] == [1, 2]
    assert (await catalog.get(created.id, 1)).name == "Benim ekibim"
    with pytest.raises(NotFound):
        await catalog.get(created.id, 9)
    listed = await catalog.list(env.workspace.id)
    assert listed[4].id == created.id and listed[4].version == 2
    with pytest.raises(ValidationFailed, match="Ekip adı boş olamaz"):
        await catalog.update(created.id, TeamUpdate(name=" "))
    with pytest.raises(ValidationFailed) as exc:
        await catalog.update(created.id, TeamUpdate(spec=spec(member("dev", "Dev", "worker", "lead"))))
    assert exc.value.details["errors"][0]["code"] == "no_lead"
    with pytest.raises(Conflict, match="Hazır ekip şablonları değiştirilemez"):
        await catalog.update("hizli-ekip", TeamUpdate(name="x"))
    with pytest.raises(Conflict):
        await catalog.delete("hizli-ekip")
    assert [v.version for v in await catalog.versions("hizli-ekip")] == [1]
    await catalog.delete(created.id)
    with pytest.raises(NotFound):
        await catalog.get(created.id)
    types = [e.type for e in await env.events(types=["team.template.*"])]
    assert types == ["team.template.saved", "team.template.saved", "team.template.deleted"]


def test_advisors_and_testers_default_to_read_only() -> None:
    from aistudio.contracts.teams import TeamMember

    assert TeamMember(id="a", name="Danışman", role="advisor").writes is False  # type: ignore[arg-type]
    assert TeamMember.model_validate({"id": "q", "name": "Test", "role": "tester"}).writes is False
    assert TeamMember.model_validate({"id": "q", "name": "Test", "role": "tester", "writes": True}).writes is True
    assert TeamMember.model_validate({"id": "w", "name": "Geliştirici", "role": "worker"}).writes is True
