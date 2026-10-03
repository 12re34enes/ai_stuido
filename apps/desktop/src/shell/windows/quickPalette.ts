/**
 * Quick palette (global ⌃⌥Space window) result model: pure, unit-tested in quickPalette.test.ts.
 * Results execute in the main window via `showMainWindow(route)`; the palette then dismisses.
 */
import { fuzzyScore } from "@/lib/fuzzy";
import type { Approval } from "@/lib/types";

import { windowStrings } from "./strings";

export type TaskMode = "single" | "duo" | "race" | "pipeline" | "council" | "team";
export const TASK_MODES: TaskMode[] = ["single", "duo", "race", "pipeline", "council", "team"];

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  mode: string;
  updated_at: string;
}

export interface PageEntry {
  id: string;
  label: string;
  path: string;
  keywords?: string[];
}

export type PaletteItem =
  | { kind: "new-task"; id: string; title: string; prompt: string }
  | { kind: "approval"; id: string; title: string; subtitle: string; route: string; production: boolean }
  | { kind: "task"; id: string; title: string; subtitle: string; route: string }
  | { kind: "page"; id: string; title: string; route: string; pageId: string };

export interface PaletteSection {
  group: keyof typeof windowStrings.palette.groups;
  items: PaletteItem[];
}

const p = windowStrings.palette;

export function nextMode(mode: TaskMode, step: 1 | -1 = 1): TaskMode {
  const i = TASK_MODES.indexOf(mode);
  return TASK_MODES[(i + step + TASK_MODES.length) % TASK_MODES.length] ?? "duo";
}

/** Task title from a prompt: the first line, trimmed to ~80 characters on a word boundary. */
export function taskTitle(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  const space = cut.lastIndexOf(" ");
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function rank<T>(items: T[], query: string, fields: (t: T) => (string | undefined)[], limit: number): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((t) => ({ t, score: fuzzyScore(query, fields(t)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.t);
}

/** Build the palette sections for a query. Empty query: new task, approvals, recent tasks, pages. */
export function buildPaletteSections(input: { query: string; approvals: Approval[]; tasks: TaskSummary[]; pages: PageEntry[]; kindLabel: (a: Approval) => string }): PaletteSection[] {
  const q = input.query.trim();
  const sections: PaletteSection[] = [];
  sections.push({
    group: "actions",
    items: [{ kind: "new-task", id: "new-task", title: q ? p.newTaskWith(taskTitle(q)) : p.newTask, prompt: q }],
  });
  const approvals = rank(input.approvals, q, (a) => [a.title, a.summary ?? "", input.kindLabel(a)], 4).map<PaletteItem>((a) => ({
    kind: "approval",
    id: `approval:${a.id}`,
    title: a.title,
    subtitle: input.kindLabel(a),
    route: `/approvals/${encodeURIComponent(a.id)}`,
    production: a.production,
  }));
  if (approvals.length) sections.push({ group: "approvals", items: approvals });
  const tasks = rank(input.tasks, q, (t) => [t.title], 5).map<PaletteItem>((t) => ({
    kind: "task",
    id: `task:${t.id}`,
    title: t.title,
    subtitle: p.taskStatus[t.status] ?? t.status,
    route: `/tasks/${encodeURIComponent(t.id)}`,
  }));
  if (tasks.length) sections.push({ group: "tasks", items: tasks });
  const pages = rank(input.pages, q, (pg) => [pg.label, ...(pg.keywords ?? [])], q ? 4 : 8).map<PaletteItem>((pg) => ({
    kind: "page",
    id: `page:${pg.id}`,
    title: pg.label,
    route: pg.path,
    pageId: pg.id,
  }));
  if (pages.length) sections.push({ group: "pages", items: pages });
  return sections;
}

export function flatItems(sections: PaletteSection[]): PaletteItem[] {
  return sections.flatMap((s) => s.items);
}

/** Move the selection by `delta`, wrapping around. */
export function moveSelection(items: PaletteItem[], currentId: string | null, delta: number): string | null {
  if (items.length === 0) return null;
  const i = items.findIndex((x) => x.id === currentId);
  const next = i === -1 ? (delta > 0 ? 0 : items.length - 1) : (i + delta + items.length) % items.length;
  return items[next]?.id ?? null;
}
