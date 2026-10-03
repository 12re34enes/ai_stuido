/** Memory documents grouped by layer for the navigation tree, plus actor/date helpers. */
import { memoryStrings as s } from "./strings";
import type { MemoryDoc, MemoryLayer } from "./types";

/** Display order of the layers (spec §10): facts, decisions, boundaries, session summaries. */
export const LAYER_ORDER: MemoryLayer[] = ["facts", "decisions", "boundaries", "sessions"];

export interface TreeItem {
  path: string;
  title: string;
  /** ISO date from a `YYYY-MM-DD-` file name prefix (decisions, sessions). */
  date: string | null;
  /** Folder guides (decisions/README.md) are shown but not counted. */
  guide: boolean;
}

export interface LayerGroup {
  layer: MemoryLayer;
  label: string;
  items: TreeItem[];
  /** Documents excluding guides. */
  count: number;
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

export function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function layerOf(path: string): MemoryLayer | null {
  if (path === "facts.md") return "facts";
  if (path === "boundaries.md") return "boundaries";
  if (path.startsWith("decisions/")) return "decisions";
  if (path.startsWith("sessions/")) return "sessions";
  return null;
}

export function isGuide(path: string): boolean {
  return fileName(path).toLowerCase() === "readme.md";
}

export function treeItem(doc: Pick<MemoryDoc, "path" | "title">): TreeItem {
  const date = DATE_PREFIX.exec(fileName(doc.path))?.[1] ?? null;
  const guide = isGuide(doc.path);
  return { path: doc.path, title: guide ? s.guide : doc.title || fileName(doc.path), date, guide };
}

/** Group docs by layer: dated documents newest first, guides last. Every layer appears. */
export function buildTree(docs: Pick<MemoryDoc, "path" | "title" | "layer">[]): LayerGroup[] {
  return LAYER_ORDER.map((layer) => {
    const items = docs
      .filter((d) => (d.layer ?? layerOf(d.path)) === layer)
      .map(treeItem)
      .sort((a, b) => {
        if (a.guide !== b.guide) return a.guide ? 1 : -1;
        if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date);
        if (!!a.date !== !!b.date) return a.date ? -1 : 1;
        return b.path.localeCompare(a.path);
      });
    return { layer, label: s.layers[layer] ?? layer, items, count: items.filter((i) => !i.guide).length };
  });
}

/** "agent:ses_1" → "agent"; "user" → "user"; unknown → "system". */
export function actorKind(actor: string | null | undefined): "user" | "agent" | "external" | "system" {
  if (!actor) return "system";
  if (actor === "user" || actor.startsWith("user")) return "user";
  if (actor.startsWith("agent:")) return "agent";
  if (actor === "external") return "external";
  return "system";
}

export function actorSession(actor: string | null | undefined): string | null {
  return actor?.startsWith("agent:") ? actor.slice("agent:".length) || null : null;
}

const MAP: Record<string, string> = { ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u", Ç: "c", Ğ: "g", Ö: "o", Ş: "s", Ü: "u" };

/** Path for a new decision record: decisions/YYYY-MM-DD-<slug>.md (Turkish-safe slug). */
export function decisionPath(title: string, date: string, existing: string[] = []): string {
  const slug =
    title
      .replace(/[çğıİöşüÇĞÖŞÜ]/g, (c) => MAP[c] ?? c)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "karar";
  let path = `decisions/${date}-${slug}.md`;
  for (let i = 2; existing.includes(path); i++) path = `decisions/${date}-${slug}-${i}.md`;
  return path;
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
