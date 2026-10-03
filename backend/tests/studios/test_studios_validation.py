from __future__ import annotations

from typing import Any

from aistudio.contracts.flows import FlowGraph
from aistudio.contracts.studios import StudioInput
from aistudio.studios.validation import entry_nodes, template_refs, validate_graph


def _graph(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> FlowGraph:
    return FlowGraph.model_validate({"nodes": nodes, "edges": edges})


def _codes(graph: FlowGraph, **kw: Any) -> tuple[set[str], set[str]]:
    r = validate_graph(graph, **kw)
    return {e.code for e in r.errors}, {w.code for w in r.warnings}


AGENT = {"kind": "agent", "prompt_template": "{{ input.prompt }}"}


def test_duo_loop_is_valid_and_writer_is_entry() -> None:
    g = _graph(
        [
            {"id": "write", "label": "Yazar", "config": AGENT},
            {"id": "build", "label": "Build", "config": {"kind": "gate", "gate": "build_test"}},
            {"id": "review", "label": "İnceleme", "config": {"kind": "gate", "gate": "cross_review"}},
        ],
        [
            {"id": "e1", "source": "write", "target": "build"},
            {"id": "e2", "source": "build", "target": "review", "condition": "passed"},
            {"id": "e3", "source": "review", "target": "write", "condition": "failed"},
            {"id": "e4", "source": "build", "target": "write", "condition": "failed"},
        ],
    )
    assert entry_nodes(g) == ["write"]
    r = validate_graph(g)
    assert r.ok and r.warnings == []


def test_structural_errors() -> None:
    g = _graph(
        [
            {"id": "a", "label": "A", "config": AGENT},
            {"id": "a", "label": "A2", "config": AGENT},
            {"id": "Bad-Id", "label": "B", "config": AGENT},
            {"id": "c", "label": "C", "config": {"kind": "condition", "expression": "  "}},
            {"id": "g", "label": "G", "config": {"kind": "gate", "gate": "custom_command", "max_rounds": 0}},
        ],
        [
            {"id": "e1", "source": "a", "target": "zzz"},
            {"id": "e1", "source": "a", "target": "c"},
            {"id": "e2", "source": "c", "target": "a"},
            {"id": "e3", "source": "a", "target": "a"},
            {"id": "e4", "source": "a", "target": "g", "condition": "true"},
        ],
    )
    errors, _ = _codes(g)
    assert {
        "duplicate_node",
        "bad_node_id",
        "unknown_edge_node",
        "duplicate_edge",
        "self_loop",
        "bad_edge_condition",
        "condition_true",
        "condition_expression",
        "gate_command",
        "gate_rounds",
    } <= errors


def test_empty_graph_and_pure_cycle() -> None:
    assert _codes(FlowGraph())[0] == {"empty_graph"}
    cycle = _graph(
        [{"id": "a", "label": "A", "config": AGENT}, {"id": "b", "label": "B", "config": AGENT}],
        [{"id": "e1", "source": "a", "target": "b"}, {"id": "e2", "source": "b", "target": "a"}],
    )
    assert "no_entry" in _codes(cycle)[0]


def test_warnings_for_likely_mistakes() -> None:
    g = _graph(
        [
            {"id": "p", "label": "Dallan", "config": {"kind": "parallel"}},
            {"id": "a", "label": "A", "config": AGENT},
            {"id": "j", "label": "Birleş", "config": {"kind": "join"}},
            {"id": "orphan", "label": "Yetim", "config": AGENT},
            {"id": "dep", "label": "Deploy", "config": {"kind": "deploy", "profile_id": "dp_1"}},
        ],
        [
            {"id": "e1", "source": "p", "target": "a"},
            {"id": "e2", "source": "a", "target": "j"},
            {"id": "e3", "source": "j", "target": "dep"},
            {"id": "e4", "source": "orphan", "target": "orphan2"},
        ],
    )
    errors, warnings = _codes(g)
    assert "unknown_edge_node" in errors
    assert {"parallel_fanout", "join_fanin", "deploy_without_approval"} <= warnings


def test_template_references_are_checked() -> None:
    g = _graph(
        [
            {
                "id": "a",
                "label": "A",
                "config": {
                    "kind": "agent",
                    "prompt_template": "{{ nodes.b.output }} {{ nodes['ghost'].output }} {{ input.topic }} "
                    "{{ input.unknown }} {% if gate is defined and gate.b is defined %}x{% endif %}",
                    "repo_ids": ["{{ input.missing_repo }}"],
                },
            },
            {"id": "b", "label": "B", "config": {"kind": "condition", "expression": "nodes.a.data.ok and ("}},
        ],
        [{"id": "e1", "source": "a", "target": "b"}],
    )
    r = validate_graph(g, inputs=[StudioInput(name="topic", label="Konu")])
    by_code = {(e.code, e.node_id) for e in r.errors}
    assert ("unknown_node_ref", "a") in by_code  # ghost
    assert ("unknown_input_binding", "a") in by_code  # repo_ids binding to an undeclared input
    assert ("template_syntax", "b") in by_code
    assert {(w.code, w.node_id) for w in r.warnings} == {("unknown_input_ref", "a")}


def test_template_refs_parser() -> None:
    refs = template_refs("{{ nodes.plan.output }}{{ input.prompt }}{{ gate['build'].evidence }}")
    assert refs.nodes == {"plan", "build"} and refs.inputs == {"prompt"} and refs.error is None
    assert template_refs("input.x | length > 0", expression=True).inputs == {"x"}
    assert template_refs("{% for %}").error
