/**
 * The final document of a studio run: the studio's `output_template` rendered with the run's node
 * outputs and inputs (falls back to the last output node when there is no usable template).
 */
import { finalOutputNodeIds, slugify } from "./model";
import { renderTemplate, TemplateError } from "./template";
import type { Evidence, FlowGraph, NodeRun, Studio, TaskDetail, TaskDocument } from "./types";
import { parseYaml } from "./yaml";

export interface StudioDocument {
  markdown: string;
  source: "template" | "fallback" | "empty";
  /** Turkish reason the template could not be used. */
  error?: string;
}

/** Latest attempt of every node (by attempt, then finish time). */
export function latestNodeRuns(nodes: NodeRun[]): Map<string, NodeRun> {
  const out = new Map<string, NodeRun>();
  for (const n of nodes) {
    const prev = out.get(n.node_id);
    const newer =
      !prev ||
      (n.attempt ?? 1) > (prev.attempt ?? 1) ||
      ((n.attempt ?? 1) === (prev.attempt ?? 1) && (n.finished_at ?? "") > (prev.finished_at ?? ""));
    // Keep an earlier attempt that produced output over a newer one still running without output.
    if (newer && (n.output || !prev?.output)) out.set(n.node_id, n);
  }
  return out;
}

export function documentContext(
  graph: FlowGraph,
  detail: TaskDetail,
  options: { workspaceName?: string; evidence?: Evidence[] } = {},
): Record<string, unknown> {
  const runs = latestNodeRuns(detail.current_run?.nodes ?? []);
  const nodes: Record<string, unknown> = {};
  for (const n of graph.nodes) {
    const r = runs.get(n.id);
    nodes[n.id] = { output: r?.output ?? "", data: r?.data ?? {}, status: r?.status ?? "pending" };
  }
  const gate: Record<string, unknown> = {};
  for (const e of options.evidence ?? []) {
    if (e.source !== "gate" || !e.node_id) continue;
    const prev = (gate[e.node_id] as { evidence: string } | undefined)?.evidence;
    const block = [`**${e.title}**`, e.content ? `\n\n\`\`\`\n${e.content}\n\`\`\`` : ""].join("");
    gate[e.node_id] = { evidence: prev ? `${prev}\n\n${block}` : block };
  }
  return {
    input: { ...(detail.task.inputs ?? {}), ...(graph.inputs ?? {}), prompt: detail.task.prompt },
    nodes,
    gate,
    task: { id: detail.task.id, title: detail.task.title },
    workspace: { name: options.workspaceName ?? "" },
  };
}

function fallback(graph: FlowGraph, detail: TaskDetail): string {
  const runs = latestNodeRuns(detail.current_run?.nodes ?? []);
  for (const id of finalOutputNodeIds(graph)) {
    const out = runs.get(id)?.output;
    if (out?.trim()) return out;
  }
  return "";
}

/** Collapse the blank-line runs a template leaves behind around empty sections. */
export function tidyMarkdown(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function buildStudioDocument(
  studio: Pick<Studio, "graph" | "output_template"> | undefined,
  detail: TaskDetail,
  options: { workspaceName?: string; evidence?: Evidence[] } = {},
): StudioDocument {
  const graph = detail.current_run?.graph ?? studio?.graph ?? { nodes: [], edges: [] };
  const template = studio?.output_template?.trim();
  const anyOutput = (detail.current_run?.nodes ?? []).some((n) => n.output?.trim());
  if (!anyOutput) return { markdown: "", source: "empty" };
  if (template) {
    try {
      const md = tidyMarkdown(renderTemplate(studio!.output_template!, documentContext(graph, detail, options)));
      if (md.replace(/[-#*\s]/g, "").length > 0) return { markdown: md, source: "template" };
    } catch (e) {
      const text = fallback(graph, detail);
      return { markdown: text ? tidyMarkdown(text) : "", source: text ? "fallback" : "empty", error: e instanceof TemplateError ? e.message : String(e) };
    }
  }
  const text = fallback(graph, detail);
  return text ? { markdown: tidyMarkdown(text), source: "fallback" } : { markdown: "", source: "empty" };
}

/** Map studiod's rendered document onto the reader's shape (its warning becomes the banner). */
export function fromServerDocument(doc: TaskDocument): StudioDocument {
  const markdown = doc.markdown.trim() ? tidyMarkdown(doc.markdown) : "";
  if (!markdown) return { markdown: "", source: "empty", ...(doc.warning ? { error: doc.warning } : {}) };
  return { markdown, source: doc.source === "template" ? "template" : "fallback", ...(doc.warning ? { error: doc.warning } : {}) };
}

export interface DocumentParts {
  /** The document's own title: a leading `# heading`, else front matter `title`. */
  title: string | null;
  /** Front matter `summary` (ADRs carry one), shown as the lede. */
  summary: string | null;
  meta: Record<string, string>;
  body: string;
}

/** Split a leading YAML front matter block and the first `# title` off the document body. */
export function splitDocument(markdown: string): DocumentParts {
  let body = markdown;
  const meta: Record<string, string> = {};
  const fm = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(body);
  if (fm) {
    const parsed = parseYaml(fm[1]!);
    if (parsed.errors.length === 0 && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      for (const [k, v] of Object.entries(parsed.value as Record<string, unknown>)) {
        if (v !== null && typeof v !== "object") meta[k] = String(v);
      }
      body = body.slice(fm[0].length);
    }
  }
  let title: string | null = null;
  const h1 = /^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/.exec(body);
  if (h1) {
    title = h1[1]!.replace(/[*_`]/g, "");
    body = body.slice(h1[0].length);
  }
  return { title: title ?? meta.title ?? null, summary: meta.summary ?? null, meta, body: body.replace(/^\s+/, "") };
}

export interface Heading {
  level: number;
  text: string;
}

/** h1–h3 headings outside code fences (for the reader's table of contents). */
export function documentHeadings(markdown: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const f = /^\s{0,3}(```|~~~)/.exec(line);
    if (f) {
      fence = fence === null ? f[1]! : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.replace(/[*_`]/g, "") });
  }
  return out;
}

/** Words and reading time (~200 wpm, at least one minute). */
export function readingStats(markdown: string): { words: number; minutes: number } {
  const words = markdown.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { words, minutes: Math.max(1, Math.round(words / 200)) };
}

/** File name for the Markdown export: "Mimari tasarım: Kuyruk mu?" → "mimari-tasarim-kuyruk-mu.md". */
export function exportFileName(title: string): string {
  return `${slugify(title) || "studyo-ciktisi"}.md`;
}
