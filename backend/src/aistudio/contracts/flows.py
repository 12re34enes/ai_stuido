"""Flow graph model shared by the engine, studios and the canvas UI (spec §5).

Modes (Tek/İkili/Yarış/Hat/Kurul) and studios are just graphs built from these nodes.

Prompt templates are Jinja2 (sandboxed) with these variables:
    input.<name>              task inputs (``input.prompt`` is the task text)
    nodes.<node_id>.output    text output of a finished node
    nodes.<node_id>.data      structured output (dict) of a finished node
    memory.context            memory context for the node's role
    memory.facts / memory.boundaries / memory.decisions   raw layer text
    review.findings           findings from the latest failed cross-review (loops)
    gate.<node_id>.evidence   evidence of a finished gate
    task.title, task.id, workspace.name, repo.<name>.default_branch
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

from aistudio.contracts.agents import AgentRole, Boundaries
from aistudio.contracts.common import Provider
from aistudio.contracts.limits import Budget, LimitPolicy
from aistudio.contracts.teams import TeamSpec


class NodeKind(StrEnum):
    agent = "agent"
    advisor = "advisor"
    gate = "gate"
    parallel = "parallel"
    join_ = "join"  # trailing underscore: `join` would shadow str.join
    compare = "compare"
    condition = "condition"
    synthesis = "synthesis"
    merge = "merge"
    git = "git"
    deploy = "deploy"
    human = "human"
    team = "team"  # a user-designed agent hierarchy (contracts/teams.py)


class GateKind(StrEnum):
    plan_approval = "plan_approval"  # Plan onayı
    boundary_check = "boundary_check"  # Sınır denetimi
    build_test = "build_test"  # Build/test kanıtı
    cross_review = "cross_review"  # Çapraz model incelemesi
    user_final = "user_final"  # Kullanıcı son onayı
    deploy_approval = "deploy_approval"  # Deploy onayı (locked for production)
    custom_command = "custom_command"  # arbitrary command must exit 0


LOCKED_GATES_FOR_PRODUCTION: frozenset[GateKind] = frozenset({GateKind.deploy_approval})


class AgentNodeConfig(BaseModel):
    kind: Literal[NodeKind.agent] = NodeKind.agent
    profile_id: str | None = None  # if set, provider/model/role/boundaries come from the profile
    provider: Provider | None = None
    model: str | None = None
    effort: str | None = None
    role: AgentRole = "writer"
    prompt_template: str = "{{ input.prompt }}"
    repo_ids: list[str] | None = None  # None = every repo in the workspace that the task targets
    writes: bool = True  # False = runs read-only (no worktree)
    boundaries: Boundaries | None = None  # extra node-level restrictions
    tool_names: list[str] | None = None
    max_turns: int | None = None
    output_format: Literal["text", "plan", "findings", "decision"] = "text"


class AdvisorNodeConfig(BaseModel):
    kind: Literal[NodeKind.advisor] = NodeKind.advisor
    profile_id: str | None = None
    provider: Provider | None = None
    model: str | None = None
    effort: str | None = None
    perspective: str = ""  # "güvenlik odaklı", "karşı tez", ...
    prompt_template: str = "{{ input.prompt }}"
    web_access: bool = False


class GateNodeConfig(BaseModel):
    kind: Literal[NodeKind.gate] = NodeKind.gate
    gate: GateKind
    # build_test: which repo commands to run (keys of repo.commands); default all defined
    commands: list[str] | None = None
    # custom_command:
    command: str | None = None
    # cross_review: reviewer must differ from the author's provider (enforced)
    reviewer_profile_id: str | None = None
    reviewer_model: str | None = None
    review_focus: str | None = None
    target_node_id: str | None = None  # whose output/worktree this gate checks; default = upstream
    max_rounds: int = 3  # loops back through a `failed` edge at most this many times
    blocking_severities: list[str] = Field(default_factory=lambda: ["critical", "high"])


class ParallelNodeConfig(BaseModel):
    kind: Literal[NodeKind.parallel] = NodeKind.parallel


class JoinNodeConfig(BaseModel):
    kind: Literal[NodeKind.join_] = NodeKind.join_
    mode: Literal["all", "any"] = "all"


class CompareNodeConfig(BaseModel):
    kind: Literal[NodeKind.compare] = NodeKind.compare
    judge: Literal["user", "agent"] = "user"
    judge_profile_id: str | None = None
    criteria: str = "Doğruluk, test sonuçları, sadelik ve sınırlara uyum."
    run_gates: list[GateKind] = Field(default_factory=lambda: [GateKind.build_test])


class ConditionNodeConfig(BaseModel):
    kind: Literal[NodeKind.condition] = NodeKind.condition
    # Jinja2 expression evaluated against the template variables; outgoing edges use
    # condition "true" / "false".
    expression: str
    max_loops: int = 3


class SynthesisNodeConfig(BaseModel):
    kind: Literal[NodeKind.synthesis] = NodeKind.synthesis
    profile_id: str | None = None
    provider: Provider | None = None
    model: str | None = None
    devil_advocate: bool = True  # ask for a counter-thesis before synthesizing
    prompt_template: str = ""
    output_format: Literal["decision", "report", "text"] = "decision"
    propose_memory: bool = True  # propose the decision to memory (decisions/)


class MergeNodeConfig(BaseModel):
    kind: Literal[NodeKind.merge] = NodeKind.merge
    target_ref: str | None = None  # default: repo default branch
    strategy: Literal["merge", "squash", "cherry_pick"] = "squash"
    require_approval: bool = True
    resolve_conflicts_with_agent: bool = True


class GitNodeConfig(BaseModel):
    kind: Literal[NodeKind.git] = NodeKind.git
    action: Literal["push", "open_pr"] = "open_pr"
    base_ref: str | None = None
    draft: bool = False
    title_template: str = "{{ task.title }}"
    body_template: str | None = None
    watch: bool = True  # PR takibi: autofix CI failures and review comments
    autofix: bool = True
    # action=push: target branch template; None = the worktree's own branch. PR-fix tasks use
    # "{{ input.push_branch }}" to push onto the existing PR branch.
    push_branch_template: str | None = None


class DeployNodeConfig(BaseModel):
    kind: Literal[NodeKind.deploy] = NodeKind.deploy
    profile_id: str


class HumanNodeConfig(BaseModel):
    kind: Literal[NodeKind.human] = NodeKind.human
    instructions: str
    input_schema: dict[str, Any] | None = None  # optional JSON schema for structured input


class TeamNodeConfig(BaseModel):
    """Runs a team (spec §25): the lead gets the rendered prompt and delegates down the tree."""

    kind: Literal[NodeKind.team] = NodeKind.team
    team_id: str | None = None  # saved team template (latest version) ...
    team: TeamSpec | None = None  # ... or an inline spec (wins over team_id)
    prompt_template: str = "{{ input.prompt }}"
    repo_ids: list[str] | None = None


NodeConfig = Annotated[
    AgentNodeConfig
    | AdvisorNodeConfig
    | GateNodeConfig
    | ParallelNodeConfig
    | JoinNodeConfig
    | CompareNodeConfig
    | ConditionNodeConfig
    | SynthesisNodeConfig
    | MergeNodeConfig
    | GitNodeConfig
    | DeployNodeConfig
    | HumanNodeConfig
    | TeamNodeConfig,
    Field(discriminator="kind"),
]


class Position(BaseModel):
    x: float = 0
    y: float = 0


class FlowNode(BaseModel):
    id: str  # stable, template-referencable: "plan", "dev", "review"
    label: str  # Turkish display label
    config: NodeConfig
    position: Position | None = None

    @property
    def kind(self) -> NodeKind:
        return self.config.kind


EdgeCondition = Literal["default", "passed", "failed", "true", "false", "approved", "rejected"]


class FlowEdge(BaseModel):
    id: str
    source: str
    target: str
    condition: EdgeCondition = "default"


class GateToggles(BaseModel):
    """Per-flow on/off switches (spec §7). Locked gates ignore ``False`` for production targets."""

    plan_approval: bool = True
    boundary_check: bool = True
    build_test: bool = True
    cross_review: bool = True
    user_final: bool = True


class FlowSettings(BaseModel):
    gates: GateToggles = Field(default_factory=GateToggles)
    budget: Budget = Field(default_factory=Budget)
    limit_policy: LimitPolicy = Field(default_factory=LimitPolicy)
    max_parallel_agents: int = 4
    checkpoint_every_node: bool = True


class FlowGraph(BaseModel):
    nodes: list[FlowNode] = Field(default_factory=list)
    edges: list[FlowEdge] = Field(default_factory=list)
    settings: FlowSettings = Field(default_factory=FlowSettings)
    inputs: dict[str, Any] = Field(default_factory=dict)  # JSON schema-ish description of inputs

    def node(self, node_id: str) -> FlowNode:
        for n in self.nodes:
            if n.id == node_id:
                return n
        raise KeyError(node_id)


class FlowMode(StrEnum):
    single = "single"  # Tek
    duo = "duo"  # İkili
    race = "race"  # Yarış
    pipeline = "pipeline"  # Hat
    council = "council"  # Kurul
    team = "team"  # Ekip (spec §25)
    custom = "custom"
