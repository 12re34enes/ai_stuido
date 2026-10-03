/**
 * Team spec ⇄ org-chart graph. The spec is canonical; the chart (cards + links) is derived from
 * it with the tidy-tree layout, and positions flow back into the spec on save (`withPositions`).
 */
import type { TeamMember, TeamSpec } from "../types";
import type { TeamLayout } from "./layout";
import { indexTeam } from "./tree";

/**
 * delegate: manager → worker (work flows down, results up)
 * suite:    manager → independent tester (tests the integrated work)
 * test:     member → dependent tester ("test eder")
 * advise:   advisor ↔ member ("rapor/öneri")
 */
export type OrgEdgeKind = "delegate" | "suite" | "test" | "advise";

export interface OrgEdgeDesc {
  id: string;
  source: string;
  target: string;
  kind: OrgEdgeKind;
  sourceHandle: "b" | "r";
  targetHandle: "t" | "l";
  /** Satellite lane (2nd, 3rd… tester of the same member arcs over the closer ones). */
  lane: number;
}

export const edgeId = {
  delegate: (parent: string, child: string) => `d:${parent}>${child}`,
  suite: (parent: string, tester: string) => `s:${parent}>${tester}`,
  test: (member: string, tester: string) => `t:${member}>${tester}`,
  advise: (advisor: string, member: string) => `a:${advisor}>${member}`,
};

/** Every link of the chart, derived from the spec (broken references are skipped). */
export function orgEdges(spec: Pick<TeamSpec, "members">): OrgEdgeDesc[] {
  const idx = indexTeam(spec);
  const out: OrgEdgeDesc[] = [];
  const leadId = idx.lead?.id ?? null;
  for (const m of spec.members) {
    if (m.role === "worker" && m.parent_id && idx.byId.has(m.parent_id)) {
      out.push({ id: edgeId.delegate(m.parent_id, m.id), source: m.parent_id, target: m.id, kind: "delegate", sourceHandle: "b", targetHandle: "t", lane: 0 });
    }
  }
  for (const [anchor, testers] of idx.independentTesters) {
    if (!idx.byId.has(anchor)) continue;
    for (const t of testers) out.push({ id: edgeId.suite(anchor, t.id), source: anchor, target: t.id, kind: "suite", sourceHandle: "b", targetHandle: "t", lane: 0 });
  }
  for (const [anchor, testers] of idx.dependentTesters) {
    if (!idx.byId.has(anchor)) continue;
    testers.forEach((t, i) => out.push({ id: edgeId.test(anchor, t.id), source: anchor, target: t.id, kind: "test", sourceHandle: "r", targetHandle: "l", lane: i }));
  }
  for (const [anchor, advisors] of idx.advisors) {
    if (!idx.byId.has(anchor)) continue;
    for (const a of advisors) {
      const above = anchor === leadId;
      out.push({ id: edgeId.advise(a.id, anchor), source: a.id, target: anchor, kind: "advise", sourceHandle: above ? "b" : "r", targetHandle: above ? "t" : "l", lane: 0 });
    }
  }
  return out;
}

/** The delegation link that carries a member's work (manager → member), when there is one. */
export function incomingEdge(spec: Pick<TeamSpec, "members">, memberId: string): string | null {
  const m = spec.members.find((x) => x.id === memberId);
  if (!m?.parent_id) return null;
  if (m.role === "worker") return edgeId.delegate(m.parent_id, m.id);
  if (m.role === "tester") return m.test_mode === "dependent" ? edgeId.test(m.tests_member_id ?? m.parent_id, m.id) : edgeId.suite(m.parent_id, m.id);
  return null;
}

/** The link between two members, in either direction (delegate / suite / test / advise). */
export function edgeBetween(edges: readonly OrgEdgeDesc[], a: string, b: string): OrgEdgeDesc | null {
  return edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a)) ?? null;
}

/** Write layout positions into the spec (saved with the team for other viewers). */
export function withPositions(spec: TeamSpec, layout: Pick<TeamLayout, "positions">): TeamSpec {
  return {
    ...spec,
    members: spec.members.map((m): TeamMember => {
      const p = layout.positions.get(m.id);
      return p ? { ...m, position: { x: Math.round(p.x), y: Math.round(p.y) } } : m;
    }),
  };
}

/** Structural signature of a spec (layout-relevant fields only) — memo key for layouts. */
export function structureKey(spec: Pick<TeamSpec, "members">): string {
  return spec.members.map((m) => `${m.id}:${m.role}:${m.parent_id ?? ""}:${m.tests_member_id ?? ""}:${m.test_mode}`).join("|");
}
