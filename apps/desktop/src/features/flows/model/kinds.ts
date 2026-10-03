/**
 * Node kind catalog: palette grouping, icons, pydantic-identical default configs, and the edge
 * conditions that make sense for each source kind (mirrors engine/validation.py rules).
 */
import type { LucideIcon } from "lucide-react";
import { Bot, Combine, GitMerge, GitPullRequestArrow, Lightbulb, Merge, Rocket, Scale, ShieldCheck, Signpost, Split, UserRound } from "lucide-react";

import { kindStrings } from "../strings";
import type {
  AgentNodeConfig,
  Boundaries,
  ConfigOf,
  EdgeCondition,
  FlowSettings,
  GateKind,
  ModelConfig,
  NodeConfig,
  NodeKind,
} from "../types";

export type PaletteGroup = "agents" | "control" | "branching" | "delivery";

export interface KindInfo {
  kind: NodeKind;
  label: string;
  /** One line for the palette. */
  description: string;
  /** A sentence for the inspector header. */
  long: string;
  icon: LucideIcon;
  group: PaletteGroup;
}

const icons: Record<NodeKind, LucideIcon> = {
  agent: Bot,
  advisor: Lightbulb,
  gate: ShieldCheck,
  parallel: Split,
  join: Merge,
  compare: Scale,
  condition: Signpost,
  synthesis: Combine,
  merge: GitMerge,
  git: GitPullRequestArrow,
  deploy: Rocket,
  human: UserRound,
};

const groups: Record<NodeKind, PaletteGroup> = {
  agent: "agents",
  advisor: "agents",
  synthesis: "agents",
  gate: "control",
  condition: "control",
  compare: "control",
  human: "control",
  parallel: "branching",
  join: "branching",
  merge: "delivery",
  git: "delivery",
  deploy: "delivery",
};

/** Palette order: the order the spec lists node kinds in, grouped. */
export const PALETTE_GROUPS: { id: PaletteGroup; kinds: NodeKind[] }[] = [
  { id: "agents", kinds: ["agent", "advisor", "synthesis"] },
  { id: "control", kinds: ["gate", "condition", "compare", "human"] },
  { id: "branching", kinds: ["parallel", "join"] },
  { id: "delivery", kinds: ["merge", "git", "deploy"] },
];

export function kindInfo(kind: NodeKind): KindInfo {
  return { kind, ...kindStrings[kind], icon: icons[kind], group: groups[kind] };
}

export const DEFAULT_CRITERIA = "Doğruluk, test sonuçları, sadelik ve sınırlara uyum.";

export function defaultBoundaries(): Boundaries {
  return {
    forbidden_paths: [],
    readonly_paths: [],
    allowed_commands: [],
    denied_commands: [],
    network: true,
    sandbox: "workspace_write",
    remote_access: "none",
  };
}

/**
 * Pydantic defaults of every config (contracts/flows.py). New palette nodes get a provider so the
 * card carries its provider language right away.
 */
export function defaultConfig<K extends NodeKind>(kind: K, opts: { fresh?: boolean } = {}): ConfigOf<K> {
  const provider = opts.fresh ? "claude" : null;
  const configs: { [P in NodeKind]: ConfigOf<P> } = {
    agent: {
      kind: "agent",
      profile_id: null,
      provider,
      model: null,
      effort: null,
      role: "writer",
      prompt_template: "{{ input.prompt }}",
      repo_ids: null,
      writes: true,
      boundaries: null,
      tool_names: null,
      max_turns: null,
      output_format: "text",
    },
    advisor: {
      kind: "advisor",
      profile_id: null,
      provider,
      model: null,
      effort: null,
      perspective: "",
      prompt_template: "{{ input.prompt }}",
      web_access: false,
    },
    gate: {
      kind: "gate",
      gate: "build_test",
      commands: null,
      command: null,
      reviewer_profile_id: null,
      reviewer_model: null,
      review_focus: null,
      target_node_id: null,
      max_rounds: 3,
      blocking_severities: ["critical", "high"],
    },
    parallel: { kind: "parallel" },
    join: { kind: "join", mode: "all" },
    compare: { kind: "compare", judge: "user", judge_profile_id: null, criteria: DEFAULT_CRITERIA, run_gates: ["build_test"] },
    condition: { kind: "condition", expression: "", max_loops: 3 },
    synthesis: {
      kind: "synthesis",
      profile_id: null,
      provider,
      model: null,
      devil_advocate: true,
      prompt_template: "",
      output_format: "decision",
      propose_memory: true,
    },
    merge: { kind: "merge", target_ref: null, strategy: "squash", require_approval: true, resolve_conflicts_with_agent: true },
    git: {
      kind: "git",
      action: "open_pr",
      base_ref: null,
      draft: false,
      title_template: "{{ task.title }}",
      body_template: null,
      watch: true,
      autofix: true,
      push_branch_template: null,
    },
    deploy: { kind: "deploy", profile_id: "" },
    human: { kind: "human", instructions: "", input_schema: null },
  };
  return structuredClone(configs[kind]) as ConfigOf<K>;
}

/** Fill missing fields from the defaults (graphs from studios/YAML may omit optional fields). */
export function normalizeConfig(config: Partial<NodeConfig> & { kind: NodeKind }): NodeConfig {
  const base = defaultConfig(config.kind) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(config)) if (v !== undefined) out[k] = v;
  if (config.kind === "agent") {
    const b = (config as Partial<AgentNodeConfig>).boundaries;
    out.boundaries = b ? { ...defaultBoundaries(), ...b } : null;
  }
  return out as unknown as NodeConfig;
}

export function defaultSettings(): FlowSettings {
  return {
    gates: { plan_approval: true, boundary_check: true, build_test: true, cross_review: true, user_final: true },
    budget: { max_five_hour_percent: null, max_weekly_percent: null, max_duration_minutes: null, max_turns: null },
    limit_policy: { on_exhausted: "queue" },
    max_parallel_agents: 4,
    checkpoint_every_node: true,
  };
}

export function normalizeSettings(settings: Partial<FlowSettings> | undefined | null): FlowSettings {
  const d = defaultSettings();
  if (!settings) return d;
  return {
    gates: { ...d.gates, ...(settings.gates ?? {}) },
    budget: { ...d.budget, ...(settings.budget ?? {}) },
    limit_policy: { ...d.limit_policy, ...(settings.limit_policy ?? {}) },
    max_parallel_agents: settings.max_parallel_agents ?? d.max_parallel_agents,
    checkpoint_every_node: settings.checkpoint_every_node ?? d.checkpoint_every_node,
  };
}

export function isModelConfig(config: NodeConfig): config is ModelConfig {
  return config.kind === "agent" || config.kind === "advisor" || config.kind === "synthesis";
}

/** Kinds that run under the pass/fail/approve outcome model (engine validation _PASS_FAIL_SOURCES). */
const PASS_FAIL_SOURCES: ReadonlySet<NodeKind> = new Set(["gate", "human", "compare", "merge", "deploy", "git"]);

/** Edge conditions offered when connecting out of a node of this kind (first = suggested). */
export function conditionsFor(kind: NodeKind): EdgeCondition[] {
  if (kind === "condition") return ["true", "false", "default"];
  if (PASS_FAIL_SOURCES.has(kind)) return ["default", "failed", "passed", "approved", "rejected"];
  return ["default", "failed"];
}

/**
 * The condition suggested for a new edge out of `kind`, given the conditions its other outgoing
 * edges already use: a condition node offers "true" then "false"; a gate offers the pass path then
 * "failed" (the loop back to the author).
 */
export function suggestCondition(kind: NodeKind, existing: EdgeCondition[]): EdgeCondition {
  if (kind === "condition") return existing.includes("true") ? (existing.includes("false") ? "default" : "false") : "true";
  if (PASS_FAIL_SOURCES.has(kind)) return existing.some((c) => c === "default" || c === "passed" || c === "approved") ? "failed" : "default";
  return "default";
}

/** Default Turkish label for a new node (gates are named after their gate kind). */
export function defaultLabel(config: NodeConfig, gateLabel: (g: GateKind) => string): string {
  if (config.kind === "gate") return gateLabel(config.gate);
  return kindStrings[config.kind].label;
}

const NODE_ID = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function isValidNodeId(id: string): boolean {
  return NODE_ID.test(id);
}

/** Readable, template-friendly id: "agent", "agent_2", "gate_build_test"... */
export function nextNodeId(config: NodeConfig, taken: ReadonlySet<string>): string {
  const base = config.kind === "gate" ? `gate_${config.gate}` : config.kind;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}_${i}`;
    if (!taken.has(id)) return id;
  }
}
