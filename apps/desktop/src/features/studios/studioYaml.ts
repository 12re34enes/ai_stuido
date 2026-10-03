/**
 * Studio ⇄ YAML for the editor: a clean, ordered YAML view of a studio (server-managed fields
 * dropped, nulls pruned) and back, with structural checks and line numbers for every issue.
 */
import { ApiError } from "@/lib/api";

import { joinPath, parseYaml, stringifyYaml } from "./yaml";
import type { GraphIssue, Studio } from "./types";

export interface EditorIssue {
  level: "error" | "warning";
  message: string;
  /** 1-based line in the YAML text, when it could be located. */
  line?: number;
  source: "yaml" | "schema" | "server";
  code?: string;
}

export interface StudioParse {
  studio: Studio | null;
  issues: EditorIssue[];
  lines: Map<string, number>;
}

const NODE_KINDS = new Set(["agent", "advisor", "gate", "parallel", "join", "compare", "condition", "synthesis", "merge", "git", "deploy", "human"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Drop nulls and objects left empty by that (keeps arrays and required containers). */
function prune(v: unknown, keepEmpty = false): unknown {
  if (Array.isArray(v)) return v.map((x) => prune(x, true));
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || x === undefined) continue;
    const p = prune(x);
    if (isObj(p) && Object.keys(p).length === 0 && !keepEmpty) continue;
    out[k] = p;
  }
  return out;
}

function ordered(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in obj) out[k] = obj[k];
  for (const [k, v] of Object.entries(obj)) if (!(k in out)) out[k] = v;
  return out;
}

/** The editor's YAML view of a studio. */
export function studioToYaml(studio: Studio): string {
  const { version: _v, builtin: _b, updated_at: _u, ...rest } = studio;
  const graph = studio.graph ?? { nodes: [], edges: [] };
  const view = {
    ...rest,
    graph: ordered(
      {
        ...graph,
        nodes: (graph.nodes ?? []).map((n) =>
          ordered({ ...n, config: ordered({ ...n.config }, ["kind"]) } as Record<string, unknown>, ["id", "label", "position", "config"]),
        ),
        edges: (graph.edges ?? []).map((e) => {
          const { condition, ...edge } = e;
          return condition && condition !== "default" ? { ...edge, condition } : edge;
        }),
        inputs: graph.inputs && Object.keys(graph.inputs).length ? graph.inputs : undefined,
      },
      ["settings", "nodes", "edges"],
    ),
  };
  const clean = ordered(prune(view) as Record<string, unknown>, [
    "id",
    "name",
    "description",
    "icon",
    "inputs",
    "graph",
    "output_format",
    "output_template",
  ]);
  if (!clean.graph) clean.graph = { nodes: [], edges: [] };
  return stringifyYaml(clean, {
    flowWidth: 100,
    foldWidth: 88,
    flowMapping: (path) => path.endsWith(".position") || /\.edges\[\d+\]$/.test(path),
  });
}

/** Parse editor text into a Studio (null while it has structural errors). */
export function yamlToStudio(text: string, base?: { version?: number }): StudioParse {
  const parsed = parseYaml(text);
  const { lines } = parsed;
  const issues: EditorIssue[] = parsed.errors.map((e) => ({ level: "error", message: e.message, line: e.line, source: "yaml" }));
  const err = (message: string, path?: string) =>
    issues.push({ level: "error", message, line: path ? lineFor(lines, path) : undefined, source: "schema" });

  const v = parsed.value;
  if (issues.length) return { studio: null, issues, lines };
  if (!isObj(v)) {
    err("Belge bir eşleme olmalı: her satır “anahtar: değer” biçiminde.");
    return { studio: null, issues, lines };
  }
  for (const key of ["id", "name", "description"]) {
    if (typeof v[key] !== "string") err(`“${key}” alanı metin olarak yazılmalı.`, key in v ? key : undefined);
  }
  if (v.inputs !== undefined) {
    if (!Array.isArray(v.inputs)) err("“inputs” bir liste olmalı.", "inputs");
    else
      v.inputs.forEach((inp, i) => {
        const p = joinPath("inputs", i);
        if (!isObj(inp)) return err(`${i + 1}. girdi bir eşleme olmalı.`, p);
        if (typeof inp.name !== "string" || !inp.name) err(`${i + 1}. girdinin “name” alanı eksik.`, p);
        if (typeof inp.label !== "string" || !inp.label) err(`${i + 1}. girdinin “label” alanı eksik.`, p);
        if (inp.options !== undefined && inp.options !== null && !Array.isArray(inp.options)) err("“options” bir liste olmalı.", joinPath(p, "options"));
      });
  }
  const graph = v.graph;
  if (!isObj(graph)) err("“graph” alanı eksik ya da geçersiz.", "graph" in v ? "graph" : undefined);
  else {
    if (!Array.isArray(graph.nodes)) err("“graph.nodes” bir liste olmalı.", "graph.nodes");
    else
      graph.nodes.forEach((n, i) => {
        const p = joinPath("graph.nodes", i);
        if (!isObj(n)) return err(`${i + 1}. düğüm bir eşleme olmalı.`, p);
        if (typeof n.id !== "string" || !n.id) err(`${i + 1}. düğümün “id” alanı eksik.`, p);
        if (typeof n.label !== "string") err(`“${String(n.id ?? i + 1)}” düğümünün “label” alanı eksik.`, p);
        if (!isObj(n.config)) return err(`“${String(n.id ?? i + 1)}” düğümünün “config” alanı eksik.`, p);
        if (!NODE_KINDS.has(String(n.config.kind))) {
          err(
            n.config.kind === undefined ? `“${String(n.id)}” düğümünde “kind” eksik.` : `Bilinmeyen düğüm türü: “${String(n.config.kind)}”.`,
            joinPath(p, "config.kind"),
          );
        }
        if (n.config.kind === "gate" && typeof n.config.gate !== "string") err(`“${String(n.id)}” kapısının türü (“gate”) eksik.`, joinPath(p, "config"));
      });
    if (graph.edges !== undefined && !Array.isArray(graph.edges)) err("“graph.edges” bir liste olmalı.", "graph.edges");
    else
      ((graph.edges as unknown[] | undefined) ?? []).forEach((e, i) => {
        const p = joinPath("graph.edges", i);
        if (!isObj(e) || typeof e.id !== "string" || typeof e.source !== "string" || typeof e.target !== "string") {
          err(`${i + 1}. bağlantıda “id”, “source” ve “target” metin olmalı.`, p);
        }
      });
  }
  if (issues.length) return { studio: null, issues, lines };
  const g = graph as Record<string, unknown>;
  const studio = {
    ...v,
    graph: { ...g, edges: (g.edges as unknown[] | undefined) ?? [] },
    version: base?.version,
    builtin: false,
  } as unknown as Studio;
  return { studio, issues, lines };
}

/** Line of `path`, walking up to the nearest recorded ancestor. */
export function lineFor(lines: Map<string, number>, path: string): number | undefined {
  let p = path;
  while (p) {
    const l = lines.get(p);
    if (l !== undefined) return l;
    const cut = Math.max(p.lastIndexOf("."), p.lastIndexOf("["));
    if (cut <= 0) break;
    p = p.slice(0, cut);
  }
  return lines.get(p);
}

/** Locate a server validation issue (node/edge/input/field) in the YAML. */
export function issueLine(issue: GraphIssue, studio: Studio, lines: Map<string, number>): number | undefined {
  if (issue.node_id) {
    const i = studio.graph.nodes.findIndex((n) => n.id === issue.node_id);
    if (i >= 0) {
      const base = joinPath("graph.nodes", i);
      return (issue.field ? lines.get(`${base}.config.${issue.field}`) : undefined) ?? lines.get(base);
    }
  }
  if (issue.edge_id) {
    const i = studio.graph.edges.findIndex((e) => e.id === issue.edge_id);
    if (i >= 0) return lines.get(joinPath("graph.edges", i));
  }
  if (issue.field) {
    const i = (studio.inputs ?? []).findIndex((inp) => inp.name === issue.field);
    if (i >= 0) return lines.get(joinPath("inputs", i));
    return lines.get(issue.field);
  }
  if (issue.code === "bad_studio_id") return lines.get("id");
  if (issue.code === "empty_name") return lines.get("name");
  return undefined;
}

export function serverIssues(report: { errors: GraphIssue[]; warnings: GraphIssue[] }, studio: Studio, lines: Map<string, number>): EditorIssue[] {
  return [...report.errors, ...report.warnings].map((i) => ({
    level: i.level,
    message: i.message,
    line: issueLine(i, studio, lines),
    source: "server" as const,
    code: i.code,
  }));
}

const PYDANTIC_TR: Record<string, string> = {
  missing: "zorunlu alan eksik",
  string_type: "metin olmalı",
  int_type: "tam sayı olmalı",
  int_parsing: "tam sayı olmalı",
  float_type: "sayı olmalı",
  float_parsing: "sayı olmalı",
  bool_type: "true ya da false olmalı",
  bool_parsing: "true ya da false olmalı",
  list_type: "liste olmalı",
  dict_type: "eşleme olmalı",
  model_type: "eşleme olmalı",
  model_attributes_type: "eşleme olmalı",
  literal_error: "izin verilen değerlerden biri olmalı",
  enum: "izin verilen değerlerden biri olmalı",
  union_tag_invalid: "bilinmeyen tür",
  union_tag_not_found: "“kind” alanı eksik",
  extra_forbidden: "bu alan tanınmıyor",
};

/** Turkish issues from a 422 schema error (`details.errors` = pydantic errors with `loc`). */
export function schemaIssuesFromError(error: unknown, lines: Map<string, number>): EditorIssue[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const raw = error.details?.errors;
  if (!Array.isArray(raw)) return null;
  return raw.map((e: { loc?: unknown[]; type?: string; msg?: string }) => {
    const loc = (e.loc ?? []).filter((x) => x !== "body");
    // Discriminated unions add the tag name ("agent") to the path; drop non-field segments.
    let path = "";
    for (const seg of loc) {
      if (typeof seg === "number") path = joinPath(path, seg);
      else if (typeof seg === "string" && !NODE_KINDS.has(seg)) path = joinPath(path, seg);
    }
    const reason = PYDANTIC_TR[e.type ?? ""] ?? e.msg ?? "geçersiz değer";
    return { level: "error" as const, message: `${path || "belge"}: ${reason}.`, line: path ? lineFor(lines, path) : undefined, source: "schema" as const };
  });
}

/** Skeleton for "Yeni stüdyo → Boş stüdyo". */
export function blankStudio(id: string, name: string): Studio {
  return {
    id,
    name,
    description: "Bu stüdyonun ne yaptığını ve ne ürettiğini bir iki cümleyle anlatın.",
    icon: "sparkles",
    inputs: [{ name: "request", label: "İstek", type: "textarea", required: true, help: "Ajanın yapmasını istediğiniz iş." }],
    graph: {
      settings: { gates: { plan_approval: false, boundary_check: false, build_test: false, cross_review: false, user_final: true } },
      nodes: [
        {
          id: "work",
          label: "Çalışma",
          position: { x: 0, y: 0 },
          config: { kind: "advisor", provider: "claude", perspective: "", prompt_template: "{{ memory.context }}\n\n## İstek\n{{ input.request }}\n" },
        },
        { id: "final", label: "Son onay", position: { x: 300, y: 0 }, config: { kind: "gate", gate: "user_final" } },
      ],
      edges: [{ id: "e-work-final", source: "work", target: "final" }],
    },
    output_format: "markdown",
    output_template: "{{ nodes.work.output }}\n",
  };
}

/** Copy of a template studio under a new id/name (server-managed fields reset). */
export function studioFromTemplate(template: Studio, id: string, name: string): Studio {
  const { version: _v, builtin: _b, updated_at: _u, ...rest } = structuredClone(template);
  return { ...rest, id, name };
}
