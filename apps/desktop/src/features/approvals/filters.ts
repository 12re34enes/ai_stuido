/** Inbox ordering and filters: production first, then severity, then newest. */
import type { ApprovalKind, Severity } from "@/lib/types";

import type { ApprovalRecord } from "./api";

export interface ApprovalFilters {
  kind: ApprovalKind | null;
  workspaceId: string | null;
  severity: Severity | null;
}

export const NO_FILTERS: ApprovalFilters = { kind: null, workspaceId: null, severity: null };

const SEVERITY_RANK: Record<Severity, number> = { critical: 3, high: 2, normal: 1, info: 0 };

export function filterApprovals(list: readonly ApprovalRecord[], f: ApprovalFilters): ApprovalRecord[] {
  return list.filter(
    (a) => (!f.kind || a.kind === f.kind) && (!f.workspaceId || a.workspace_id === f.workspaceId) && (!f.severity || a.severity === f.severity),
  );
}

/** Pending inbox order. */
export function sortPending(list: readonly ApprovalRecord[]): ApprovalRecord[] {
  return [...list].sort(
    (a, b) =>
      Number(b.production) - Number(a.production) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      Date.parse(b.created_at) - Date.parse(a.created_at),
  );
}

/** Production approvals stand apart from the rest. */
export function splitProduction(list: readonly ApprovalRecord[]): { production: ApprovalRecord[]; other: ApprovalRecord[] } {
  return { production: list.filter((a) => a.production), other: list.filter((a) => !a.production) };
}

export function hasFilters(f: ApprovalFilters): boolean {
  return Boolean(f.kind || f.workspaceId || f.severity);
}

/** Next selection after `id` leaves the list (keyboard flow keeps its place). */
export function nextAfter(list: readonly ApprovalRecord[], id: string): string | null {
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return list[0]?.id ?? null;
  return list[i + 1]?.id ?? list[i - 1]?.id ?? null;
}

/** Kinds present in a list (filter menu shows only those). */
export function kindsIn(list: readonly ApprovalRecord[]): ApprovalKind[] {
  return [...new Set(list.map((a) => a.kind))];
}
