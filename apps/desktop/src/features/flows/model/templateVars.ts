/**
 * Jinja template variables documented in contracts/flows.py (plus the engine's loop extras),
 * resolved against the current graph, and the completion logic used by the prompt editors.
 */
import type { NodeKind } from "../types";

export type VarGroup = "input" | "nodes" | "memory" | "review" | "gate" | "task" | "workspace" | "repo" | "feedback" | "filter";

export interface TemplateVar {
  /** Inserted text, e.g. "nodes.plan.output" or "clip(4000)". */
  path: string;
  detail: string;
  group: VarGroup;
  /** Higher sorts first among equally good matches (upstream nodes, common variables). */
  boost: number;
}

export interface VarContext {
  nodes: { id: string; label: string; kind: NodeKind }[];
  /** Node being edited (excluded from nodes.*). */
  currentId?: string | null;
  /** Upstream node ids, nearest first (boosted). */
  upstream?: string[];
  inputs?: Record<string, unknown>;
  repos?: { name: string }[];
}

/** Input names from FlowGraph.inputs (JSON-schema `properties` or a plain name → spec map). */
export function inputNames(inputs: Record<string, unknown> | undefined): string[] {
  if (!inputs) return [];
  const props = inputs.properties;
  const keys = props && typeof props === "object" && !Array.isArray(props) ? Object.keys(props) : Object.keys(inputs);
  return keys.filter((k) => /^[A-Za-z_]\w*$/.test(k) && !["type", "required", "properties", "title", "description"].includes(k));
}

export function templateVariables(ctx: VarContext): TemplateVar[] {
  const vars: TemplateVar[] = [{ path: "input.prompt", detail: "Görev metni", group: "input", boost: 10 }];
  for (const name of inputNames(ctx.inputs)) {
    if (name !== "prompt") vars.push({ path: `input.${name}`, detail: "Görev girdisi", group: "input", boost: 6 });
  }
  const up = ctx.upstream ?? [];
  for (const n of ctx.nodes) {
    if (n.id === ctx.currentId) continue;
    const rank = up.indexOf(n.id);
    const boost = rank < 0 ? 0 : Math.max(1, 8 - rank);
    vars.push(
      { path: `nodes.${n.id}.output`, detail: `${n.label} · metin çıktısı`, group: "nodes", boost },
      { path: `nodes.${n.id}.data`, detail: `${n.label} · yapılandırılmış çıktı`, group: "nodes", boost: boost - 0.5 },
      { path: `nodes.${n.id}.status`, detail: `${n.label} · durum`, group: "nodes", boost: boost - 1 },
    );
    if (n.kind === "gate") vars.push({ path: `gate.${n.id}.evidence`, detail: `${n.label} · kapı kanıtı`, group: "gate", boost });
  }
  vars.push(
    { path: "memory.context", detail: "Rolüne göre hafıza bağlamı", group: "memory", boost: 4 },
    { path: "memory.facts", detail: "Proje gerçekleri", group: "memory", boost: 2 },
    { path: "memory.boundaries", detail: "Sınırlar", group: "memory", boost: 2 },
    { path: "memory.decisions", detail: "Kararlar", group: "memory", boost: 2 },
    { path: "review.findings", detail: "Son başarısız incelemenin bulguları", group: "review", boost: 3 },
    { path: "task.title", detail: "Görev başlığı", group: "task", boost: 3 },
    { path: "task.id", detail: "Görev kimliği", group: "task", boost: 1 },
    { path: "workspace.name", detail: "Çalışma alanı adı", group: "workspace", boost: 1 },
    { path: "feedback.text", detail: "Döngüde geri dönüş nedeni", group: "feedback", boost: 2 },
    { path: "feedback.round", detail: "Döngü turu", group: "feedback", boost: 1 },
    { path: "feedback.gate", detail: "Geri döndüren kapı", group: "feedback", boost: 0 },
  );
  for (const r of ctx.repos ?? []) {
    if (/^[A-Za-z_]\w*$/.test(r.name)) vars.push({ path: `repo.${r.name}.default_branch`, detail: "Varsayılan branch", group: "repo", boost: 1 });
  }
  return vars;
}

export const TEMPLATE_FILTERS: TemplateVar[] = [
  { path: "clip(4000)", detail: "Metni kısalt", group: "filter", boost: 5 },
  { path: "findings", detail: "Bulguları madde madde yaz", group: "filter", boost: 4 },
  { path: "json", detail: "JSON olarak yaz", group: "filter", boost: 4 },
  { path: "length", detail: "Uzunluk", group: "filter", boost: 3 },
  { path: "default('')", detail: "Boşsa varsayılan", group: "filter", boost: 2 },
  { path: "trim", detail: "Boşlukları kırp", group: "filter", boost: 1 },
  { path: "upper", detail: "Büyük harf", group: "filter", boost: 0 },
  { path: "lower", detail: "Küçük harf", group: "filter", boost: 0 },
  { path: "join(', ')", detail: "Listeyi birleştir", group: "filter", boost: 0 },
];

/** Root names that exist in templates (for unknown-variable hints). */
export const TEMPLATE_ROOTS = ["input", "nodes", "memory", "review", "gate", "task", "workspace", "repo", "feedback", "attempt", "loop", "true", "false", "none", "not", "and", "or", "in", "is"];

export interface CompletionSite {
  /** Offset (in the scanned text) where the replaced token starts. */
  from: number;
  prefix: string;
  /** After a `|`: complete filters instead of variables. */
  filter: boolean;
  /** The surrounding tag is not closed yet: completing should add " }}". */
  needsClose: boolean;
}

/**
 * Where (and whether) to complete, given the text before the cursor and the rest of the line.
 * Templates complete inside `{{ … }}` / `{% … %}`; expression editors complete everywhere.
 */
export function completionSite(before: string, after: string, mode: "template" | "expression"): CompletionSite | null {
  let tagOpen = mode === "expression";
  let needsClose = false;
  if (mode === "template") {
    const open = Math.max(before.lastIndexOf("{{"), before.lastIndexOf("{%"));
    if (open < 0) return null;
    const close = Math.max(before.lastIndexOf("}}"), before.lastIndexOf("%}"));
    if (close > open) return null;
    tagOpen = true;
    const closer = before.slice(open, open + 2) === "{{" ? "}}" : "%}";
    needsClose = !after.includes(closer);
  }
  if (!tagOpen) return null;
  const token = /[A-Za-z_][\w.]*$|[A-Za-z_]?$/.exec(before);
  const prefix = token ? token[0] : "";
  const from = before.length - prefix.length;
  const head = before.slice(0, from);
  const filter = /\|\s*$/.test(head);
  // Don't pop up inside string literals or right after a number.
  const quotes = (head.match(/'/g)?.length ?? 0) + (head.match(/"/g)?.length ?? 0);
  if (quotes % 2 === 1) return null;
  if (/[\d)\]]$/.test(head) && !prefix) return null;
  return { from, prefix, filter, needsClose };
}

/** Rank candidates for a typed prefix: full-path prefix > segment prefix > substring. */
export function rankVars(vars: readonly TemplateVar[], prefix: string, limit = 60): TemplateVar[] {
  const p = prefix.toLocaleLowerCase("tr-TR");
  if (!p) return [...vars].sort((a, b) => b.boost - a.boost).slice(0, limit);
  const last = p.split(".").pop() ?? p;
  const scored: { v: TemplateVar; score: number }[] = [];
  for (const v of vars) {
    const path = v.path.toLocaleLowerCase("tr-TR");
    let score = -1;
    if (path.startsWith(p)) score = 300;
    else if (last && path.split(".").some((seg) => seg.startsWith(last)) && path.includes(p.slice(0, p.length - last.length))) score = 200;
    else if (path.includes(p)) score = 100;
    else if (v.detail.toLocaleLowerCase("tr-TR").includes(p)) score = 50;
    if (score >= 0) scored.push({ v, score: score + v.boost });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.v.path.length - b.v.path.length)
    .slice(0, limit)
    .map((x) => x.v);
}

/** Variable references used in a template (for "unknown variable" hints). */
export function referencedPaths(template: string): string[] {
  const out: string[] = [];
  const tag = /\{\{([\s\S]*?)\}\}|\{%([\s\S]*?)%\}/g;
  for (let m = tag.exec(template); m; m = tag.exec(template)) {
    const body = (m[1] ?? m[2] ?? "").replace(/'[^']*'|"[^"]*"/g, "");
    for (const ref of body.matchAll(/(?<![\w.|])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g)) out.push(ref[1]!);
  }
  return out;
}
