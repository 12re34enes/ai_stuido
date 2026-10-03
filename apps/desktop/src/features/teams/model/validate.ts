/**
 * Team validation: instant local checks (the rules of contracts/teams.py and §25) shown while the
 * server check (`POST /engine/teams/validate`) is on its way or unavailable, server report
 * parsing (defensive about field names) and the per-member issue index for inline markers.
 */
import type { TeamSpec, TeamValidationIssue, TeamValidationReport } from "../types";
import { depthMap, indexTeam, isManager, testerAnchor } from "./tree";

const issue = (code: string, message: string, member_id: string | null = null): TeamValidationIssue => ({ code, message, member_id });

export function validateTeamLocal(spec: TeamSpec): TeamValidationReport {
  const errors: TeamValidationIssue[] = [];
  const warnings: TeamValidationIssue[] = [];
  const idx = indexTeam(spec);
  const leads = spec.members.filter((m) => m.role === "lead");
  if (leads.length === 0) errors.push(issue("no_lead", "Ekipte bir lider olmalı."));
  if (leads.length > 1) for (const l of leads.slice(1)) errors.push(issue("many_leads", "Ekipte tam olarak bir lider olmalı.", l.id));

  const seen = new Set<string>();
  for (const m of spec.members) {
    if (seen.has(m.id)) errors.push(issue("duplicate_id", `"${m.id}" kimliği birden çok kez kullanılıyor.`, m.id));
    seen.add(m.id);
    if (!m.name.trim()) errors.push(issue("name_missing", "Ajanın bir adı olmalı.", m.id));
  }

  const depths = depthMap(spec);
  for (const m of spec.members) {
    if (m.role === "lead") {
      if (m.parent_id) warnings.push(issue("lead_parent", "Liderin yöneticisi olmaz; bu bağlantı yok sayılır.", m.id));
      if (!(idx.workers.get(m.id) ?? []).length) warnings.push(issue("lead_alone", "Liderin altında üye yok; lider işi tek başına yapar.", m.id));
      continue;
    }
    if (m.role === "worker") {
      const parent = m.parent_id ? idx.byId.get(m.parent_id) : undefined;
      if (!parent) errors.push(issue("parent_missing", "Üyenin bir yöneticisi olmalı.", m.id));
      else if (!isManager(parent)) errors.push(issue("parent_invalid", "Üyenin yöneticisi lider ya da başka bir üye olmalı.", m.id));
      const d = depths.get(m.id) ?? 0;
      if (d > spec.settings.max_depth) errors.push(issue("too_deep", `En fazla derinlik ${spec.settings.max_depth}; bu üye ${d}. seviyede.`, m.id));
      continue;
    }
    if (m.role === "advisor") {
      const target = m.parent_id ? idx.byId.get(m.parent_id) : undefined;
      if (!target) errors.push(issue("advisor_target", "Danışmanın danışmanlık edeceği üyeyi seç.", m.id));
      else if (!isManager(target)) errors.push(issue("advisor_target_invalid", "Danışman yalnız lidere ya da bir üyeye bağlanabilir.", m.id));
      if (m.writes) warnings.push(issue("advisor_writes", "Danışman kod yazmaz; yazma izni yok sayılır.", m.id));
      continue;
    }
    // tester
    const anchor = testerAnchor(m);
    const target = anchor ? idx.byId.get(anchor) : undefined;
    if (!target) errors.push(issue("tester_target", m.test_mode === "dependent" ? "Test ajanının test edeceği üyeyi seç." : "Test ajanının bağlı olduğu üyeyi seç.", m.id));
    else if (!isManager(target)) errors.push(issue("tester_target_invalid", "Test ajanı yalnız lidere ya da bir üyeye bağlanabilir.", m.id));
  }

  const workers = spec.members.filter((m) => m.role === "worker").length;
  if (spec.settings.max_parallel_members < 1) errors.push(issue("parallel_min", "En fazla eşzamanlı üye en az 1 olmalı."));
  else if (workers > 0 && spec.settings.max_parallel_members > 12) warnings.push(issue("parallel_high", "Çok sayıda eşzamanlı üye limitleri hızla doldurabilir."));
  if (spec.settings.report_mode === "periodic" && spec.settings.report_interval_minutes < 1) errors.push(issue("interval_min", "Rapor aralığı en az 1 dakika olmalı."));
  if (spec.settings.report_mode !== "on_demand" && !spec.members.some((m) => m.role === "advisor")) {
    warnings.push(issue("no_advisor", "Danışman yok; raporlar kimseye gitmez."));
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Parse a server report defensively (issues may name the member `member_id` or `node_id`). */
export function parseReport(raw: unknown): TeamValidationReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { ok?: unknown; errors?: unknown; warnings?: unknown };
  const list = (v: unknown): TeamValidationIssue[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { message?: unknown }).message === "string")
          .map((x) => ({
            code: typeof x.code === "string" ? x.code : "issue",
            message: x.message as string,
            member_id: typeof x.member_id === "string" ? x.member_id : typeof x.node_id === "string" ? x.node_id : null,
          }))
      : [];
  const errors = list(r.errors);
  const warnings = list(r.warnings);
  return { ok: typeof r.ok === "boolean" ? r.ok && errors.length === 0 : errors.length === 0, errors, warnings };
}

export type IssueLevel = "error" | "warning";

export interface IndexedIssue extends TeamValidationIssue {
  level: IssueLevel;
}

export interface TeamIssueIndex {
  byMember: Record<string, IndexedIssue[]>;
  global: IndexedIssue[];
  all: IndexedIssue[];
  errorCount: number;
  warningCount: number;
}

export const EMPTY_ISSUES: TeamIssueIndex = { byMember: {}, global: [], all: [], errorCount: 0, warningCount: 0 };

export function indexIssues(report: TeamValidationReport | null, memberIds: ReadonlySet<string>): TeamIssueIndex {
  if (!report) return EMPTY_ISSUES;
  const all: IndexedIssue[] = [...report.errors.map((e) => ({ ...e, level: "error" as const })), ...report.warnings.map((w) => ({ ...w, level: "warning" as const }))];
  const byMember: Record<string, IndexedIssue[]> = {};
  const global: IndexedIssue[] = [];
  for (const i of all) {
    if (i.member_id && memberIds.has(i.member_id)) (byMember[i.member_id] ??= []).push(i);
    else global.push(i);
  }
  return { byMember, global, all, errorCount: report.errors.length, warningCount: report.warnings.length };
}

export function worstLevel(issues: readonly IndexedIssue[] | undefined): IssueLevel | null {
  if (!issues?.length) return null;
  return issues.some((i) => i.level === "error") ? "error" : "warning";
}
