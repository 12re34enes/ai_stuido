/**
 * What every link of the live chart shows, derived from the live state: its color (the work on
 * it), the newest pulse travelling it (direction + tone), a speech bubble for reports / advice
 * and a merge-conflict badge. Pure — unit-tested.
 */
import type { LinkState, OrgEdgeData } from "../chart/OrgEdge";
import type { OrgEdgeDesc } from "../model/graph";
import type { TeamLiveState } from "../model/live";
import type { Assignment } from "../types";

function latestAssignment(state: TeamLiveState, from: string, to: string): Assignment | null {
  for (let i = state.order.length - 1; i >= 0; i--) {
    const a = state.assignments[state.order[i]!];
    if (a && a.to_member === to && a.from_member === from) return a;
  }
  return null;
}

export function linkState(state: TeamLiveState, e: OrgEdgeDesc): LinkState {
  if (e.kind === "test" || e.kind === "suite") {
    const v = state.tests[e.target];
    return !v ? "idle" : v.status === "passed" ? "done" : v.status === "running" ? "active" : "failed";
  }
  if (e.kind !== "delegate") return "idle";
  const a = latestAssignment(state, e.source, e.target);
  if (!a) return "idle";
  if (a.status === "running" || a.status === "testing") return "active";
  if (a.status === "completed") return "done";
  if (a.status === "failed") return "failed";
  return "idle";
}

export type EdgeLive = Pick<OrgEdgeData, "state" | "pulse" | "bubble" | "conflicts">;

export function edgeLiveData(state: TeamLiveState, names: ReadonlyMap<string, string>): Map<string, EdgeLive> {
  const out = new Map<string, EdgeLive>();
  const advisorEdge = (advisor: string) => state.edges.find((e) => e.kind === "advise" && e.source === advisor)?.id ?? null;
  for (const e of state.edges) {
    const merge = e.kind === "delegate" ? state.merges[e.target] : undefined;
    out.set(e.id, { state: linkState(state, e), conflicts: merge?.status === "conflict" ? (merge.conflicts.length ? merge.conflicts : ["—"]) : null, pulse: null, bubble: null });
  }
  for (const p of state.pulses) {
    let edgeId = p.edgeId;
    // A report from / advice to someone the advisor isn't linked to still lights the advisor's link.
    if (!edgeId && (p.kind === "report" || p.kind === "advice")) edgeId = advisorEdge(p.kind === "report" ? p.to : p.from);
    const cur = edgeId ? out.get(edgeId) : undefined;
    if (!edgeId || !cur) continue;
    const desc = state.edges.find((e) => e.id === edgeId)!;
    cur.pulse = { id: p.id, dir: p.from === desc.source ? "forward" : "back", tone: p.tone };
    if ((p.kind === "report" || p.kind === "advice" || p.kind === "handoff") && p.text) cur.bubble = { id: p.id, text: p.text, kind: p.kind, from: names.get(p.from) ?? p.from };
  }
  return out;
}

/** Latest pulse id arriving at each member (work, advice, a hand-off, a user message): the card flashes once per id. */
export function arrivals(state: TeamLiveState): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of state.pulses) if (p.kind === "delegate" || p.kind === "advice" || p.kind === "handoff" || p.kind === "message") out.set(p.to, p.id);
  return out;
}
