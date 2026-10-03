/**
 * Pure helpers that read a studio's graph: who is on the team, which gates guard it, how to lay
 * the nodes out when the YAML has no positions, and what the run's final node outputs are.
 */
import type { Provider } from "@/lib/types";

import { gateLabels, nodeKindLabels, roleLabels } from "./strings";
import type { FlowEdge, FlowGraph, FlowNode, GateKind, NodeKind, Studio } from "./types";

// ----------------------------------------------------------------------------- team

export interface TeamMember {
  nodeId: string;
  label: string;
  kind: NodeKind;
  provider: Provider | null;
  /** Turkish role line: "Yazar", "Danışman · karşı tez", "Sentez". */
  role: string;
}

const TEAM_KINDS = new Set<NodeKind>(["agent", "advisor", "synthesis"]);

function firstClause(text: string, max = 48): string {
  const clause = text.split(/[;.]/)[0]?.trim() ?? "";
  return clause.length > max ? `${clause.slice(0, max - 1).trimEnd()}…` : clause;
}

export function memberRole(node: FlowNode): string {
  const c = node.config;
  if (c.kind === "agent") return roleLabels[c.role ?? "writer"] ?? roleLabels.writer!;
  if (c.kind === "advisor") {
    const p = typeof c.perspective === "string" ? firstClause(c.perspective) : "";
    return p ? `${roleLabels.advisor} · ${p}` : roleLabels.advisor!;
  }
  if (c.kind === "synthesis") return nodeKindLabels.synthesis!;
  return nodeKindLabels[c.kind] ?? c.kind;
}

/** Agent-like nodes in graph order. */
export function studioTeam(graph: FlowGraph | undefined): TeamMember[] {
  return (graph?.nodes ?? [])
    .filter((n) => TEAM_KINDS.has(n.config?.kind))
    .map((n) => ({
      nodeId: n.id,
      label: n.label,
      kind: n.config.kind,
      provider: n.config.provider === "claude" || n.config.provider === "codex" ? n.config.provider : null,
      role: memberRole(n),
    }));
}

/** Provider headcount for the card's stacked marks: [{provider, count}], Claude first. */
export function teamProviders(team: TeamMember[]): { provider: Provider; count: number }[] {
  const counts = new Map<Provider, number>();
  for (const m of team) if (m.provider) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  return (["claude", "codex"] as const).filter((p) => counts.has(p)).map((p) => ({ provider: p, count: counts.get(p)! }));
}

// ----------------------------------------------------------------------------- gates

export interface GateSummary {
  kind: GateKind;
  label: string;
  count: number;
  /** deploy_approval cannot be switched off for production targets. */
  locked: boolean;
}

const TOGGLEABLE = new Set(["plan_approval", "boundary_check", "build_test", "cross_review", "user_final"]);

/** Gate kinds present in the graph (skipping ones the flow settings switch off), in node order. */
export function studioGates(graph: FlowGraph | undefined): GateSummary[] {
  const toggles = (graph?.settings?.gates ?? {}) as Record<string, boolean | undefined>;
  const out = new Map<GateKind, GateSummary>();
  for (const n of graph?.nodes ?? []) {
    if (n.config?.kind !== "gate" || !n.config.gate) continue;
    const kind = n.config.gate;
    if (TOGGLEABLE.has(kind) && toggles[kind] === false) continue;
    const prev = out.get(kind);
    if (prev) prev.count++;
    else out.set(kind, { kind, label: gateLabels[kind] ?? kind, count: 1, locked: kind === "deploy_approval" });
  }
  return [...out.values()];
}

/** Steps a person would count: everything except pure control nodes. */
export function stepCount(graph: FlowGraph | undefined): number {
  return (graph?.nodes ?? []).filter((n) => !["parallel", "join", "condition"].includes(n.config?.kind)).length;
}

// ----------------------------------------------------------------------------- layout

export interface Point {
  x: number;
  y: number;
}

export const LAYOUT_STEP_X = 300;
export const LAYOUT_STEP_Y = 150;

const LOOP_CONDITIONS = new Set(["failed", "false", "rejected"]);

/** Edges that close a cycle back to an earlier node (review → writer). Mirrors studios/validation.py. */
export function loopBackEdges(graph: FlowGraph): Set<string> {
  const ids = new Set(graph.nodes.map((n) => n.id));
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue;
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const reaches = (start: string, goal: string) => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === goal) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(adj.get(cur) ?? []));
    }
    return false;
  };
  return new Set(graph.edges.filter((e) => LOOP_CONDITIONS.has(e.condition ?? "default") && reaches(e.target, e.source)).map((e) => e.id));
}

/**
 * Node positions for the preview. Uses the YAML positions when every node has one; otherwise a
 * layered layout (longest path from the entry nodes, ignoring loop-back edges), centered per layer.
 */
export function layoutGraph(graph: FlowGraph): Map<string, Point> {
  const out = new Map<string, Point>();
  if (graph.nodes.length > 0 && graph.nodes.every((n) => n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y))) {
    for (const n of graph.nodes) out.set(n.id, { x: n.position!.x, y: n.position!.y });
    return out;
  }
  const loops = loopBackEdges(graph);
  const forward: FlowEdge[] = graph.edges.filter((e) => !loops.has(e.id));
  const depth = new Map<string, number>(graph.nodes.map((n) => [n.id, 0]));
  // Longest-path relaxation; bounded by node count so stray cycles cannot loop forever.
  for (let round = 0; round < graph.nodes.length; round++) {
    let changed = false;
    for (const e of forward) {
      const d = (depth.get(e.source) ?? 0) + 1;
      if (depth.has(e.target) && d > (depth.get(e.target) ?? 0)) {
        depth.set(e.target, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const layers = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.id) ?? 0;
    layers.set(d, [...(layers.get(d) ?? []), n.id]);
  }
  for (const [d, ids] of layers) {
    ids.forEach((id, i) => out.set(id, { x: d * LAYOUT_STEP_X, y: (i - (ids.length - 1) / 2) * LAYOUT_STEP_Y }));
  }
  return out;
}

// ----------------------------------------------------------------------------- preview viewport

/** Below this zoom node text is unreadable: show the start of the flow at a readable size instead. */
export const READABLE_ZOOM = 0.62;
const EDGE_PAD = 28;
/** Rendered node sizes (FlowNodeCard is 220px wide; control pills are shorter). */
const CARD = { w: 220, h: 64 };
const PILL = { w: 170, h: 40 };

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boundsOf(nodes: { type?: string; position: { x: number; y: number } }[]): Bounds | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const size = n.type === "control" ? PILL : CARD;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + size.w);
    maxY = Math.max(maxY, n.position.y + size.h);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Viewport for `bounds` in a `w`×`h` box: fit everything, or (when that is unreadable) the start at a readable zoom. */
export function previewViewport(bounds: Bounds, w: number, h: number, fitAll: boolean): { x: number; y: number; zoom: number; overflow: boolean } {
  const fitZoom = Math.min(1, (w - EDGE_PAD * 2) / Math.max(1, bounds.width), (h - EDGE_PAD * 2) / Math.max(1, bounds.height));
  const overflow = fitZoom < READABLE_ZOOM;
  const cy = bounds.y + bounds.height / 2;
  if (!overflow || fitAll) {
    const zoom = Math.max(0.1, fitZoom);
    return { x: w / 2 - (bounds.x + bounds.width / 2) * zoom, y: h / 2 - cy * zoom, zoom, overflow };
  }
  const zoom = Math.min(READABLE_ZOOM, (h - EDGE_PAD * 2) / Math.max(1, bounds.height));
  return { x: EDGE_PAD - bounds.x * zoom, y: h / 2 - cy * zoom, zoom, overflow };
}

// ----------------------------------------------------------------------------- outputs

/** Nodes whose text output can be the studio's final document, latest in graph order first. */
const OUTPUT_KINDS = new Set<NodeKind>(["synthesis", "agent", "advisor", "compare"]);

export function finalOutputNodeIds(graph: FlowGraph): string[] {
  return graph.nodes
    .filter((n) => OUTPUT_KINDS.has(n.config?.kind))
    .map((n) => n.id)
    .reverse();
}

/** The eight built-in studio ids, in gallery order (mirrors backend studios/loader.py BUILTIN_ORDER). */
export const BUILTIN_IDS = ["architecture", "market-analysis", "design", "database", "code-review", "debugging", "documentation", "proposal"] as const;

export function isBuiltinId(id: string): boolean {
  return (BUILTIN_IDS as readonly string[]).includes(id);
}

/** Split the list into built-ins (incl. edited ones) and the user's own studios. */
export function groupStudios(studios: Studio[]): { builtin: Studio[]; custom: Studio[] } {
  const builtin = studios.filter((s) => s.builtin === true || isBuiltinId(s.id));
  const custom = studios.filter((s) => !builtin.includes(s));
  return { builtin, custom };
}

// ----------------------------------------------------------------------------- slugs

const TR_MAP: Record<string, string> = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", Ö: "o", Ş: "s", Ü: "u" };

/** "Güvenlik denetimi" → "guvenlik-denetimi" (matches the backend's studio id rule). */
export function slugify(name: string): string {
  return name
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => TR_MAP[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
}

export const STUDIO_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
