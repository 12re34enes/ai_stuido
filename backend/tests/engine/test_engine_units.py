"""Unit tests: topology, validation, mode templates, templates, structured output, boundaries, quality."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest

from aistudio.contracts.agents import AgentProfile, Boundaries
from aistudio.contracts.flows import (
    AdvisorNodeConfig,
    AgentNodeConfig,
    CompareNodeConfig,
    ConditionNodeConfig,
    FlowEdge,
    FlowGraph,
    FlowMode,
    FlowNode,
    GateKind,
    GateNodeConfig,
    HumanNodeConfig,
    NodeConfig,
    ParallelNodeConfig,
    SynthesisNodeConfig,
)
from aistudio.core.clock import utcnow
from aistudio.engine.boundaries import check_commands, check_paths, matches
from aistudio.engine.graph import Topology, auto_layout, nearest_writer
from aistudio.engine.models import GateResult, RunState
from aistudio.engine.modes import MODE_INFO, build_mode_graph
from aistudio.engine.quality import compute_quality
from aistudio.engine.structured import (
    extract_json,
    missing_sections,
    normalize_severity,
    parse_structured,
    strip_json_block,
)
from aistudio.engine.templates import TemplateFailed, check_template, evaluate, render
from aistudio.engine.validation import validate_graph


def n(node_id: str, config: NodeConfig) -> FlowNode:
    return FlowNode(id=node_id, label=node_id, config=config)


def e(src: str, dst: str, cond: str = "default") -> FlowEdge:
    return FlowEdge(id=f"{src}-{dst}-{cond}", source=src, target=dst, condition=cond)  # type: ignore[arg-type]


def agent(**kw: Any) -> AgentNodeConfig:
    return AgentNodeConfig.model_validate(kw)


def gate(kind: GateKind, **kw: Any) -> GateNodeConfig:
    return GateNodeConfig.model_validate({"gate": kind, **kw})


# --------------------------------------------------------------------------- modes & topology


@pytest.mark.parametrize("mode", [FlowMode.single, FlowMode.duo, FlowMode.race, FlowMode.pipeline, FlowMode.council])
async def test_mode_templates_are_valid(mode: FlowMode) -> None:
    graph = build_mode_graph(mode)
    report = await validate_graph(graph)
    assert report.ok, report.errors
    assert all(node.position is not None for node in graph.nodes)
    assert all(node.label and node.label[0].isupper() for node in graph.nodes)
    topo = Topology.build(graph)
    assert topo.entry is not None
    assert len({(nd.position.x, nd.position.y) for nd in graph.nodes if nd.position}) == len(graph.nodes)
    for eid in topo.back_edges:
        assert topo.edges[eid].condition == "failed"
        assert topo.nodes[topo.edges[eid].source].kind == "gate"


def test_mode_node_ids_and_wiring() -> None:
    duo = build_mode_graph(FlowMode.duo)
    assert [x.id for x in duo.nodes] == ["dev", "boundary", "build", "review", "final"]
    topo = Topology.build(duo)
    assert topo.entry == "dev"
    assert {topo.edges[x].source for x in topo.back_edges} == {"boundary", "build", "review", "final"}
    assert duo.node("review").label == "Çapraz inceleme (Codex)"
    pipeline = build_mode_graph(FlowMode.pipeline)
    assert [x.id for x in pipeline.nodes] == [
        "plan",
        "plan_gate",
        "dev",
        "review",
        "test",
        "boundary",
        "build",
        "final",
    ]
    assert Topology.build(pipeline).entry == "plan"
    race = build_mode_graph(FlowMode.race)
    assert Topology.build(race).entry == "fork"
    pos_a, pos_b = race.node("dev_a").position, race.node("dev_b").position
    assert pos_a is not None and pos_b is not None
    assert pos_a.x == pos_b.x and pos_a.y != pos_b.y  # same column, different rows
    council = build_mode_graph(FlowMode.council, primary="codex")
    assert council.node("advisor_a").label == "Danışman A (Codex)"
    assert build_mode_graph(FlowMode.custom).nodes == []
    assert MODE_INFO[FlowMode.duo].label == "İkili" and MODE_INFO[FlowMode.pipeline].label == "Hat"


def test_topology_regions_and_writers() -> None:
    graph = build_mode_graph(FlowMode.pipeline)
    topo = Topology.build(graph)
    assert topo.between("dev", "build") == {"dev", "review", "test", "boundary", "build"}
    assert nearest_writer(topo, "review") == "dev"
    assert nearest_writer(topo, "build") == "test"
    assert topo.sinks() == ["final"]
    layout = auto_layout(graph)
    xs = [nd.position.x for nd in layout.nodes if nd.position]
    assert xs == sorted(xs)


# --------------------------------------------------------------------------- validation


async def test_validation_errors() -> None:
    async def codes(graph: FlowGraph, **kw: Any) -> set[str]:
        return {i.code for i in (await validate_graph(graph, **kw)).errors}

    assert await codes(FlowGraph()) == {"empty"}
    two_entries = FlowGraph(nodes=[n("a", agent()), n("b", agent())])
    assert await codes(two_entries) == {"multiple_entries"}
    cycle = FlowGraph(nodes=[n("a", agent()), n("b", agent())], edges=[e("a", "b"), e("b", "a")])
    assert "no_entry" in await codes(cycle)
    default_loop = FlowGraph(
        nodes=[n("s", agent()), n("a", agent()), n("b", agent())], edges=[e("s", "a"), e("a", "b"), e("b", "a")]
    )
    assert "bad_cycle" in await codes(default_loop)
    agent_loop = FlowGraph(
        nodes=[n("a", agent()), n("b", agent(writes=False))], edges=[e("a", "b"), e("b", "a", "failed")]
    )
    assert "loop_without_limit" in await codes(agent_loop)
    bad_ids = FlowGraph(nodes=[n("bad-id", agent())])
    assert "bad_node_id" in await codes(bad_ids)
    dangling = FlowGraph(nodes=[n("a", agent())], edges=[e("a", "ghost")])
    assert "dangling_edge" in await codes(dangling)
    template = FlowGraph(nodes=[n("a", agent(prompt_template="{{ input.prompt "))])
    assert "template" in await codes(template)
    cond_from_agent = FlowGraph(nodes=[n("a", agent()), n("b", agent())], edges=[e("a", "b", "true")])
    assert "bad_condition" in await codes(cond_from_agent)
    custom = FlowGraph(nodes=[n("a", agent()), n("c", gate(GateKind.custom_command))], edges=[e("a", "c")])
    assert "missing_command" in await codes(custom)
    no_author = FlowGraph(nodes=[n("r", gate(GateKind.cross_review))])
    assert "no_author" in await codes(no_author)
    synth = FlowGraph(nodes=[n("s", SynthesisNodeConfig())])
    assert "no_opinions" in await codes(synth)
    compare = FlowGraph(nodes=[n("c", CompareNodeConfig())])
    assert "no_candidates" in await codes(compare)
    human = FlowGraph(nodes=[n("h", HumanNodeConfig(instructions=" "))])
    assert "missing_instructions" in await codes(human)
    unreachable = FlowGraph(
        nodes=[n("a", agent()), n("b", gate(GateKind.build_test)), n("c", agent())],
        edges=[e("a", "b"), e("c", "b", "failed"), e("b", "c", "failed")],
    )
    assert "unreachable" not in await codes(unreachable)
    expr = FlowGraph(nodes=[n("a", agent()), n("c", ConditionNodeConfig(expression="1 +"))], edges=[e("a", "c")])
    assert "expression" in await codes(expr)


async def test_validation_cross_review_provider_rule_with_profiles() -> None:
    profiles = {
        "author": AgentProfile(id="author", name="A", provider="claude"),
        "rev-claude": AgentProfile(id="rev-claude", name="R", provider="claude"),
        "rev-codex": AgentProfile(id="rev-codex", name="R2", provider="codex"),
    }

    async def resolve(pid: str) -> AgentProfile | None:
        return profiles.get(pid)

    def graph(reviewer: str) -> FlowGraph:
        return FlowGraph(
            nodes=[
                n("dev", agent(profile_id="author")),
                n("rev", gate(GateKind.cross_review, reviewer_profile_id=reviewer)),
            ],
            edges=[e("dev", "rev")],
        )

    bad = await validate_graph(graph("rev-claude"), resolve_profile=resolve)
    assert not bad.ok and bad.errors[0].code == "cross_review_provider"
    assert "aynı sağlayıcıda olamaz" in bad.errors[0].message
    assert (await validate_graph(graph("rev-codex"), resolve_profile=resolve)).ok


async def test_validation_warnings() -> None:
    graph = FlowGraph(
        nodes=[
            n("fork", ParallelNodeConfig()),
            n("a", agent()),
            n("cmp", CompareNodeConfig()),
            n("adv", AdvisorNodeConfig()),
        ],
        edges=[e("fork", "a"), e("a", "cmp"), e("fork", "adv")],
    )
    report = await validate_graph(graph)
    assert report.ok
    assert "one_candidate" in {w.code for w in report.warnings}


# --------------------------------------------------------------------------- templates


def test_templates_render_variables_and_missing_values() -> None:
    variables = {
        "input": {"prompt": "Görev", "lang": "tr"},
        "nodes": {"plan": {"output": "Plan metni", "data": {"steps": [1, 2]}}},
        "review": {"findings": [{"severity": "high", "file": "a.py", "line": 3, "message": "Hata"}]},
        "feedback": {"text": "", "round": 0},
    }
    out = render(
        "{{ input.prompt }} / {{ nodes.plan.output }} / {{ nodes.plan.data.steps | length }} / "
        "[{{ nodes.missing.output }}] / {{ review.findings | findings }}",
        variables,
    )
    assert out == "Görev / Plan metni / 2 / [] / - [HIGH] `a.py:3` Hata"
    assert render("{% if feedback.text %}var{% else %}yok{% endif %}", variables) == "yok"
    assert render("{{ input | json(0) }}", variables) == '{"prompt": "Görev", "lang": "tr"}'
    assert evaluate("'Plan' in nodes.plan.output and input.lang == 'tr'", variables) is True
    assert evaluate("nodes.unknown.output", variables) is False


def test_templates_are_sandboxed() -> None:
    # unsafe attributes resolve to nothing, calling them is refused, resource limits apply
    assert render("{{ ''.__class__.__mro__ }}", {}) == ""
    assert render("{{ input.__class__.__init__.__globals__ }}", {"input": {"a": 1}}) == ""
    with pytest.raises(TemplateFailed, match="unsafe"):
        render("{{ ''.__class__.__subclasses__() }}", {})
    with pytest.raises(TemplateFailed, match="Range too big"):
        render("{{ range(100000000) | list | length }}", {})
    with pytest.raises(TemplateFailed, match="Şablon hatası"):
        render("{{ a ", {})
    assert check_template("{% for x in y %}") is not None
    assert check_template("{{ ok }}") is None


# --------------------------------------------------------------------------- structured output


def test_extract_json_robustly() -> None:
    assert extract_json('Metin\n```json\n{"a": 1,}\n```') == {"a": 1}
    assert extract_json("```\n{“a”: “b”}\n```") == {"a": "b"}
    assert extract_json('önce {"x": 1} sonra {"y": {"z": "}"}} bitti') == {"y": {"z": "}"}}
    assert extract_json('```json\n{"old": 1}\n```\nDüzeltme:\n```json\n{"new": 2}\n```') == {"new": 2}
    assert extract_json("JSON yok") is None
    assert strip_json_block('Plan\n\n---\n```json\n{"a": 1}\n```') == "Plan"


def test_parse_findings_normalizes() -> None:
    text = (
        '```json\n{"verdict": "FAIL", "findings": [{"severity": "Blocker", "path": "x.py", "line": "7", '
        '"description": "Kritik"}, {"level": "minor", "message": "küçük"}, "serbest metin"]}\n```'
    )
    parsed = parse_structured("findings", text)
    assert parsed is not None and parsed["verdict"] == "fail"
    assert parsed["findings"] == [
        {"severity": "critical", "file": "x.py", "line": 7, "message": "Kritik"},
        {"severity": "low", "file": None, "line": None, "message": "küçük"},
        {"severity": "medium", "file": None, "line": None, "message": "serbest metin"},
    ]
    assert parse_structured("findings", '{"summary": "x"}') is None
    assert normalize_severity("Yüksek") == "high" and normalize_severity("???") == "medium"
    plan = parse_structured("plan", '{"summary": "s", "steps": ["a", {"title": "b", "files": ["f"]}]}')
    assert plan == {
        "summary": "s",
        "steps": [{"title": "a", "detail": "", "files": []}, {"title": "b", "detail": "", "files": ["f"]}],
        "risks": [],
    }
    assert parse_structured("decision", '{"decision": "X", "risks": "tek risk"}') == {
        "decision": "X",
        "rationale": "",
        "options": [],
        "risks": ["tek risk"],
        "next_steps": [],
    }


def test_missing_decision_sections() -> None:
    doc = "# Karar\n## Bağlam\n## Seçenekler\n## Karar\n### Gerekçe\n"
    assert missing_sections(doc) == ["Riskler", "Sonraki adımlar"]


# --------------------------------------------------------------------------- boundaries


@pytest.mark.parametrize(
    ("patterns", "path", "expected"),
    [
        (["secrets/"], "secrets/a.txt", True),
        (["secrets/"], "app/secrets/a.txt", True),
        (["secrets/"], "secrets", False),  # directory-only pattern never matches a file of that name
        (["/config"], "config/x.yml", True),
        (["/config"], "app/config/x.yml", False),
        (["*.pem"], "deep/dir/key.pem", True),
        (["src/*.py"], "src/a.py", True),
        (["src/*.py"], "src/sub/a.py", False),
        (["src/**/*.py"], "src/sub/deep/a.py", True),
        (["**/node_modules"], "a/b/node_modules/x.js", True),
        (["docs/**"], "docs/a/b.md", True),
        (["*.env", "!example.env"], "example.env", False),
        (["*.env", "!example.env"], "prod.env", True),
        (["# yorum", ""], "x", False),
        (["file?.txt"], "file1.txt", True),
        (["[abc].txt"], "b.txt", True),
    ],
)
def test_gitignore_matching(patterns: list[str], path: str, expected: bool) -> None:
    assert matches(patterns, path) is expected


def test_check_paths_and_commands() -> None:
    b = Boundaries(forbidden_paths=[".env"], readonly_paths=["migrations/"], denied_commands=["rm -rf *", "git push"])
    v = check_paths([".env", "migrations/001.sql", "src/app.py"], b, repo="api")
    assert [(x.path, x.kind, x.repo) for x in v] == [
        (".env", "forbidden", "api"),
        ("migrations/001.sql", "readonly", "api"),
    ]
    c = check_commands(["rm   -rf /tmp/x", "git push origin main", "git status"], b)
    assert [x.rule for x in c] == ["rm -rf *", "git push"]


# --------------------------------------------------------------------------- quality


def _gate(kind: str, status: str, attempt: int = 1, node: str = "g", **evidence: Any) -> GateResult:
    return GateResult(
        id=f"{node}{attempt}{kind}",
        run_id="r",
        node_run_id=f"nr{attempt}",
        node_id=node,
        kind=kind,
        status=status,  # type: ignore[arg-type]
        attempt=attempt,
        evidence=evidence,
        created_at=utcnow() + timedelta(seconds=attempt),
    )


def test_quality_formula() -> None:
    gates = [
        _gate("build_test", "passed", node="build", commands=[{"exit_code": 0}, {"exit_code": 0}]),
        _gate("cross_review", "failed", 1, node="review", findings=[{"severity": "high"}, {"severity": "low"}]),
        _gate("cross_review", "passed", 2, node="review", findings=[{"severity": "medium"}]),
        _gate("user_final", "passed", node="final"),
    ]
    state = RunState(loops={"review": 1})
    q = compute_quality(gates, state, rating=5)
    comp = {c.key: c for c in q.components}
    assert comp["gates_first_pass"].value == pytest.approx(2 / 3)
    assert comp["review"].value == pytest.approx(1 - (15 + 1 + 5) / 100)
    assert comp["tests"].value == 1.0
    assert comp["rework"].value == 0.75
    assert comp["user_rating"].value == 1.0
    expected = 100 * (30 * 2 / 3 + 25 * 0.79 + 25 * 1 + 10 * 0.75 + 10 * 1) / 100
    assert q.score == pytest.approx(round(expected, 1))
    assert "Σ" in q.formula

    # components that do not apply are left out and their weight redistributed
    q2 = compute_quality([], RunState(), rating=None)
    assert [c.key for c in q2.components if c.value is not None] == ["rework"]
    assert q2.score == 100.0
