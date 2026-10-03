/**
 * Team spec defaults (identical to the pydantic defaults in contracts/teams.py), normalization of
 * possibly-partial server payloads, readable member ids, effort levels and the summary row.
 */
import { uiStrings } from "@/ui/strings";

import { roleStrings, s } from "../strings";
import type { Provider, TeamMember, TeamRole, TeamSettings, TeamSpec, TestMode } from "../types";

export function defaultSettings(): TeamSettings {
  return {
    report_mode: "each_assignment",
    report_interval_minutes: 15,
    max_parallel_members: 4,
    max_depth: 4,
    max_assignments: 40,
    test_max_rounds: 2,
    independent_tests_trigger: "at_end",
    merge_strategy: "merge",
  };
}

const ROLE_NAMES: Record<TeamRole, string> = {
  advisor: "Danışman",
  lead: "Lider",
  worker: "Geliştirici",
  tester: "Test ajanı",
};

/** A member with contract defaults (testers and advisors don't write by default). */
export function defaultMember(role: TeamRole, id: string, over: Partial<TeamMember> = {}): TeamMember {
  return {
    id,
    name: ROLE_NAMES[role],
    role,
    parent_id: null,
    provider: "claude",
    model: null,
    effort: null,
    profile_id: null,
    instructions: "",
    writes: role === "lead" || role === "worker",
    tests_member_id: null,
    test_mode: "dependent",
    test_command: null,
    boundaries: null,
    position: null,
    ...over,
  };
}

/** Starting point of "Yeni ekip": just the lead. */
export function defaultTeamSpec(): TeamSpec {
  return { members: [defaultMember("lead", "lead")], settings: defaultSettings() };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const isRole = (v: unknown): v is TeamRole => v === "advisor" || v === "lead" || v === "worker" || v === "tester";

/** Fill missing fields of a member coming from the server / YAML. */
export function normalizeMember(raw: Partial<TeamMember> & Record<string, unknown>, index = 0): TeamMember {
  const role: TeamRole = isRole(raw.role) ? raw.role : "worker";
  const id = str(raw.id) ?? `member-${index + 1}`;
  const base = defaultMember(role, id);
  const testMode: TestMode = raw.test_mode === "independent" ? "independent" : "dependent";
  const provider: Provider = raw.provider === "codex" ? "codex" : "claude";
  return {
    ...base,
    name: str(raw.name) ?? base.name,
    parent_id: str(raw.parent_id),
    provider,
    model: str(raw.model),
    effort: str(raw.effort),
    profile_id: str(raw.profile_id),
    instructions: typeof raw.instructions === "string" ? raw.instructions : "",
    writes: role === "advisor" ? false : typeof raw.writes === "boolean" ? raw.writes : base.writes,
    tests_member_id: str(raw.tests_member_id),
    test_mode: testMode,
    test_command: str(raw.test_command),
    boundaries: raw.boundaries && typeof raw.boundaries === "object" ? (raw.boundaries as TeamMember["boundaries"]) : null,
    position:
      raw.position && typeof raw.position === "object" && typeof (raw.position as { x?: unknown }).x === "number"
        ? { x: (raw.position as { x: number }).x, y: num((raw.position as { y?: unknown }).y, 0) }
        : null,
  };
}

export function normalizeSettings(raw: Partial<TeamSettings> | null | undefined): TeamSettings {
  const d = defaultSettings();
  if (!raw) return d;
  return {
    report_mode: raw.report_mode === "on_demand" || raw.report_mode === "periodic" ? raw.report_mode : d.report_mode,
    report_interval_minutes: num(raw.report_interval_minutes, d.report_interval_minutes),
    max_parallel_members: num(raw.max_parallel_members, d.max_parallel_members),
    max_depth: num(raw.max_depth, d.max_depth),
    max_assignments: num(raw.max_assignments, d.max_assignments),
    test_max_rounds: num(raw.test_max_rounds, d.test_max_rounds),
    independent_tests_trigger: raw.independent_tests_trigger === "after_each_merge" ? "after_each_merge" : "at_end",
    merge_strategy: raw.merge_strategy === "squash" ? "squash" : "merge",
  };
}

/** Normalize a spec from anywhere (server, YAML, an older version). */
export function normalizeSpec(raw: Partial<TeamSpec> | null | undefined): TeamSpec {
  const members = Array.isArray(raw?.members) ? raw.members.map((m, i) => normalizeMember(m as TeamMember & Record<string, unknown>, i)) : [];
  return { members, settings: normalizeSettings(raw?.settings) };
}

// ----------------------------------------------------------------------------- ids

const TR_MAP: Record<string, string> = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", Ö: "o", Ş: "s", Ü: "u" };

/** "Arayüz geliştirici" → "arayuz-gelistirici". */
export function slugify(text: string): string {
  return text
    .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => TR_MAP[c] ?? c)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const ID_BASE: Record<TeamRole, string> = { advisor: "advisor", lead: "lead", worker: "dev", tester: "qa" };

/** A readable id not taken yet: "dev-1", "dev-1-2", "qa-1"… */
export function nextMemberId(role: TeamRole, taken: ReadonlySet<string>, parentId?: string | null): string {
  const base = role === "worker" && parentId && parentId !== "lead" ? parentId : ID_BASE[role];
  for (let i = 1; ; i++) {
    const id = `${base}-${i}`;
    if (!taken.has(id)) return id;
  }
}

/** Name for a new member: "Geliştirici 2", "Test ajanı 1". */
export function nextMemberName(role: TeamRole, members: readonly TeamMember[]): string {
  const base = ROLE_NAMES[role];
  if (role === "lead") return base;
  const used = new Set(members.map((m) => m.name));
  if (role === "advisor" && !used.has(base)) return base;
  for (let i = 1; ; i++) {
    const name = `${base} ${i}`;
    if (!used.has(name)) return name;
  }
}

// ----------------------------------------------------------------------------- effort

export interface EffortLevel {
  value: string;
  label: string;
  short: string;
}

export const EFFORTS: Record<Provider, EffortLevel[]> = {
  claude: [
    { value: "low", label: "Düşük", short: "Düşük" },
    { value: "medium", label: "Orta", short: "Orta" },
    { value: "high", label: "Yüksek", short: "Yüksek" },
    { value: "xhigh", label: "Çok yüksek", short: "Çok y." },
    { value: "max", label: "En yüksek", short: "En y." },
  ],
  codex: [
    { value: "minimal", label: "En az", short: "En az" },
    { value: "low", label: "Düşük", short: "Düşük" },
    { value: "medium", label: "Orta", short: "Orta" },
    { value: "high", label: "Yüksek", short: "Yüksek" },
  ],
};

/** Position of an effort on its provider's scale (1-based), or 0 when unknown / default. */
export function effortLevel(provider: Provider, effort: string | null | undefined): { index: number; of: number; label: string | null } {
  const list = EFFORTS[provider];
  const i = effort ? list.findIndex((e) => e.value === effort) : -1;
  return { index: i + 1, of: list.length, label: i >= 0 ? list[i]!.label : effort ?? null };
}

/** Keep an effort valid when the provider changes (closest level by relative position). */
export function mapEffort(effort: string | null, from: Provider, to: Provider): string | null {
  if (!effort || from === to) return effort;
  const a = EFFORTS[from];
  const b = EFFORTS[to];
  if (b.some((e) => e.value === effort)) return effort;
  const i = a.findIndex((e) => e.value === effort);
  if (i < 0) return null;
  const rel = a.length > 1 ? i / (a.length - 1) : 0;
  return b[Math.round(rel * (b.length - 1))]!.value;
}

// ----------------------------------------------------------------------------- summary

export interface TeamCounts {
  advisors: number;
  leads: number;
  workers: number;
  testers: number;
  claude: number;
  codex: number;
  total: number;
}

export function teamCounts(spec: Pick<TeamSpec, "members">): TeamCounts {
  const c: TeamCounts = { advisors: 0, leads: 0, workers: 0, testers: 0, claude: 0, codex: 0, total: spec.members.length };
  for (const m of spec.members) {
    if (m.role === "advisor") c.advisors++;
    else if (m.role === "lead") c.leads++;
    else if (m.role === "worker") c.workers++;
    else c.testers++;
    if (m.provider === "codex") c.codex++;
    else c.claude++;
  }
  return c;
}

export interface SummaryChip {
  key: string;
  label: string;
  tone: "neutral" | "claude" | "codex";
}

/** "1 danışman · 1 lider · 5 üye · 2 test · Claude ×4 · Codex ×3" as chips (zero counts left out). */
export function summaryChips(spec: Pick<TeamSpec, "members">): SummaryChip[] {
  const c = teamCounts(spec);
  const out: SummaryChip[] = [];
  if (c.advisors) out.push({ key: "advisors", label: s.summary.advisors(c.advisors), tone: "neutral" });
  if (c.leads) out.push({ key: "leads", label: s.summary.leads(c.leads), tone: "neutral" });
  if (c.workers) out.push({ key: "workers", label: s.summary.workers(c.workers), tone: "neutral" });
  if (c.testers) out.push({ key: "testers", label: s.summary.testers(c.testers), tone: "neutral" });
  if (c.claude) out.push({ key: "claude", label: s.summary.provider(uiStrings.providers.claude, c.claude), tone: "claude" });
  if (c.codex) out.push({ key: "codex", label: s.summary.provider(uiStrings.providers.codex, c.codex), tone: "codex" });
  return out;
}

export function summaryText(spec: Pick<TeamSpec, "members">): string {
  return summaryChips(spec)
    .map((c) => c.label)
    .join(" · ");
}

/** Role label of a member, "Lider", "Bağımlı test ajanı"… */
export function roleLabel(m: Pick<TeamMember, "role" | "test_mode">): string {
  if (m.role === "tester") return m.test_mode === "independent" ? "Bağımsız test ajanı" : "Bağımlı test ajanı";
  return roleStrings[m.role].label;
}

/** Short role label for cards: "Bağımlı test", "Danışman"… */
export function roleShort(m: Pick<TeamMember, "role" | "test_mode">): string {
  if (m.role === "tester") return m.test_mode === "independent" ? "Bağımsız test" : "Bağımlı test";
  return roleStrings[m.role].label;
}
