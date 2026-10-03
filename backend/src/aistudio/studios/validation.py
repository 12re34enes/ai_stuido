"""Structural validation of flow graphs and studios (for the editor, ``save`` and built-in tests).

Errors make a graph unusable (unknown node references, broken edges, template syntax errors);
warnings point at likely mistakes (unreachable nodes, a deploy without a deploy approval gate).
Messages are Turkish because the editor shows them as-is.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Literal

from jinja2 import TemplateSyntaxError, nodes
from jinja2.sandbox import SandboxedEnvironment
from pydantic import BaseModel, Field

from aistudio.contracts.flows import (
    ConditionNodeConfig,
    DeployNodeConfig,
    FlowGraph,
    FlowNode,
    GateKind,
    GateNodeConfig,
    NodeKind,
)
from aistudio.contracts.studios import Studio, StudioInput

NODE_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
INPUT_NAME = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
STUDIO_ID = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")
BINDING = re.compile(r"\{\{\s*input\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
KNOWN_SEVERITIES = frozenset({"critical", "high", "medium", "low", "info"})
# Inputs every task has even when a studio does not declare them.
IMPLICIT_INPUTS = frozenset({"prompt"})

_env = SandboxedEnvironment()


def is_template_field(name: str) -> bool:
    """Config fields rendered by the engine at runtime (never bound at instantiate time)."""
    return name.endswith("_template") or name in {"expression", "instructions"}


class GraphIssue(BaseModel):
    level: Literal["error", "warning"]
    code: str
    message: str  # Turkish
    node_id: str | None = None
    edge_id: str | None = None
    field: str | None = None


class GraphValidation(BaseModel):
    ok: bool
    errors: list[GraphIssue] = Field(default_factory=list)
    warnings: list[GraphIssue] = Field(default_factory=list)


@dataclass
class TemplateRefs:
    nodes: set[str] = field(default_factory=set)  # nodes.<id>, gate.<id>
    inputs: set[str] = field(default_factory=set)  # input.<name>
    error: str | None = None


def template_refs(source: str, *, expression: bool = False) -> TemplateRefs:
    """Parse a Jinja template (or expression) and collect ``nodes.*`` / ``gate.*`` / ``input.*`` refs."""
    refs = TemplateRefs()
    text = "{{ " + source + " }}" if expression else source
    try:
        ast = _env.parse(text)
    except TemplateSyntaxError as e:
        refs.error = f"Şablon sözdizimi hatası (satır {e.lineno}): {e.message}"
        return refs

    def visit(attr_holder: nodes.Node, name: str | None) -> None:
        if name is None:
            return
        if isinstance(attr_holder, nodes.Name) and attr_holder.name in ("nodes", "gate"):
            refs.nodes.add(name)
        elif isinstance(attr_holder, nodes.Name) and attr_holder.name == "input":
            refs.inputs.add(name)

    for n in ast.find_all(nodes.Getattr):
        visit(n.node, n.attr)
    for n in ast.find_all(nodes.Getitem):
        if isinstance(n.arg, nodes.Const) and isinstance(n.arg.value, str):
            visit(n.node, n.arg.value)
    return refs


def entry_nodes(graph: FlowGraph) -> list[str]:
    """Nodes a run starts from: no incoming edge except loop-back edges.

    A loop-back edge is a ``failed`` / ``false`` / ``rejected`` edge whose target can reach its
    source (it closes a cycle), e.g. ``review --failed--> writer``. The first writer of an
    İkili flow is therefore still an entry even though the review loops back to it.
    """
    ids = {n.id for n in graph.nodes}
    adj: dict[str, list[str]] = defaultdict(list)
    for e in graph.edges:
        if e.source in ids and e.target in ids:
            adj[e.source].append(e.target)

    def reaches(start: str, goal: str) -> bool:
        seen: set[str] = set()
        stack = [start]
        while stack:
            cur = stack.pop()
            if cur == goal:
                return True
            if cur in seen:
                continue
            seen.add(cur)
            stack.extend(adj.get(cur, []))
        return False

    forward_in: dict[str, int] = defaultdict(int)
    for e in graph.edges:
        if e.source not in ids or e.target not in ids:
            continue
        if e.condition in ("failed", "false", "rejected") and reaches(e.target, e.source):
            continue
        forward_in[e.target] += 1
    return [n.id for n in graph.nodes if forward_in[n.id] == 0]


def _allowed_conditions(node: FlowNode) -> set[str]:
    kind = node.kind
    if kind == NodeKind.condition:
        return {"true", "false"}
    allowed = {"default", "failed"}
    if kind == NodeKind.gate:
        allowed |= {"passed", "approved", "rejected"}
    elif kind == NodeKind.compare:
        allowed |= {"passed"}
    elif kind in (NodeKind.human, NodeKind.merge, NodeKind.deploy):
        allowed |= {"approved", "rejected"}
    return allowed


class _Collector:
    def __init__(self) -> None:
        self.errors: list[GraphIssue] = []
        self.warnings: list[GraphIssue] = []

    def error(self, code: str, message: str, **kw: str | None) -> None:
        self.errors.append(GraphIssue(level="error", code=code, message=message, **kw))

    def warn(self, code: str, message: str, **kw: str | None) -> None:
        self.warnings.append(GraphIssue(level="warning", code=code, message=message, **kw))

    def result(self) -> GraphValidation:
        return GraphValidation(ok=not self.errors, errors=self.errors, warnings=self.warnings)


def validate_graph(graph: FlowGraph, *, inputs: list[StudioInput] | None = None) -> GraphValidation:
    c = _Collector()
    _check_graph(graph, inputs, c)
    return c.result()


def _check_graph(graph: FlowGraph, inputs: list[StudioInput] | None, c: _Collector) -> None:
    if not graph.nodes:
        c.error("empty_graph", "Akışta hiç düğüm yok.")
        return
    ids: dict[str, FlowNode] = {}
    for n in graph.nodes:
        if not NODE_ID.match(n.id):
            c.error(
                "bad_node_id",
                f"Düğüm kimliği geçersiz: “{n.id}”. Küçük harfle başlamalı; yalnız küçük harf, rakam ve _ içermeli.",
                node_id=n.id,
            )
        if n.id in ids:
            c.error("duplicate_node", f"Aynı kimlikle birden fazla düğüm var: “{n.id}”.", node_id=n.id)
        ids[n.id] = n
        if not n.label.strip():
            c.warn("empty_label", f"“{n.id}” düğümünün etiketi boş.", node_id=n.id)

    outgoing: dict[str, list[tuple[str, str, str]]] = defaultdict(list)  # node -> [(target, cond, edge_id)]
    incoming: dict[str, list[str]] = defaultdict(list)
    edge_ids: set[str] = set()
    for e in graph.edges:
        if e.id in edge_ids:
            c.error("duplicate_edge", f"Aynı kimlikle birden fazla bağlantı var: “{e.id}”.", edge_id=e.id)
        edge_ids.add(e.id)
        bad = False
        for end in (e.source, e.target):
            if end not in ids:
                c.error("unknown_edge_node", f"Bağlantı bilinmeyen bir düğüme işaret ediyor: “{end}”.", edge_id=e.id)
                bad = True
        if bad:
            continue
        if e.source == e.target:
            c.error("self_loop", "Bir düğüm kendisine bağlanamaz.", edge_id=e.id, node_id=e.source)
            continue
        src = ids[e.source]
        if e.condition not in _allowed_conditions(src):
            c.error(
                "bad_edge_condition",
                f"“{src.label}” ({src.kind.value}) düğümünden “{e.condition}” koşullu bağlantı çıkamaz.",
                edge_id=e.id,
                node_id=src.id,
            )
        outgoing[e.source].append((e.target, e.condition, e.id))
        incoming[e.target].append(e.source)

    for n in graph.nodes:
        outs = outgoing.get(n.id, [])
        if n.kind == NodeKind.parallel:
            if len(outs) < 2:
                c.warn("parallel_fanout", f"“{n.label}” dallanma düğümünün en az iki çıkışı olmalı.", node_id=n.id)
        else:
            seen: set[str] = set()
            for _, cond, edge_id in outs:
                if cond in seen:
                    c.warn(
                        "ambiguous_edges",
                        f"“{n.label}” düğümünden aynı koşulla (“{cond}”) birden fazla bağlantı çıkıyor.",
                        node_id=n.id,
                        edge_id=edge_id,
                    )
                seen.add(cond)
        if n.kind == NodeKind.join_ and len(incoming.get(n.id, [])) < 2:
            c.warn("join_fanin", f"“{n.label}” birleşme düğümüne en az iki bağlantı girmeli.", node_id=n.id)
        if n.kind == NodeKind.condition and not any(cond == "true" for _, cond, _ in outs):
            c.error("condition_true", f"“{n.label}” koşul düğümünün “true” çıkışı yok.", node_id=n.id)
        _check_config(n, ids, graph, c)

    entries = entry_nodes(graph)
    if not entries:
        c.error("no_entry", "Başlangıç düğümü yok: her düğüme ileri yönlü bir bağlantı giriyor.")
    else:
        reached: set[str] = set()
        stack = list(entries)
        while stack:
            cur = stack.pop()
            if cur in reached:
                continue
            reached.add(cur)
            stack.extend(t for t, _, _ in outgoing.get(cur, []))
        for n in graph.nodes:
            if n.id not in reached:
                c.warn("unreachable", f"“{n.label}” düğümüne başlangıçtan ulaşılamıyor.", node_id=n.id)

    declared = {i.name for i in inputs} if inputs is not None else None
    for n in graph.nodes:
        _check_templates(n, ids, declared, c)


def _check_config(n: FlowNode, ids: dict[str, FlowNode], graph: FlowGraph, c: _Collector) -> None:
    cfg = n.config
    if isinstance(cfg, GateNodeConfig):
        if cfg.gate == GateKind.custom_command and not (cfg.command or "").strip():
            c.error("gate_command", f"“{n.label}” kapısı için çalıştırılacak komut boş.", node_id=n.id, field="command")
        if cfg.max_rounds < 1:
            c.error("gate_rounds", f"“{n.label}” kapısının tur sınırı en az 1 olmalı.", node_id=n.id)
        unknown = set(cfg.blocking_severities) - KNOWN_SEVERITIES
        if unknown:
            c.warn(
                "gate_severity",
                f"“{n.label}” kapısında bilinmeyen önem dereceleri: {', '.join(sorted(unknown))}.",
                node_id=n.id,
            )
        if cfg.target_node_id and cfg.target_node_id not in ids:
            c.error(
                "gate_target",
                f"“{n.label}” kapısının hedef düğümü bulunamadı: “{cfg.target_node_id}”.",
                node_id=n.id,
            )
    elif isinstance(cfg, ConditionNodeConfig):
        if not cfg.expression.strip():
            c.error("condition_expression", f"“{n.label}” koşul ifadesi boş.", node_id=n.id, field="expression")
        if cfg.max_loops < 1:
            c.error("condition_loops", f"“{n.label}” döngü sınırı en az 1 olmalı.", node_id=n.id)
    elif isinstance(cfg, DeployNodeConfig):
        if not cfg.profile_id.strip():
            c.error("deploy_profile", f"“{n.label}” için deploy profili seçilmemiş.", node_id=n.id, field="profile_id")
        preceded = any(
            e.target == n.id
            and isinstance(ids[e.source].config, GateNodeConfig)
            and ids[e.source].config.gate == GateKind.deploy_approval  # type: ignore[union-attr]
            for e in graph.edges
            if e.source in ids
        )
        if not preceded:
            c.warn(
                "deploy_without_approval",
                f"“{n.label}” deploy düğümünden hemen önce bir deploy onayı kapısı olmalı.",
                node_id=n.id,
            )


def _check_templates(n: FlowNode, ids: dict[str, FlowNode], declared: set[str] | None, c: _Collector) -> None:
    for fname, value in n.config:
        if fname == "kind":
            continue
        values: list[str]
        if isinstance(value, str):
            values = [value]
        elif isinstance(value, list) and all(isinstance(v, str) for v in value):
            values = list(value)
        else:
            continue
        for text in values:
            if is_template_field(fname):
                if not text.strip():
                    continue
                refs = template_refs(text, expression=fname == "expression")
                if refs.error:
                    c.error("template_syntax", f"“{n.label}” / {fname}: {refs.error}", node_id=n.id, field=fname)
                    continue
                for ref in sorted(refs.nodes - ids.keys()):
                    c.error(
                        "unknown_node_ref",
                        f"“{n.label}” / {fname}: bilinmeyen düğüme başvuru: “{ref}”.",
                        node_id=n.id,
                        field=fname,
                    )
                if declared is not None:
                    for ref in sorted(refs.inputs - declared - IMPLICIT_INPUTS):
                        c.warn(
                            "unknown_input_ref",
                            f"“{n.label}” / {fname}: tanımlı olmayan girdiye başvuru: “{ref}”.",
                            node_id=n.id,
                            field=fname,
                        )
            else:
                for ref in BINDING.findall(text):
                    if declared is not None and ref not in declared:
                        c.error(
                            "unknown_input_binding",
                            f"“{n.label}” / {fname}: tanımlı olmayan girdi bağlanmış: “{ref}”.",
                            node_id=n.id,
                            field=fname,
                        )


def validate_studio(studio: Studio) -> GraphValidation:
    c = _Collector()
    if not STUDIO_ID.match(studio.id):
        c.error("bad_studio_id", "Stüdyo kimliği yalnız küçük harf, rakam ve tire içerebilir (2-63 karakter).")
    if not studio.name.strip():
        c.error("empty_name", "Stüdyo adı boş olamaz.")
    names: set[str] = set()
    for inp in studio.inputs:
        if not INPUT_NAME.match(inp.name):
            c.error("bad_input_name", f"Girdi adı geçersiz: “{inp.name}”.", field=inp.name)
        if inp.name in names:
            c.error("duplicate_input", f"Aynı adla birden fazla girdi var: “{inp.name}”.", field=inp.name)
        names.add(inp.name)
        if inp.type == "select":
            if not inp.options:
                c.error("select_options", f"“{inp.label}” seçim alanının seçenekleri yok.", field=inp.name)
            elif inp.default not in (None, "") and inp.default not in inp.options:
                c.error("select_default", f"“{inp.label}” varsayılan değeri seçenekler arasında değil.", field=inp.name)
    _check_graph(studio.graph, studio.inputs, c)
    if studio.output_template:
        refs = template_refs(studio.output_template)
        node_ids = {n.id for n in studio.graph.nodes}
        if refs.error:
            c.error("template_syntax", f"Çıktı şablonu: {refs.error}", field="output_template")
        else:
            for ref in sorted(refs.nodes - node_ids):
                c.error(
                    "unknown_node_ref", f"Çıktı şablonu bilinmeyen düğüme başvuruyor: “{ref}”.", field="output_template"
                )
            for ref in sorted(refs.inputs - names - IMPLICIT_INPUTS):
                c.warn(
                    "unknown_input_ref",
                    f"Çıktı şablonu tanımlı olmayan girdiye başvuruyor: “{ref}”.",
                    field="output_template",
                )
    return c.result()
