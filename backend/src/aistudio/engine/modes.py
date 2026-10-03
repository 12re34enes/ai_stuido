"""Built-in mode templates (spec §5, §25): Tek, İkili, Yarış, Hat, Kurul, Ekip.

Modes are plain graphs. Node ids are stable so prompt templates and the UI can refer to them:
``plan``, ``plan_gate``, ``dev``, ``dev_a``/``dev_b``, ``boundary``, ``build``, ``review``,
``test``, ``final``, ``compare``, ``merge``, ``advisor_a``/``advisor_b``, ``synthesis``, ``team``.
"""

from __future__ import annotations

from aistudio.contracts.common import Provider, other_provider
from aistudio.contracts.flows import (
    AdvisorNodeConfig,
    AgentNodeConfig,
    CompareNodeConfig,
    EdgeCondition,
    FlowEdge,
    FlowGraph,
    FlowMode,
    FlowNode,
    FlowSettings,
    GateKind,
    GateNodeConfig,
    MergeNodeConfig,
    NodeConfig,
    ParallelNodeConfig,
    SynthesisNodeConfig,
    TeamNodeConfig,
)
from aistudio.contracts.teams import TeamSpec
from aistudio.engine.graph import auto_layout
from aistudio.engine.models import ModeInfo

PROVIDER_LABEL: dict[str, str] = {"claude": "Claude", "codex": "Codex"}

MODE_INFO: dict[FlowMode, ModeInfo] = {
    FlowMode.single: ModeInfo(
        mode=FlowMode.single,
        label="Tek",
        description="Tek ajan yazar; build/test kanıtı ve son onaydan geçer.",
    ),
    FlowMode.duo: ModeInfo(
        mode=FlowMode.duo,
        label="İkili",
        description="Bir sağlayıcı yazar, diğeri inceler. Engelleyici bulgu varsa iş yazara döner.",
    ),
    FlowMode.race: ModeInfo(
        mode=FlowMode.race,
        label="Yarış",
        description="İki ajan aynı işi paralel yapar; sonuçlar karşılaştırılır, seçilen birleşir.",
    ),
    FlowMode.pipeline: ModeInfo(
        mode=FlowMode.pipeline,
        label="Hat",
        description="Planlayıcı, plan onayı, geliştirici, inceleyen, test eden ve son onay.",
    ),
    FlowMode.council: ModeInfo(
        mode=FlowMode.council,
        label="Kurul",
        description="Danışmanlar bağımsız görüş verir; karşı tez ve sentezle tek karar belgesi yazılır.",
    ),
    FlowMode.team: ModeInfo(
        mode=FlowMode.team,
        label="Ekip",
        description=(
            "Lider görevi ekibine dağıtır; üyeler kendi worktree'lerinde çalışır ve sonuçlar liderde birleşir. "
            "Ardından build/test, çapraz inceleme ve son onay gelir."
        ),
    ),
    FlowMode.custom: ModeInfo(
        mode=FlowMode.custom,
        label="Özel",
        description="Tuvalde kendi akışını kur.",
    ),
}

DEV_PROMPT = """{{ input.prompt }}
{% if nodes.plan_gate.output %}

## Onaylanan plan
{{ nodes.plan_gate.output }}
{% endif %}
{% if feedback.text %}

## Düzeltilmesi gerekenler (tur {{ feedback.round }})
{{ feedback.text }}
{% endif %}"""

PLAN_PROMPT = """Aşağıdaki görev için uygulanabilir, adım adım bir plan hazırla. Kod yazma; repoyu inceleyebilirsin.

## Görev
{{ input.prompt }}
{% if feedback.text %}

## Kullanıcının geri bildirimi
{{ feedback.text }}
{% endif %}"""

TEST_PROMPT = """Geliştiricinin yaptığı değişiklikler için testler yaz ve çalıştır. Uygulama kodunu yalnız \
testlerin ortaya çıkardığı açık hatalar için değiştir.

## Görev
{{ input.prompt }}

## Geliştiricinin özeti
{{ nodes.dev.output | clip(3000) }}
{% if feedback.text %}

## Düzeltilmesi gerekenler (tur {{ feedback.round }})
{{ feedback.text }}
{% endif %}"""

TEAM_PROMPT = """{{ input.prompt }}
{% if feedback.text %}

## Düzeltilmesi gerekenler (tur {{ feedback.round }})
{{ feedback.text }}
{% endif %}"""

ADVISOR_PROMPT = """{{ input.prompt }}

Bağımsız bir görüş belgesi yaz: seçenekleri, önerini, gerekçeni ve risklerini açıkla."""


def _edge(source: str, target: str, condition: EdgeCondition = "default") -> FlowEdge:
    suffix = "" if condition == "default" else f"_{condition}"
    return FlowEdge(id=f"e_{source}_{target}{suffix}", source=source, target=target, condition=condition)


def _node(node_id: str, label: str, config: NodeConfig) -> FlowNode:
    return FlowNode(id=node_id, label=label, config=config)


def _dev(node_id: str, label: str, provider: Provider) -> FlowNode:
    return _node(node_id, label, AgentNodeConfig(provider=provider, role="writer", prompt_template=DEV_PROMPT))


def _gate(node_id: str, label: str, gate: GateKind, *, max_rounds: int = 3, **kw: object) -> FlowNode:
    return _node(node_id, label, GateNodeConfig.model_validate({"gate": gate, "max_rounds": max_rounds, **kw}))


def _single(primary: Provider) -> tuple[list[FlowNode], list[FlowEdge]]:
    nodes = [
        _dev("dev", "Geliştirici", primary),
        _gate("boundary", "Sınır denetimi", GateKind.boundary_check, max_rounds=2),
        _gate("build", "Build/test kanıtı", GateKind.build_test, max_rounds=3),
        _gate("final", "Son onay", GateKind.user_final, max_rounds=2),
    ]
    edges = [
        _edge("dev", "boundary"),
        _edge("boundary", "build"),
        _edge("build", "final"),
        _edge("boundary", "dev", "failed"),
        _edge("build", "dev", "failed"),
        _edge("final", "dev", "failed"),
    ]
    return nodes, edges


def _duo(primary: Provider) -> tuple[list[FlowNode], list[FlowEdge]]:
    reviewer = other_provider(primary)
    nodes = [
        _dev("dev", f"Yazar ({PROVIDER_LABEL[primary]})", primary),
        _gate("boundary", "Sınır denetimi", GateKind.boundary_check, max_rounds=2),
        _gate("build", "Build/test kanıtı", GateKind.build_test, max_rounds=3),
        _gate("review", f"Çapraz inceleme ({PROVIDER_LABEL[reviewer]})", GateKind.cross_review, max_rounds=3),
        _gate("final", "Son onay", GateKind.user_final, max_rounds=2),
    ]
    edges = [
        _edge("dev", "boundary"),
        _edge("boundary", "build"),
        _edge("build", "review"),
        _edge("review", "final"),
        _edge("boundary", "dev", "failed"),
        _edge("build", "dev", "failed"),
        _edge("review", "dev", "failed"),
        _edge("final", "dev", "failed"),
    ]
    return nodes, edges


def _race(primary: Provider) -> tuple[list[FlowNode], list[FlowEdge]]:
    secondary = other_provider(primary)
    nodes = [
        _node("fork", "Paralel başlat", ParallelNodeConfig()),
        _dev("dev_a", f"Ajan A ({PROVIDER_LABEL[primary]})", primary),
        _dev("dev_b", f"Ajan B ({PROVIDER_LABEL[secondary]})", secondary),
        _node(
            "compare",
            "Karşılaştır",
            CompareNodeConfig(judge="user", run_gates=[GateKind.boundary_check, GateKind.build_test]),
        ),
        _node("merge", "Seçilen birleşir", MergeNodeConfig(require_approval=False, strategy="squash")),
    ]
    edges = [
        _edge("fork", "dev_a"),
        _edge("fork", "dev_b"),
        _edge("dev_a", "compare"),
        _edge("dev_b", "compare"),
        _edge("compare", "merge"),
    ]
    return nodes, edges


def _pipeline(primary: Provider) -> tuple[list[FlowNode], list[FlowEdge]]:
    secondary = other_provider(primary)
    nodes = [
        _node(
            "plan",
            "Planlayıcı",
            AgentNodeConfig(
                provider=primary, role="planner", writes=False, output_format="plan", prompt_template=PLAN_PROMPT
            ),
        ),
        _gate("plan_gate", "Plan onayı", GateKind.plan_approval, max_rounds=3),
        _dev("dev", "Geliştirici", primary),
        _gate("review", "İnceleyen", GateKind.cross_review, max_rounds=3, target_node_id="dev"),
        _node(
            "test",
            "Test eden",
            AgentNodeConfig(provider=secondary, role="tester", prompt_template=TEST_PROMPT),
        ),
        _gate("boundary", "Sınır denetimi", GateKind.boundary_check, max_rounds=2, target_node_id="dev"),
        _gate("build", "Build/test kanıtı", GateKind.build_test, max_rounds=3),
        _gate("final", "Son onay", GateKind.user_final, max_rounds=2),
    ]
    edges = [
        _edge("plan", "plan_gate"),
        _edge("plan_gate", "dev"),
        _edge("dev", "review"),
        _edge("review", "test"),
        _edge("test", "boundary"),
        _edge("boundary", "build"),
        _edge("build", "final"),
        _edge("plan_gate", "plan", "failed"),
        _edge("review", "dev", "failed"),
        _edge("boundary", "dev", "failed"),
        _edge("build", "dev", "failed"),
        _edge("final", "dev", "failed"),
    ]
    return nodes, edges


def _council(primary: Provider) -> tuple[list[FlowNode], list[FlowEdge]]:
    secondary = other_provider(primary)
    nodes = [
        _node("fork", "Paralel başlat", ParallelNodeConfig()),
        _node(
            "advisor_a",
            f"Danışman A ({PROVIDER_LABEL[primary]})",
            AdvisorNodeConfig(
                provider=primary,
                perspective="Uygulanabilirlik, sadelik ve bakım maliyeti",
                prompt_template=ADVISOR_PROMPT,
            ),
        ),
        _node(
            "advisor_b",
            f"Danışman B ({PROVIDER_LABEL[secondary]})",
            AdvisorNodeConfig(
                provider=secondary,
                perspective="Riskler, güvenlik ve ölçeklenebilirlik",
                prompt_template=ADVISOR_PROMPT,
            ),
        ),
        _node(
            "synthesis",
            "Karşı tez ve sentez",
            SynthesisNodeConfig(provider=primary, devil_advocate=True, propose_memory=True),
        ),
    ]
    edges = [
        _edge("fork", "advisor_a"),
        _edge("fork", "advisor_b"),
        _edge("advisor_a", "synthesis"),
        _edge("advisor_b", "synthesis"),
    ]
    return nodes, edges


def _team(team: TeamSpec | None, team_id: str | None) -> tuple[list[FlowNode], list[FlowEdge]]:
    # The reviewer is the provider other than the lead's (decided at run time from the team's lead).
    nodes = [
        _node("team", "Ekip", TeamNodeConfig(team=team, team_id=team_id, prompt_template=TEAM_PROMPT)),
        _gate("boundary", "Sınır denetimi", GateKind.boundary_check, max_rounds=2),
        _gate("build", "Build/test kanıtı", GateKind.build_test, max_rounds=3),
        _gate("review", "Çapraz inceleme", GateKind.cross_review, max_rounds=3),
        _gate("final", "Son onay", GateKind.user_final, max_rounds=2),
    ]
    edges = [
        _edge("team", "boundary"),
        _edge("boundary", "build"),
        _edge("build", "review"),
        _edge("review", "final"),
        _edge("boundary", "team", "failed"),
        _edge("build", "team", "failed"),
        _edge("review", "team", "failed"),
        _edge("final", "team", "failed"),
    ]
    return nodes, edges


_BUILDERS = {
    FlowMode.single: _single,
    FlowMode.duo: _duo,
    FlowMode.race: _race,
    FlowMode.pipeline: _pipeline,
    FlowMode.council: _council,
}


def build_mode_graph(
    mode: FlowMode,
    *,
    primary: Provider = "claude",
    settings: FlowSettings | None = None,
    team: TeamSpec | None = None,
    team_id: str | None = None,
) -> FlowGraph:
    """Graph for a mode. ``custom`` returns an empty graph (the canvas starts from scratch). ``team`` /
    ``team_id`` choose the team of ``FlowMode.team`` (default: the engine's default team)."""
    if mode == FlowMode.team:
        nodes, edges = _team(team, team_id)
        graph = FlowGraph(nodes=nodes, edges=edges, settings=settings or FlowSettings())
        return auto_layout(graph)
    builder = _BUILDERS.get(mode)
    if builder is None:
        return FlowGraph(settings=settings or FlowSettings())
    nodes, edges = builder(primary)
    graph = FlowGraph(nodes=nodes, edges=edges, settings=settings or FlowSettings())
    return auto_layout(graph)
