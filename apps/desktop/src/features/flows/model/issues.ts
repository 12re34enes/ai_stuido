/** Maps a ValidationReport onto canvas elements (inline markers) and a sorted issue list. */
import type { ValidationIssue, ValidationReport } from "../types";

export type IssueLevel = "error" | "warning";

export interface CanvasIssue extends ValidationIssue {
  level: IssueLevel;
}

export interface IssueIndex {
  byNode: Record<string, CanvasIssue[]>;
  byEdge: Record<string, CanvasIssue[]>;
  /** Issues not attached to an element (or attached to one that no longer exists). */
  global: CanvasIssue[];
  errorCount: number;
  warningCount: number;
  /** Errors first, then warnings; flow-level first inside each level. */
  all: CanvasIssue[];
}

export const EMPTY_INDEX: IssueIndex = { byNode: {}, byEdge: {}, global: [], errorCount: 0, warningCount: 0, all: [] };

export function indexIssues(
  report: ValidationReport | null,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>,
): IssueIndex {
  if (!report) return EMPTY_INDEX;
  const byNode: Record<string, CanvasIssue[]> = {};
  const byEdge: Record<string, CanvasIssue[]> = {};
  const global: CanvasIssue[] = [];
  const all: CanvasIssue[] = [
    ...report.errors.map((e) => ({ ...e, level: "error" as const })),
    ...report.warnings.map((w) => ({ ...w, level: "warning" as const })),
  ];
  for (const issue of all) {
    let placed = false;
    // An edge issue marks the edge; the node it names (the source) gets the marker too.
    if (issue.edge_id && edgeIds.has(issue.edge_id)) {
      (byEdge[issue.edge_id] ??= []).push(issue);
      placed = true;
    }
    if (issue.node_id && nodeIds.has(issue.node_id) && !issue.edge_id) {
      (byNode[issue.node_id] ??= []).push(issue);
      placed = true;
    }
    if (!placed) global.push(issue);
  }
  const rank = (i: CanvasIssue) => (i.level === "error" ? 0 : 2) + (i.node_id || i.edge_id ? 1 : 0);
  return {
    byNode,
    byEdge,
    global,
    errorCount: report.errors.length,
    warningCount: report.warnings.length,
    all: [...all].sort((a, b) => rank(a) - rank(b)),
  };
}

/** Worst level of a list of issues (for marker color), or null. */
export function worstLevel(issues: readonly CanvasIssue[] | undefined): IssueLevel | null {
  if (!issues?.length) return null;
  return issues.some((i) => i.level === "error") ? "error" : "warning";
}

/** Turn a task-start / save 422 payload (`details.errors`) back into a report, when it has one. */
export function reportFromErrorDetails(details: Record<string, unknown> | undefined): ValidationReport | null {
  const errors = details?.errors;
  if (!Array.isArray(errors)) return null;
  const issues = errors.filter(
    (e): e is ValidationIssue => !!e && typeof e === "object" && typeof (e as ValidationIssue).message === "string" && "code" in e,
  );
  if (!issues.length) return null;
  return { ok: false, errors: issues.map((i) => ({ ...i, node_id: i.node_id ?? null, edge_id: i.edge_id ?? null })), warnings: [] };
}
