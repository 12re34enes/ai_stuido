/**
 * Structure of a team spec: the delegation tree (lead → workers), satellites (advisors, dependent
 * testers), grouped independent testers, depths, subtrees, and every structural edit the builder
 * makes (add, re-parent with validity rules, remove, duplicate). Pure functions over TeamSpec.
 */
import type { TeamMember, TeamRole, TeamSpec } from "../types";
import { defaultMember, nextMemberId, nextMemberName } from "./spec";

export interface TeamIndex {
  byId: Map<string, TeamMember>;
  lead: TeamMember | null;
  /** Workers delegated to by a member (lead/worker), in spec order. */
  workers: Map<string, TeamMember[]>;
  /** Advisors attached to a member. */
  advisors: Map<string, TeamMember[]>;
  /** Dependent testers verifying a member. */
  dependentTesters: Map<string, TeamMember[]>;
  /** Independent testers grouped under a member. */
  independentTesters: Map<string, TeamMember[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The member a tester is attached to (dependent: its target, else its parent). */
export function testerAnchor(m: TeamMember): string | null {
  return m.test_mode === "dependent" ? (m.tests_member_id ?? m.parent_id) : m.parent_id;
}

export function indexTeam(spec: Pick<TeamSpec, "members">): TeamIndex {
  const byId = new Map(spec.members.map((m) => [m.id, m]));
  const idx: TeamIndex = {
    byId,
    lead: spec.members.find((m) => m.role === "lead") ?? null,
    workers: new Map(),
    advisors: new Map(),
    dependentTesters: new Map(),
    independentTesters: new Map(),
  };
  for (const m of spec.members) {
    if (m.role === "worker" && m.parent_id) push(idx.workers, m.parent_id, m);
    else if (m.role === "advisor" && m.parent_id) push(idx.advisors, m.parent_id, m);
    else if (m.role === "tester") {
      const anchor = testerAnchor(m);
      if (!anchor) continue;
      push(m.test_mode === "dependent" ? idx.dependentTesters : idx.independentTesters, anchor, m);
    }
  }
  return idx;
}

/** Members that can hold others (delegate, be advised, be tested). */
export function isManager(m: TeamMember | undefined | null): boolean {
  return !!m && (m.role === "lead" || m.role === "worker");
}

/**
 * Delegation depth: lead 0, its workers 1… Satellites take the depth of the member they attach to.
 * Broken references (missing parent / cycles) count as depth 1.
 */
export function depthMap(spec: Pick<TeamSpec, "members">): Map<string, number> {
  const idx = indexTeam(spec);
  const depth = new Map<string, number>();
  const visit = (id: string, trail: Set<string>): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const m = idx.byId.get(id);
    if (!m || trail.has(id)) return 1;
    trail.add(id);
    let d: number;
    if (m.role === "lead") d = 0;
    else if (m.role === "worker") d = m.parent_id && idx.byId.has(m.parent_id) ? visit(m.parent_id, trail) + 1 : 1;
    else {
      const anchor = m.role === "tester" ? testerAnchor(m) : m.parent_id;
      d = anchor && idx.byId.has(anchor) ? visit(anchor, trail) : 1;
    }
    trail.delete(id);
    depth.set(id, d);
    return d;
  };
  for (const m of spec.members) visit(m.id, new Set());
  return depth;
}

/** Ids of the workers below `id` (not including it), depth-first. */
export function descendantWorkers(idx: TeamIndex, id: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const walk = (pid: string) => {
    for (const w of idx.workers.get(pid) ?? []) {
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      out.push(w.id);
      walk(w.id);
    }
  };
  walk(id);
  return out;
}

/** Levels of workers below a member (0 = no workers under it). */
export function subtreeHeight(idx: TeamIndex, id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  seen.add(id);
  let h = 0;
  for (const w of idx.workers.get(id) ?? []) h = Math.max(h, 1 + subtreeHeight(idx, w.id, seen));
  return h;
}

/**
 * Everything that goes with a member when it is removed / duplicated: the member, the workers
 * below it, and the testers and advisors attached to any of them. Testers / advisors alone.
 */
export function subtreeIds(spec: Pick<TeamSpec, "members">, id: string): string[] {
  const idx = indexTeam(spec);
  const m = idx.byId.get(id);
  if (!m) return [];
  if (!isManager(m)) return [id];
  const core = new Set([id, ...descendantWorkers(idx, id)]);
  const out = [...core];
  for (const x of spec.members) {
    if (core.has(x.id)) continue;
    if (x.role === "tester" && core.has(testerAnchor(x) ?? "")) out.push(x.id);
    else if (x.role === "advisor" && core.has(x.parent_id ?? "")) out.push(x.id);
  }
  return out;
}

// ----------------------------------------------------------------------------- re-parent

export type ReparentCheck = { ok: true } | { ok: false; reason: string; noop?: boolean };

/** Whether `id` may be dropped onto `targetId` (the builder highlights valid drop targets). */
export function canReparent(spec: TeamSpec, id: string, targetId: string): ReparentCheck {
  const idx = indexTeam(spec);
  const m = idx.byId.get(id);
  const target = idx.byId.get(targetId);
  if (!m || !target) return { ok: false, reason: "Ajan bulunamadı." };
  if (id === targetId) return { ok: false, reason: "Bir ajan kendi üstüne taşınamaz.", noop: true };
  if (m.role === "lead") return { ok: false, reason: "Lider taşınamaz." };
  if (!isManager(target)) return { ok: false, reason: "Danışman ya da test ajanının altına taşınamaz." };

  if (m.role === "worker") {
    if (m.parent_id === targetId) return { ok: false, reason: "Zaten bu üyenin altında.", noop: true };
    if (descendantWorkers(idx, id).includes(targetId)) return { ok: false, reason: "Bir ajan kendi altındaki bir üyeye taşınamaz." };
    const depths = depthMap(spec);
    const newDepth = (depths.get(targetId) ?? 0) + 1 + subtreeHeight(idx, id);
    if (newDepth > spec.settings.max_depth) return { ok: false, reason: `En fazla derinlik (${spec.settings.max_depth}) aşılır.` };
    return { ok: true };
  }
  if (m.role === "advisor") {
    if (m.parent_id === targetId) return { ok: false, reason: "Zaten bu üyeye danışmanlık ediyor.", noop: true };
    if ((idx.advisors.get(targetId) ?? []).length > 0) return { ok: false, reason: "Bu üyenin zaten bir danışmanı var." };
    return { ok: true };
  }
  // tester
  if (testerAnchor(m) === targetId) return { ok: false, reason: m.test_mode === "dependent" ? "Zaten bu üyeyi test ediyor." : "Zaten bu üyenin altında.", noop: true };
  return { ok: true };
}

/** Apply a valid re-parent (callers check `canReparent` first; invalid moves return `spec`). */
export function reparent(spec: TeamSpec, id: string, targetId: string): TeamSpec {
  if (!canReparent(spec, id, targetId).ok) return spec;
  return {
    ...spec,
    members: spec.members.map((m) => {
      if (m.id !== id) return m;
      if (m.role === "tester" && m.test_mode === "dependent") return { ...m, parent_id: targetId, tests_member_id: targetId };
      return { ...m, parent_id: targetId };
    }),
  };
}

// ----------------------------------------------------------------------------- add / remove / duplicate

export type AddKind = "worker" | "dependent" | "independent" | "advisor";

/** The manager an add action from `anchorId` applies to (a tester/advisor defers to its anchor). */
export function addTarget(spec: Pick<TeamSpec, "members">, anchorId: string): TeamMember | null {
  const idx = indexTeam(spec);
  let m = idx.byId.get(anchorId) ?? null;
  for (let i = 0; m && !isManager(m) && i < 4; i++) {
    const next = m.role === "tester" ? testerAnchor(m) : m.parent_id;
    m = next ? (idx.byId.get(next) ?? null) : null;
  }
  return m;
}

export function canAdd(spec: TeamSpec, kind: AddKind, anchorId: string): ReparentCheck {
  const target = addTarget(spec, anchorId);
  if (!target) return { ok: false, reason: "Önce bir lider ya da üye seç." };
  if (kind === "worker") {
    const depth = depthMap(spec).get(target.id) ?? 0;
    if (depth + 1 > spec.settings.max_depth) return { ok: false, reason: `En fazla derinlik (${spec.settings.max_depth}) aşılır.` };
  }
  if (kind === "advisor" && (indexTeam(spec).advisors.get(target.id) ?? []).length > 0) return { ok: false, reason: "Bu üyenin zaten bir danışmanı var." };
  return { ok: true };
}

/** Position in `members` right after the last worker of `anchor`'s subtree (keeps spec order tidy). */
function insertIndex(spec: TeamSpec, anchorId: string): number {
  const ids = new Set([anchorId, ...descendantWorkers(indexTeam(spec), anchorId)]);
  let last = -1;
  spec.members.forEach((m, i) => {
    if (ids.has(m.id)) last = i;
  });
  return last < 0 ? spec.members.length : last + 1;
}

const ROLE_OF: Record<AddKind, TeamRole> = { worker: "worker", dependent: "tester", independent: "tester", advisor: "advisor" };

/** Add a member relative to `anchorId`; returns the new spec and id (null when not allowed). */
export function addMember(spec: TeamSpec, kind: AddKind, anchorId: string): { spec: TeamSpec; id: string } | null {
  if (!canAdd(spec, kind, anchorId).ok) return null;
  const target = addTarget(spec, anchorId)!;
  const role = ROLE_OF[kind];
  const taken = new Set(spec.members.map((m) => m.id));
  const id = nextMemberId(role, taken, kind === "worker" ? target.id : null);
  const other = target.provider === "claude" ? "codex" : "claude";
  const member = defaultMember(role, id, {
    name: nextMemberName(role, spec.members),
    parent_id: target.id,
    // Workers inherit their manager's provider; dependent testers default to the other provider
    // (cross-model verification), like the cross-review gate.
    provider: kind === "worker" ? target.provider : kind === "dependent" ? other : "claude",
    tests_member_id: kind === "dependent" ? target.id : null,
    test_mode: kind === "independent" ? "independent" : "dependent",
  });
  const at = insertIndex(spec, target.id);
  const members = [...spec.members.slice(0, at), member, ...spec.members.slice(at)];
  return { spec: { ...spec, members }, id };
}

/** Remove a member with everything that goes with it (the lead can't be removed). */
export function removeSubtree(spec: TeamSpec, id: string): { spec: TeamSpec; removed: string[] } {
  const m = spec.members.find((x) => x.id === id);
  if (!m || m.role === "lead") return { spec, removed: [] };
  const removed = subtreeIds(spec, id);
  const gone = new Set(removed);
  return { spec: { ...spec, members: spec.members.filter((x) => !gone.has(x.id)) }, removed };
}

export function canDuplicate(spec: Pick<TeamSpec, "members">, id: string): boolean {
  const m = spec.members.find((x) => x.id === id);
  return !!m && (m.role === "worker" || m.role === "tester");
}

/** Copy a worker (with its subtree) or a tester next to the original; returns the copy's root id. */
export function duplicateSubtree(spec: TeamSpec, id: string): { spec: TeamSpec; id: string } | null {
  if (!canDuplicate(spec, id)) return null;
  const ids = subtreeIds(spec, id);
  const inSet = new Set(ids);
  const taken = new Set(spec.members.map((m) => m.id));
  const rename = new Map<string, string>();
  const originals = spec.members.filter((m) => inSet.has(m.id));
  for (const m of originals) {
    const parent = m.parent_id ? (rename.get(m.parent_id) ?? m.parent_id) : null;
    const nid = nextMemberId(m.role, taken, m.role === "worker" ? parent : null);
    taken.add(nid);
    rename.set(m.id, nid);
  }
  const copies = originals.map((m) => ({
    ...structuredClone(m),
    id: rename.get(m.id)!,
    name: m.id === id ? `${m.name} (kopya)` : m.name,
    parent_id: m.parent_id ? (rename.get(m.parent_id) ?? m.parent_id) : null,
    tests_member_id: m.tests_member_id ? (rename.get(m.tests_member_id) ?? m.tests_member_id) : null,
    position: null,
  }));
  const at = insertIndex(spec, id);
  return { spec: { ...spec, members: [...spec.members.slice(0, at), ...copies, ...spec.members.slice(at)] }, id: rename.get(id)! };
}

/** Rename a member id everywhere it is referenced. */
export function renameMember(spec: TeamSpec, from: string, to: string): TeamSpec {
  if (from === to || spec.members.some((m) => m.id === to)) return spec;
  return {
    ...spec,
    members: spec.members.map((m) => ({
      ...m,
      id: m.id === from ? to : m.id,
      parent_id: m.parent_id === from ? to : m.parent_id,
      tests_member_id: m.tests_member_id === from ? to : m.tests_member_id,
    })),
  };
}

/**
 * Display order (lanes, lists): advisors of the lead, the lead, then depth-first: each member, its
 * advisors and dependent testers, its workers, its independent testers. Unreachable members last.
 */
export function treeOrder(spec: Pick<TeamSpec, "members">): string[] {
  const idx = indexTeam(spec);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (m: TeamMember) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    out.push(m.id);
  };
  const walk = (m: TeamMember) => {
    if (seen.has(m.id)) return;
    add(m);
    for (const a of idx.advisors.get(m.id) ?? []) add(a);
    for (const t of idx.dependentTesters.get(m.id) ?? []) add(t);
    for (const w of idx.workers.get(m.id) ?? []) walk(w);
    for (const t of idx.independentTesters.get(m.id) ?? []) add(t);
  };
  if (idx.lead) {
    for (const a of idx.advisors.get(idx.lead.id) ?? []) add(a);
    walk(idx.lead);
  }
  for (const m of spec.members) if (!seen.has(m.id)) walk(m);
  return out;
}
