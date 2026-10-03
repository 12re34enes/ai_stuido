"""Every built-in studio template: schema, structure, spec §16 specifics, rendering, instantiation."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import pytest
import yaml
from jinja2 import StrictUndefined
from jinja2.sandbox import SandboxedEnvironment
from studio_helpers import StudioEnv, sample_inputs

from aistudio.contracts.common import Environment
from aistudio.contracts.flows import (
    LOCKED_GATES_FOR_PRODUCTION,
    AdvisorNodeConfig,
    AgentNodeConfig,
    ConditionNodeConfig,
    DeployNodeConfig,
    FlowGraph,
    GateKind,
    GateNodeConfig,
    NodeKind,
    SynthesisNodeConfig,
)
from aistudio.contracts.studios import Studio
from aistudio.studios.loader import BUILTIN_ORDER, builtin_files, load_builtin_studios
from aistudio.studios.validation import entry_nodes, is_template_field, validate_studio

SPEC_NAMES = {
    "architecture": "Mimari tasarım",
    "market-analysis": "Piyasa analizi",
    "design": "Tasarım",
    "database": "Veritabanı",
    "code-review": "Kod inceleme",
    "debugging": "Hata ayıklama",
    "documentation": "Dokümantasyon",
    "proposal": "Teklif/kapsam",
}
STUDIOS = load_builtin_studios()


def _gates(studio: Studio) -> dict[str, GateNodeConfig]:
    return {n.id: n.config for n in studio.graph.nodes if isinstance(n.config, GateNodeConfig)}


def _forward_ancestors(graph: FlowGraph) -> dict[str, set[str]]:
    """Ancestors over forward edges only (loop-back edges removed): nodes guaranteed to have run."""
    entries = set(entry_nodes(graph))
    order = [n.id for n in graph.nodes]
    pos = {nid: i for i, nid in enumerate(order)}
    parents: dict[str, set[str]] = defaultdict(set)
    for e in graph.edges:
        if e.condition in ("failed", "false", "rejected") and pos[e.target] < pos[e.source]:
            continue  # loop back
        parents[e.target].add(e.source)
    result: dict[str, set[str]] = {}

    def anc(nid: str) -> set[str]:
        if nid in result:
            return result[nid]
        out: set[str] = set()
        if nid not in entries:
            for p in parents[nid]:
                out |= {p, *anc(p)}
        result[nid] = out
        return out

    for nid in order:
        anc(nid)
    return result


def _context(studio: Studio, done: set[str], inputs: dict[str, Any]) -> dict[str, Any]:
    return {
        "input": inputs,
        "nodes": {nid: {"output": f"<{nid} çıktısı>", "data": {}} for nid in done},
        "memory": {"context": "<hafıza>", "facts": "", "boundaries": "", "decisions": ""},
        "task": {"title": "Görev", "id": "task_1"},
        "workspace": {"name": "Çalışma alanı"},
    }


def _resolved_inputs(studio: Studio, overrides: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    for spec in studio.inputs:
        values[spec.name] = overrides.get(spec.name, spec.default if spec.default is not None else "")
    return values


def test_eight_builtin_files_match_spec() -> None:
    files = builtin_files()
    assert len(files) == 8
    assert {name.removesuffix(".yaml") for name, _ in files} == set(SPEC_NAMES)
    assert list(STUDIOS) == list(BUILTIN_ORDER)
    for sid, studio in STUDIOS.items():
        assert studio.id == sid
        assert studio.name == SPEC_NAMES[sid]
        assert studio.builtin is True and studio.version == 1
        assert studio.output_format == "markdown" and studio.output_template
        assert studio.description.strip() and studio.icon != "sparkles"


@pytest.mark.parametrize(("name", "text"), builtin_files())
def test_yaml_validates_against_studio_model(name: str, text: str) -> None:
    data = yaml.safe_load(text)
    studio = Studio.model_validate(data)
    assert studio.model_dump(mode="json")["id"] == name.removesuffix(".yaml")
    # The YAML is complete: re-validating the dump round-trips.
    assert Studio.model_validate(studio.model_dump(mode="json")) == studio


@pytest.mark.parametrize("sid", BUILTIN_ORDER)
def test_builtin_graph_has_no_errors_or_warnings(sid: str) -> None:
    report = validate_studio(STUDIOS[sid])
    assert report.ok, report.errors
    assert report.warnings == []


@pytest.mark.parametrize("sid", BUILTIN_ORDER)
def test_layout_flows_left_to_right(sid: str) -> None:
    graph = STUDIOS[sid].graph
    by_id = {n.id: n for n in graph.nodes}
    assert all(n.position is not None for n in graph.nodes)
    for e in graph.edges:
        src, dst = by_id[e.source].position, by_id[e.target].position
        assert src is not None and dst is not None
        if e.condition in ("failed", "false", "rejected") and dst.x < src.x:
            continue  # loop back to an earlier step
        assert src.x < dst.x, f"{sid}: {e.id} does not flow left to right"
    positions = [(n.position.x, n.position.y) for n in graph.nodes if n.position]
    assert len(set(positions)) == len(positions), "overlapping nodes"


@pytest.mark.parametrize("sid", BUILTIN_ORDER)
def test_prompt_templates_render_with_only_guaranteed_upstream_outputs(sid: str) -> None:
    studio = STUDIOS[sid]
    env = SandboxedEnvironment(undefined=StrictUndefined)
    ancestors = _forward_ancestors(studio.graph)
    inputs = _resolved_inputs(studio, sample_inputs(sid))
    for node in studio.graph.nodes:
        for fname, value in node.config:
            if not isinstance(value, str) or not value.strip() or not is_template_field(fname):
                continue
            ctx = _context(studio, ancestors[node.id], inputs)
            if fname == "expression":
                result = env.compile_expression(value)(**ctx)
                assert isinstance(result, bool)
                continue
            text = env.from_string(value).render(**ctx)  # first pass: no review/gate variables
            assert "{{" not in text and "{%" not in text
            if fname == "prompt_template":
                assert len(text) > 200, f"{sid}/{node.id}: prompt too thin"
                assert "Türkçe" in text, f"{sid}/{node.id}: prompt must ask for Turkish output"
            # loop pass: review findings and gate evidence are available
            loop_ctx = {
                **ctx,
                "review": {"findings": "- yüksek: düzelt"},
                "gate": {gid: {"evidence": f"<{gid} kanıtı>"} for gid in _gates(studio)},
            }
            env.from_string(value).render(**loop_ctx)


@pytest.mark.parametrize("sid", BUILTIN_ORDER)
def test_output_template_renders(sid: str) -> None:
    studio = STUDIOS[sid]
    env = SandboxedEnvironment(undefined=StrictUndefined)
    conditional = {"prod_approval", "prod_apply"}  # may not run
    done = {n.id for n in studio.graph.nodes} - conditional
    inputs = _resolved_inputs(studio, sample_inputs(sid))
    assert studio.output_template is not None
    text = env.from_string(studio.output_template).render(**_context(studio, done, inputs))
    assert text.strip() and "{{" not in text


def test_architecture_is_a_council_with_memory_decision() -> None:
    s = STUDIOS["architecture"]
    advisors = [n.config for n in s.graph.nodes if isinstance(n.config, AdvisorNodeConfig)]
    assert {a.provider for a in advisors} == {"claude", "codex"}
    assert s.graph.node("fanout").kind == NodeKind.parallel
    assert s.graph.node("counter").kind == NodeKind.advisor  # explicit counter-thesis step
    synthesis = s.graph.node("synthesis").config
    assert isinstance(synthesis, SynthesisNodeConfig)
    assert synthesis.propose_memory is True and synthesis.output_format == "decision"
    assert "mermaid" in synthesis.prompt_template and "status: önerildi" in synthesis.prompt_template
    assert [g.gate for g in _gates(s).values()] == [GateKind.user_final]


def test_market_analysis_researcher_has_web_access_and_critic() -> None:
    s = STUDIOS["market-analysis"]
    research = s.graph.node("research").config
    critique = s.graph.node("critique").config
    assert isinstance(research, AdvisorNodeConfig) and research.web_access
    assert isinstance(critique, AdvisorNodeConfig) and critique.provider != research.provider
    assert "Kaynaklar" in research.prompt_template
    assert [g.gate for g in _gates(s).values()] == [GateKind.user_final]


def test_design_has_visual_evidence_and_final_gates() -> None:
    s = STUDIOS["design"]
    gates = _gates(s)
    assert gates["visual"].gate == GateKind.custom_command
    assert gates["visual"].command == "{{ input.screenshot_command }}"
    assert gates["final"].gate == GateKind.user_final
    assert gates["review"].gate == GateKind.cross_review
    assert s.graph.node("designer").kind == NodeKind.advisor
    assert s.graph.node("implement").kind == NodeKind.agent


def test_database_migrates_only_in_test_and_production_is_separate_and_locked() -> None:
    s = STUDIOS["database"]
    inputs = {i.name: i for i in s.inputs}
    assert inputs["test_deploy_profile"].environment == Environment.test
    assert inputs["test_deploy_profile"].required is True
    assert inputs["production_deploy_profile"].environment == Environment.production
    assert inputs["production_deploy_profile"].required is False

    migrate = s.graph.node("migrate_test").config
    assert isinstance(migrate, DeployNodeConfig) and migrate.profile_id == "{{ input.test_deploy_profile }}"
    prod = s.graph.node("prod_apply").config
    assert isinstance(prod, DeployNodeConfig) and prod.profile_id == "{{ input.production_deploy_profile }}"

    edges = {(e.source, e.target): e.condition for e in s.graph.edges}
    # Production apply happens only after the user's final approval and merge, behind the locked gate.
    assert edges[("prod_approval", "prod_apply")] == "passed"
    assert _gates(s)["prod_approval"].gate in LOCKED_GATES_FOR_PRODUCTION
    assert edges[("prod_check", "prod_approval")] == "true"
    check = s.graph.node("prod_check").config
    assert isinstance(check, ConditionNodeConfig)
    env = SandboxedEnvironment(undefined=StrictUndefined)
    assert env.compile_expression(check.expression)(input={"production_deploy_profile": ""}) is False
    assert env.compile_expression(check.expression)(input={"production_deploy_profile": "dp_prod"}) is True
    # The migration test is reached only through review and an explicit test approval.
    assert edges[("review", "test_approval")] == "passed"
    assert edges[("test_approval", "migrate_test")] == "passed"
    assert edges[("final", "merge")] == "passed" and ("merge", "prod_check") in edges
    schema = s.graph.node("schema").config
    assert isinstance(schema, AgentNodeConfig) and "Hiçbir veritabanına bağlanma" in schema.prompt_template


def test_code_review_has_two_independent_reviewers() -> None:
    s = STUDIOS["code-review"]
    reviewers = [n.config for n in s.graph.nodes if isinstance(n.config, AgentNodeConfig)]
    assert len(reviewers) == 2
    assert {r.provider for r in reviewers} == {"claude", "codex"}
    assert all(r.role == "reviewer" and r.writes is False and r.output_format == "findings" for r in reviewers)
    consolidate = s.graph.node("consolidate").config
    assert isinstance(consolidate, SynthesisNodeConfig) and "Çelişki" in consolidate.prompt_template
    assert _gates(s) == {}


def test_debugging_requires_reproducing_test_evidence() -> None:
    s = STUDIOS["debugging"]
    diagnose = s.graph.node("diagnose").config
    assert isinstance(diagnose, AgentNodeConfig) and diagnose.writes is False
    assert diagnose.boundaries is not None and diagnose.boundaries.sandbox.value == "read_only"
    assert diagnose.boundaries.remote_access == "read"
    gate = _gates(s)["repro_gate"]
    assert gate.gate == GateKind.custom_command and gate.command and "! sh .aistudio/repro.sh" in gate.command
    edges = {(e.source, e.target): e.condition for e in s.graph.edges}
    assert edges[("repro_gate", "fix")] == "passed"
    assert edges[("repro_gate", "repro_test")] == "failed"
    order = [n.id for n in s.graph.nodes]
    assert order.index("repro_gate") < order.index("fix")


def test_documentation_has_consistency_gate() -> None:
    s = STUDIOS["documentation"]
    verify = _gates(s)["verify"]
    assert verify.gate == GateKind.cross_review and verify.review_focus
    assert "Kodla tutarlılık" in verify.review_focus


def test_proposal_has_analyst_estimator_and_critic() -> None:
    s = STUDIOS["proposal"]
    labels = [n.label for n in s.graph.nodes]
    assert labels[:3] == ["Kapsam analisti", "Tahminci", "Eleştirmen"]
    assert "(O + 4M + P) / 6" in s.graph.node("estimate").config.prompt_template  # type: ignore[union-attr]
    assert [g.gate for g in _gates(s).values()] == [GateKind.user_final]


@pytest.mark.parametrize("sid", BUILTIN_ORDER)
async def test_every_builtin_instantiates(studio_env: StudioEnv, sid: str) -> None:
    graph = await studio_env.svc.instantiate(sid, workspace_id=studio_env.ws.id, inputs=sample_inputs(sid))
    studio = STUDIOS[sid]
    assert set(graph.inputs) >= {i.name for i in studio.inputs}
    # Non-template fields are bound; nothing unresolved remains outside runtime templates.
    for node in graph.nodes:
        for fname, value in node.config:
            if is_template_field(fname):
                continue
            items = value if isinstance(value, list) else [value]
            assert not any(isinstance(v, str) and "{{" in v for v in items), (sid, node.id, fname)
        if isinstance(node.config, AgentNodeConfig) and node.config.repo_ids is not None:
            assert node.config.repo_ids == [studio_env.repo.id]
    # Prompt templates are left for the engine.
    assert any(
        "{{" in getattr(n.config, "prompt_template", "") for n in graph.nodes if hasattr(n.config, "prompt_template")
    )
