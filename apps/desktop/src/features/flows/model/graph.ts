/**
 * FlowGraph (backend contract) ⇄ @xyflow/react nodes/edges.
 *
 * The canvas edits xyflow objects (so unchanged nodes keep their identity and don't re-render);
 * the contract graph is produced at the boundaries: save, validate, undo snapshots, tests.
 */
import type { Edge, Node } from "@xyflow/react";

import { LOOP_CONDITIONS, type EdgeCondition, type FlowEdge, type FlowGraph, type FlowNode, type FlowSettings, type NodeConfig } from "../types";
import { normalizeConfig, normalizeSettings } from "./kinds";
import { autoLayout, loopLanes } from "./layout";
import { buildTopology, layers } from "./topology";

export interface FlowNodeData extends Record<string, unknown> {
  label: string;
  config: NodeConfig;
}

export type CanvasNode = Node<FlowNodeData, "flow">;

export interface FlowEdgeData extends Record<string, unknown> {
  condition: EdgeCondition;
  /** Back edge that closes a cycle (routes under the nodes). */
  loop: boolean;
  /** Loop lane: 1 = closest to the nodes. */
  lane: number;
}

export type CanvasEdge = Edge<FlowEdgeData, "flow">;

export interface GraphToCanvasOptions {
  /** Re-run auto-layout for every node (templates), not only nodes without a position. */
  relayout?: boolean;
}

export function graphToCanvas(graph: FlowGraph, opts: GraphToCanvasOptions = {}): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const ids = graph.nodes.map((n) => n.id);
  const missing = graph.nodes.some((n) => !n.position);
  const layout = opts.relayout || missing ? autoLayout(ids, graph.edges) : null;
  const nodes: CanvasNode[] = graph.nodes.map((n) => {
    const pos = opts.relayout || !n.position ? layout?.positions.get(n.id) : n.position;
    return {
      id: n.id,
      type: "flow",
      position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
      data: { label: n.label, config: normalizeConfig(n.config) },
    };
  });
  const edges: CanvasEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "flow",
    data: { condition: e.condition ?? "default", loop: false, lane: 1 },
  }));
  return { nodes, edges: decorateEdges(nodes, edges) };
}

export function canvasToGraph(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  rest: { settings: FlowSettings; inputs: Record<string, unknown> },
): FlowGraph {
  const flowNodes: FlowNode[] = nodes.map((n) => ({
    id: n.id,
    label: n.data.label,
    config: n.data.config,
    position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
  }));
  const flowEdges: FlowEdge[] = edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    condition: e.data?.condition ?? "default",
  }));
  return { nodes: flowNodes, edges: flowEdges, settings: normalizeSettings(rest.settings), inputs: rest.inputs };
}

/** Recompute loop flags and lanes; edges whose decoration is unchanged keep their identity. */
export function decorateEdges(nodes: readonly CanvasNode[], edges: CanvasEdge[]): CanvasEdge[] {
  const topoEdges = edges.map((e) => ({ id: e.id, source: e.source, target: e.target, condition: e.data?.condition ?? "default" }));
  const topology = buildTopology(
    nodes.map((n) => n.id),
    topoEdges,
  );
  const lanes = loopLanes(topology, layers(topology));
  return edges.map((e) => {
    const loop = topology.backEdges.has(e.id) && LOOP_CONDITIONS.has(e.data?.condition ?? "default");
    const lane = lanes.get(e.id) ?? 1;
    const condition = e.data?.condition ?? "default";
    if (e.data && e.data.loop === loop && e.data.lane === lane && e.data.condition === condition) return e;
    return { ...e, data: { condition, loop, lane } };
  });
}

/** Edge id like the backend's mode templates: e_<source>_<target>[_<condition>], made unique. */
export function makeEdgeId(source: string, target: string, condition: EdgeCondition, taken: ReadonlySet<string>): string {
  const base = `e_${source}_${target}${condition === "default" ? "" : `_${condition}`}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const id = `${base}_${i}`;
    if (!taken.has(id)) return id;
  }
}

/** Replace node references inside templates when a node is renamed (nodes.<id>, gate.<id>). */
export function renameInTemplate(template: string, from: string, to: string): string {
  const pattern = new RegExp(`\\b(nodes|gate)\\.${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  return template.replace(pattern, (_m, scope: string) => `${scope}.${to}`);
}

/** Apply a node rename to a config: templates and gate targets. */
export function renameInConfig(config: NodeConfig, from: string, to: string): NodeConfig {
  const r = (t: string) => renameInTemplate(t, from, to);
  switch (config.kind) {
    case "agent":
    case "advisor":
      return { ...config, prompt_template: r(config.prompt_template) };
    case "synthesis":
    case "team":
      return { ...config, prompt_template: r(config.prompt_template) };
    case "condition":
      return { ...config, expression: r(config.expression) };
    case "git":
      return {
        ...config,
        title_template: r(config.title_template),
        body_template: config.body_template === null ? null : r(config.body_template),
        push_branch_template: config.push_branch_template === null ? null : r(config.push_branch_template),
      };
    case "gate":
      return config.target_node_id === from ? { ...config, target_node_id: to } : config;
    default:
      return config;
  }
}

/** Drop references to removed nodes (gate targets) so a delete leaves a consistent graph. */
export function forgetNodeInConfig(config: NodeConfig, removed: ReadonlySet<string>): NodeConfig {
  if (config.kind === "gate" && config.target_node_id && removed.has(config.target_node_id)) return { ...config, target_node_id: null };
  return config;
}
