"""Static flow graph validation (all messages Turkish, shown on the canvas)."""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable

from aistudio.contracts.agents import AgentProfile
from aistudio.contracts.common import Provider
from aistudio.contracts.flows import (
    AdvisorNodeConfig,
    AgentNodeConfig,
    CompareNodeConfig,
    ConditionNodeConfig,
    DeployNodeConfig,
    FlowGraph,
    GateKind,
    GateNodeConfig,
    GitNodeConfig,
    HumanNodeConfig,
    JoinNodeConfig,
    MergeNodeConfig,
    NodeKind,
    SynthesisNodeConfig,
)
from aistudio.engine.graph import (
    LOOP_CONDITIONS,
    Topology,
    is_opinion,
    is_writer,
    nearest_writer,
    upstream_branch_heads,
)
from aistudio.engine.models import ValidationIssue, ValidationReport
from aistudio.engine.templates import check_expression, check_template

ProfileResolver = Callable[[str], Awaitable[AgentProfile | None]]

_NODE_ID = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
_GATE_LOOP_KINDS = (NodeKind.gate, NodeKind.condition)
_PASS_FAIL_SOURCES = frozenset(
    {NodeKind.gate, NodeKind.human, NodeKind.compare, NodeKind.merge, NodeKind.deploy, NodeKind.git}
)


async def _static_provider(
    cfg: AgentNodeConfig | AdvisorNodeConfig, resolve: ProfileResolver | None
) -> Provider | None:
    if cfg.provider is not None and "provider" in cfg.model_fields_set:
        return cfg.provider
    if cfg.profile_id and resolve is not None:
        profile = await resolve(cfg.profile_id)
        if profile is not None:
            return profile.provider
    return cfg.provider


async def validate_graph(graph: FlowGraph, *, resolve_profile: ProfileResolver | None = None) -> ValidationReport:
    errors: list[ValidationIssue] = []
    warnings: list[ValidationIssue] = []

    def err(code: str, message: str, *, node_id: str | None = None, edge_id: str | None = None) -> None:
        errors.append(ValidationIssue(code=code, message=message, node_id=node_id, edge_id=edge_id))

    def warn(code: str, message: str, *, node_id: str | None = None, edge_id: str | None = None) -> None:
        warnings.append(ValidationIssue(code=code, message=message, node_id=node_id, edge_id=edge_id))

    if not graph.nodes:
        err("empty", "Akışta hiç düğüm yok.")
        return ValidationReport(ok=False, errors=errors, warnings=warnings)

    # ------------------------------------------------------------------ ids and references
    seen_nodes: set[str] = set()
    for n in graph.nodes:
        if n.id in seen_nodes:
            err("duplicate_node", f"Aynı kimliğe sahip birden fazla düğüm var: {n.id}", node_id=n.id)
        seen_nodes.add(n.id)
        if not _NODE_ID.match(n.id):
            err(
                "bad_node_id",
                f"Düğüm kimliği geçersiz: {n.id!r}. Harf veya alt çizgiyle başlamalı, yalnız harf, rakam ve alt "
                "çizgi içermeli.",
                node_id=n.id,
            )
        if not n.label.strip():
            warn("empty_label", "Düğümün etiketi boş.", node_id=n.id)
    seen_edges: set[str] = set()
    node_kinds = {n.id: n.kind for n in graph.nodes}
    for e in graph.edges:
        if e.id in seen_edges:
            err("duplicate_edge", f"Aynı kimliğe sahip birden fazla bağlantı var: {e.id}", edge_id=e.id)
        seen_edges.add(e.id)
        if e.source not in node_kinds or e.target not in node_kinds:
            err("dangling_edge", "Bağlantı var olmayan bir düğüme işaret ediyor.", edge_id=e.id)
            continue
        if e.source == e.target:
            err("self_loop", "Bir düğüm kendisine bağlanamaz.", edge_id=e.id, node_id=e.source)
        src_kind = node_kinds[e.source]
        if e.condition in ("true", "false") and src_kind != NodeKind.condition:
            err(
                "bad_condition",
                "'doğru/yanlış' bağlantıları yalnız koşul düğümünden çıkabilir.",
                edge_id=e.id,
                node_id=e.source,
            )
        if src_kind == NodeKind.condition and e.condition not in ("true", "false", "default", "failed"):
            err(
                "bad_condition",
                "Koşul düğümünden yalnız 'doğru', 'yanlış' veya varsayılan bağlantı çıkabilir.",
                edge_id=e.id,
                node_id=e.source,
            )
        if e.condition in ("approved", "rejected") and src_kind not in _PASS_FAIL_SOURCES:
            warn(
                "odd_condition",
                "'onaylandı/reddedildi' bağlantısı onay içeren bir düğümden çıkmalı.",
                edge_id=e.id,
                node_id=e.source,
            )

    if errors:
        return ValidationReport(ok=False, errors=errors, warnings=warnings)

    # ------------------------------------------------------------------ structure
    topo = Topology.build(graph)
    if topo.entry is None:
        if not topo.entry_candidates:
            err("no_entry", "Akışın başlangıç düğümü yok: her düğümün gelen bir bağlantısı var.")
        else:
            names = ", ".join(topo.entry_candidates)
            err(
                "multiple_entries",
                f"Akışın tek bir başlangıç düğümü olmalı; şu an birden fazla var: {names}. "
                "Paralel başlangıç için bir 'paralel' düğümü kullanın.",
            )
        return ValidationReport(ok=False, errors=errors, warnings=warnings)

    for n in graph.nodes:
        if n.id not in topo.reachable:
            err("unreachable", f"'{n.label}' düğümüne başlangıçtan ulaşılamıyor.", node_id=n.id)

    for eid in topo.back_edges:
        e = topo.edges[eid]
        src = topo.nodes[e.source]
        if e.condition not in LOOP_CONDITIONS:
            err(
                "bad_cycle",
                "Döngüler yalnız 'başarısız' veya 'yanlış' bağlantılarıyla kurulabilir.",
                edge_id=eid,
                node_id=e.source,
            )
        elif src.kind not in _GATE_LOOP_KINDS:
            err(
                "loop_without_limit",
                "Geri dönen bağlantı yalnız tur sınırı olan bir kapıdan veya koşul düğümünden çıkabilir.",
                edge_id=eid,
                node_id=e.source,
            )

    # ------------------------------------------------------------------ node configs
    for n in graph.nodes:
        cfg = n.config
        if isinstance(cfg, AgentNodeConfig | AdvisorNodeConfig) and (msg := check_template(cfg.prompt_template)):
            err("template", msg, node_id=n.id)
        if isinstance(cfg, AgentNodeConfig) and cfg.max_turns is not None and cfg.max_turns < 1:
            err("bad_value", "En fazla tur sayısı 1 veya daha büyük olmalı.", node_id=n.id)
        if isinstance(cfg, SynthesisNodeConfig):
            if msg := check_template(cfg.prompt_template):
                err("template", msg, node_id=n.id)
            if not upstream_branch_heads(topo, n.id, is_opinion):
                err("no_opinions", "Sentez düğümünün önünde görüş üreten bir danışman veya ajan yok.", node_id=n.id)
        if isinstance(cfg, GateNodeConfig):
            if cfg.max_rounds < 1:
                err("bad_value", "Kapının tur sınırı en az 1 olmalı.", node_id=n.id)
            if cfg.target_node_id is not None and cfg.target_node_id not in topo.nodes:
                err("bad_target", f"Kapının hedef düğümü bulunamadı: {cfg.target_node_id}", node_id=n.id)
            if cfg.gate == GateKind.custom_command and not (cfg.command or "").strip():
                err("missing_command", "Özel komut kapısı için bir komut girilmeli.", node_id=n.id)
            needs_writer = cfg.gate in (GateKind.build_test, GateKind.boundary_check, GateKind.cross_review)
            if needs_writer and cfg.target_node_id is None and nearest_writer(topo, n.id) is None:
                if cfg.gate == GateKind.cross_review:
                    err("no_author", "Çapraz incelemenin inceleyeceği, kod yazan bir düğüm yok.", node_id=n.id)
                else:
                    warn("no_writer", "Bu kapının önünde kod yazan bir düğüm yok; kapı atlanacak.", node_id=n.id)
            if cfg.gate == GateKind.plan_approval and not list(topo.upstream(n.id)):
                err("no_plan", "Plan onayının önünde plan üreten bir düğüm olmalı.", node_id=n.id)
            if cfg.gate == GateKind.cross_review:
                await _check_cross_review(topo, n.id, cfg, resolve_profile, err)
        if isinstance(cfg, CompareNodeConfig):
            candidates = upstream_branch_heads(topo, n.id, is_writer)
            if not candidates:
                err("no_candidates", "Karşılaştırma düğümünün önünde aday üreten ajan yok.", node_id=n.id)
            elif len(candidates) < 2:
                warn("one_candidate", "Karşılaştırma için en az iki aday önerilir.", node_id=n.id)
        if isinstance(cfg, ConditionNodeConfig):
            if msg := check_expression(cfg.expression):
                err("expression", msg, node_id=n.id)
            if cfg.max_loops < 1:
                err("bad_value", "Koşulun döngü sınırı en az 1 olmalı.", node_id=n.id)
        if isinstance(cfg, JoinNodeConfig) and len(topo.forward_in(n.id)) < 2:
            warn("thin_join", "Birleşme düğümüne en az iki dal bağlanmalı.", node_id=n.id)
        if isinstance(cfg, MergeNodeConfig | GitNodeConfig) and nearest_writer(topo, n.id) is None:
            err("no_writer", "Bu düğümün önünde kod yazan bir düğüm yok.", node_id=n.id)
        if isinstance(cfg, GitNodeConfig):
            for tpl in (cfg.title_template, cfg.body_template, cfg.push_branch_template):
                if msg := check_template(tpl):
                    err("template", msg, node_id=n.id)
        if isinstance(cfg, DeployNodeConfig) and not cfg.profile_id.strip():
            err("missing_profile", "Deploy düğümü için bir deploy profili seçilmeli.", node_id=n.id)
        if isinstance(cfg, HumanNodeConfig) and not cfg.instructions.strip():
            err("missing_instructions", "Kullanıcı adımı için talimat yazılmalı.", node_id=n.id)

    if graph.settings.max_parallel_agents < 1:
        err("bad_value", "Aynı anda çalışacak ajan sayısı en az 1 olmalı.")

    writers_by_upstream: dict[str, list[str]] = {}
    for n in graph.nodes:
        if is_writer(n) and n.kind == NodeKind.agent:
            up = nearest_writer(topo, n.id)
            if up is not None:
                writers_by_upstream.setdefault(up, []).append(n.id)
    for up, ids in writers_by_upstream.items():
        parallel = [
            a for a in ids if not any(b in topo.descendants(a) or a in topo.descendants(b) for b in ids if b != a)
        ]
        if len(parallel) > 1:
            warn(
                "shared_worktree",
                f"Paralel dallardaki yazar düğümler ({', '.join(parallel)}) aynı worktree üzerinde çalışacak.",
                node_id=up,
            )

    return ValidationReport(ok=not errors, errors=errors, warnings=warnings)


async def _check_cross_review(
    topo: Topology,
    node_id: str,
    cfg: GateNodeConfig,
    resolve: ProfileResolver | None,
    err: Callable[..., None],
) -> None:
    author_id = cfg.target_node_id or nearest_writer(topo, node_id)
    if author_id is None:
        return
    author_cfg = topo.nodes[author_id].config
    if not isinstance(author_cfg, AgentNodeConfig | AdvisorNodeConfig):
        return
    author_provider = await _static_provider(author_cfg, resolve)
    if author_provider is None or cfg.reviewer_profile_id is None or resolve is None:
        return
    reviewer = await resolve(cfg.reviewer_profile_id)
    if reviewer is not None and reviewer.provider == author_provider:
        err(
            "cross_review_provider",
            f"Çapraz inceleme kuralı: inceleyen ({reviewer.provider}) yazarla ({author_provider}) aynı "
            "sağlayıcıda olamaz.",
            node_id=node_id,
        )
