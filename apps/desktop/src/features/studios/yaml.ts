/**
 * YAML for the studio editor, without a YAML dependency:
 *
 * - `parseYaml` walks the Lezer YAML syntax tree (the same parser CodeMirror highlights with) and
 *   builds plain JS values. Scalars resolve like PyYAML's safe loader (YAML 1.1 booleans
 *   included), so what the editor sends is what the backend would read from the same file.
 *   It never throws: syntax problems come back as Turkish errors with line numbers, and every
 *   mapping key / sequence item records its line so validation issues can point into the text.
 * - `stringifyYaml` emits block-style YAML: literal blocks for multi-line text, flow style for
 *   short scalar lists (and for mappings the caller opts in), quoting only when needed.
 */
import { yamlLanguage } from "@codemirror/lang-yaml";

type SyntaxNode = ReturnType<typeof yamlLanguage.parser.parse>["topNode"];

export interface YamlError {
  message: string;
  /** 1-based line. */
  line: number;
  from: number;
  to: number;
}

export interface YamlParseResult {
  value: unknown;
  errors: YamlError[];
  /** JSON path ("graph.nodes[2].config.kind") → 1-based line of its key / item. */
  lines: Map<string, number>;
}

// ----------------------------------------------------------------------------- scalars

const NULLS = new Set(["", "~", "null", "Null", "NULL"]);
const TRUE = new Set(["true", "True", "TRUE", "yes", "Yes", "YES", "on", "On", "ON"]);
const FALSE = new Set(["false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF"]);
const INT = /^[-+]?(0|[1-9][0-9_]*)$/;
const HEX = /^0x[0-9a-fA-F_]+$/;
const OCT = /^0o?[0-7_]+$/;
// PyYAML (YAML 1.1) floats need a dot: "1e3" and "1.2.3" stay strings.
const FLOAT = /^[-+]?([0-9][0-9_]*\.[0-9_]*|\.[0-9_]+)([eE][-+][0-9]+)?$/;

/** Resolve a plain (unquoted) scalar to null / boolean / number / string. */
export function resolvePlain(text: string): unknown {
  if (NULLS.has(text)) return null;
  if (TRUE.has(text)) return true;
  if (FALSE.has(text)) return false;
  if (INT.test(text)) return Number(text.replace(/_/g, ""));
  if (HEX.test(text)) return parseInt(text.slice(2).replace(/_/g, ""), 16);
  if (OCT.test(text) && text.length > 1 && text !== "0") return parseInt(text.replace(/^0o?/, "").replace(/_/g, ""), 8);
  if (FLOAT.test(text)) return Number(text.replace(/_/g, ""));
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text.startsWith("-") ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(text)) return NaN;
  return text;
}

/** Fold the lines of a multi-line flow scalar: single breaks become spaces, blank lines breaks. */
function foldFlowLines(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length === 1) return raw;
  let out = lines[0]!.replace(/[ \t]+$/, "");
  let pendingBreaks = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") {
      pendingBreaks++;
      continue;
    }
    out += pendingBreaks > 0 ? "\n".repeat(pendingBreaks) : " ";
    out += line;
    pendingBreaks = 0;
  }
  return out;
}

const ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  t: "\t",
  "\t": "\t",
  n: "\n",
  v: "\v",
  f: "\f",
  r: "\r",
  e: "\x1b",
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  N: "\u0085",
  _: " ",
  L: " ",
  P: " ",
};

function unquoteDouble(body: string): string {
  // Line continuation: a backslash at the end of a line joins without a space.
  const folded = foldFlowLines(body.replace(/\\\n[ \t]*/g, "\u0000"));
  let out = "";
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i]!;
    if (ch === "\u0000") continue;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = folded[i + 1] ?? "";
    const hexLen = next === "x" ? 2 : next === "u" ? 4 : next === "U" ? 8 : 0;
    if (hexLen) {
      const hex = folded.slice(i + 2, i + 2 + hexLen);
      if (/^[0-9a-fA-F]+$/.test(hex) && hex.length === hexLen) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 1 + hexLen;
        continue;
      }
    }
    if (next in ESCAPES) {
      out += ESCAPES[next];
      i++;
      continue;
    }
    out += next;
    i++;
  }
  return out;
}

function unquote(raw: string): string {
  if (raw.startsWith("'")) {
    const body = raw.endsWith("'") && raw.length > 1 ? raw.slice(1, -1) : raw.slice(1);
    return foldFlowLines(body).replace(/''/g, "'");
  }
  const body = raw.endsWith('"') && raw.length > 1 ? raw.slice(1, -1) : raw.slice(1);
  return unquoteDouble(body);
}

function lineIndent(text: string, pos: number): number {
  const start = text.lastIndexOf("\n", pos - 1) + 1;
  let i = start;
  while (text[i] === " ") i++;
  return i - start;
}

/** Value of a `|` / `>` block scalar from its header and raw content. */
export function blockScalar(header: string, content: string, parentIndent = 0): string {
  const style = header[0] === ">" ? "folded" : "literal";
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  const indicator = /[1-9]/.exec(header)?.[0];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let indent: number;
  if (indicator) indent = parentIndent + Number(indicator);
  else {
    const first = lines.find((l) => l.trim() !== "");
    indent = first ? first.length - first.trimStart().length : 0;
  }
  const body = lines.map((l) => (l.trim() === "" ? "" : l.slice(Math.min(indent, l.length - l.trimStart().length))));
  // Trailing empty lines are governed by chomping, not content.
  let end = body.length;
  while (end > 0 && body[end - 1] === "") end--;
  const trailing = body.length - end;
  const kept = body.slice(0, end);
  let text: string;
  if (style === "literal") text = kept.join("\n");
  else {
    text = "";
    let prevMore = false;
    let blank = 0;
    kept.forEach((line, i) => {
      if (line === "") {
        blank++;
        return;
      }
      const more = line.startsWith(" ") || line.startsWith("\t");
      if (i > 0) {
        if (blank > 0) text += "\n".repeat(more || prevMore ? blank + 1 : blank);
        else text += more || prevMore ? "\n" : " ";
      }
      text += line;
      prevMore = more;
      blank = 0;
    });
  }
  if (kept.length === 0) return chomp === "keep" ? "\n".repeat(Math.max(0, trailing - 1)) : "";
  if (chomp === "strip") return text;
  if (chomp === "clip") return `${text}\n`;
  // keep: the content's own final break plus every trailing empty line.
  return `${text}\n${"\n".repeat(Math.max(0, trailing - 1))}`;
}

// ----------------------------------------------------------------------------- parse

const VALUE_NODES = new Set([
  "Literal",
  "QuotedLiteral",
  "BlockLiteral",
  "BlockMapping",
  "BlockSequence",
  "FlowMapping",
  "FlowSequence",
  "Tagged",
  "Anchored",
  "Alias",
]);

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function joinPath(base: string, key: string | number): string {
  if (typeof key === "number") return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

/** Parse YAML text (first document only). Never throws. */
export function parseYaml(text: string): YamlParseResult {
  const tree = yamlLanguage.parser.parse(text);
  const errors: YamlError[] = [];
  const lines = new Map<string, number>();
  const anchors = new Map<string, unknown>();
  const seenErrors = new Set<number>();

  tree.iterate({
    enter(n) {
      if (n.type.isError && !seenErrors.has(n.from)) {
        seenErrors.add(n.from);
        const line = lineOf(text, n.from);
        errors.push({ message: `YAML sözdizimi hatası (satır ${line}).`, line, from: n.from, to: Math.max(n.to, n.from + 1) });
      }
    },
  });

  const slice = (n: SyntaxNode) => text.slice(n.from, n.to);

  function scalarText(node: SyntaxNode): string {
    const v = convert(node, "");
    return v === null || v === undefined ? "" : String(v);
  }

  function convert(node: SyntaxNode, path: string): unknown {
    switch (node.name) {
      case "Literal":
        return resolvePlain(foldFlowLines(slice(node)));
      case "QuotedLiteral":
        return unquote(slice(node));
      case "BlockLiteral": {
        const header = node.getChild("BlockLiteralHeader");
        const content = node.getChild("BlockLiteralContent");
        if (!header) return "";
        if (!content) return "";
        // Content starts on the line after the header; take whole lines so indentation counts.
        const raw = text.slice(text.lastIndexOf("\n", content.from - 1) + 1, content.to);
        return blockScalar(slice(header), raw, lineIndent(text, node.from));
      }
      case "BlockMapping":
      case "FlowMapping": {
        const out: Record<string, unknown> = {};
        for (const pair of children(node).filter((c) => c.name === "Pair")) {
          const keyNode = pair.getChild("Key");
          const keyValue = keyNode?.firstChild ? scalarText(keyNode.firstChild) : "";
          const valueNode = children(pair).find((c) => VALUE_NODES.has(c.name) && c !== keyNode);
          const childPath = joinPath(path, keyValue);
          const line = lineOf(text, pair.from);
          if (Object.prototype.hasOwnProperty.call(out, keyValue)) {
            errors.push({ message: `Yinelenen anahtar: “${keyValue}” (satır ${line}).`, line, from: pair.from, to: keyNode?.to ?? pair.to });
          }
          lines.set(childPath, line);
          out[keyValue] = valueNode ? convert(valueNode, childPath) : null;
        }
        return out;
      }
      case "BlockSequence":
      case "FlowSequence": {
        const items = children(node).filter((c) => c.name === "Item");
        return items.map((item, i) => {
          const childPath = joinPath(path, i);
          const dash = item.prevSibling && item.prevSibling.name === "-" ? item.prevSibling : item;
          lines.set(childPath, lineOf(text, dash.from));
          const valueNode = children(item).find((c) => VALUE_NODES.has(c.name));
          return valueNode ? convert(valueNode, childPath) : null;
        });
      }
      case "Tagged": {
        const tag = node.getChild("Tag");
        const inner = children(node).find((c) => VALUE_NODES.has(c.name));
        const value = inner ? convert(inner, path) : null;
        const t = tag ? slice(tag) : "";
        if (t === "!!str" && value !== null && typeof value !== "object") return String(inner ? slice(inner) : value);
        return value;
      }
      case "Anchored": {
        const anchor = node.getChild("Anchor");
        const inner = children(node).find((c) => VALUE_NODES.has(c.name));
        const value = inner ? convert(inner, path) : null;
        if (anchor) anchors.set(slice(anchor).slice(1), value);
        return value;
      }
      case "Alias": {
        const name = slice(node).slice(1);
        if (!anchors.has(name)) {
          const line = lineOf(text, node.from);
          errors.push({ message: `Tanımsız takma ad: “*${name}” (satır ${line}).`, line, from: node.from, to: node.to });
          return null;
        }
        return structuredClone(anchors.get(name));
      }
      default:
        return null;
    }
  }

  const doc = tree.topNode.getChild("Document");
  let value: unknown = null;
  if (doc) {
    const root = children(doc).find((c) => VALUE_NODES.has(c.name));
    if (root) value = convert(root, "");
  }
  errors.sort((a, b) => a.from - b.from);
  return { value, errors, lines };
}

// ----------------------------------------------------------------------------- stringify

export interface StringifyOptions {
  /** Max width of a flow collection (`[a, b]`, `{x: 0}`) before falling back to block style. */
  flowWidth?: number;
  /** Mappings rendered in flow style when they fit (only scalar values). Default: never. */
  flowMapping?: (path: string, value: Record<string, unknown>) => boolean;
  /** Column at which long one-line strings are folded into `>-` blocks; 0 disables. */
  foldWidth?: number;
}

const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== "object";
}

function plainSafe(s: string, flow: boolean): boolean {
  if (s === "" || s !== s.trim()) return false;
  if (INDICATOR_START.test(s) && !/^-[^\s-]/.test(s)) return false;
  if (/^-[^\s]/.test(s) && resolvePlain(s) !== s) return false;
  if (s.includes(": ") || s.includes(" #") || s.endsWith(":") || /[\t\n\r]/.test(s)) return false;
  if (flow && /[,[\]{}]/.test(s)) return false;
  if (/^(---|\.\.\.)/.test(s)) return false;
  return resolvePlain(s) === s;
}

function quote(s: string): string {
  return JSON.stringify(s);
}

function scalar(v: unknown, flow = false): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return ".nan";
    if (!Number.isFinite(v)) return v > 0 ? ".inf" : "-.inf";
    return String(v);
  }
  const s = String(v);
  return plainSafe(s, flow) ? s : quote(s);
}

function blockText(s: string, indent: string): string | null {
  if (s.includes("\r")) return null;
  const trailing = /\n*$/.exec(s)?.[0].length ?? 0;
  const body = s.slice(0, s.length - trailing);
  if (body === "") return null;
  const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
  const lines = (trailing > 1 ? body + "\n".repeat(trailing - 1) : body).split("\n");
  const needsIndicator = /^[ \t]/.test(lines[0] ?? "");
  const header = `|${needsIndicator ? "2" : ""}${chomp}`;
  return `${header}\n${lines.map((l) => (l === "" ? "" : indent + l)).join("\n")}`;
}

/** Long one-line prose as a folded block (`>-`), wrapped at spaces. Null when folding would change it. */
function foldedText(s: string, indent: string, width: number): string | null {
  if (s.length <= width - indent.length || /[\n\r\t]/.test(s) || s.includes("  ") || s !== s.trim()) return null;
  const max = Math.max(40, width - indent.length);
  const lines: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  if (lines.length < 2) return null;
  return `>-\n${lines.map((l) => indent + l).join("\n")}`;
}

/** Serialize plain JS data (objects, arrays, scalars) as YAML. */
export function stringifyYaml(value: unknown, options: StringifyOptions = {}): string {
  const flowWidth = options.flowWidth ?? 72;
  const foldWidth = options.foldWidth ?? 96;
  const flowMapping = options.flowMapping ?? (() => false);

  function flowSeq(arr: unknown[]): string | null {
    if (!arr.every(isScalar)) return null;
    const s = `[${arr.map((v) => scalar(v, true)).join(", ")}]`;
    return s.length <= flowWidth ? s : null;
  }

  function flowMap(path: string, obj: Record<string, unknown>): string | null {
    if (!flowMapping(path, obj) || !Object.values(obj).every(isScalar)) return null;
    const s = `{${Object.entries(obj)
      .map(([k, v]) => `${scalar(k, true)}: ${scalar(v, true)}`)
      .join(", ")}}`;
    return s.length <= flowWidth ? s : null;
  }

  /** Lines for a value nested under a key / dash (`indent` = indentation of the parent). */
  function inline(v: unknown, indent: string, path: string): { text: string; block: boolean } {
    if (Array.isArray(v)) {
      if (v.length === 0) return { text: "[]", block: false };
      const flow = flowSeq(v);
      if (flow) return { text: flow, block: false };
      return { text: seq(v, indent + "  ", path), block: true };
    }
    if (v !== null && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      if (Object.keys(obj).length === 0) return { text: "{}", block: false };
      const flow = flowMap(path, obj);
      if (flow) return { text: flow, block: false };
      return { text: map(obj, indent + "  ", path), block: true };
    }
    if (typeof v === "string" && v.includes("\n")) {
      const block = blockText(v, indent + "  ");
      if (block) return { text: block, block: false };
    }
    if (typeof v === "string" && foldWidth > 0) {
      const folded = foldedText(v, indent + "  ", foldWidth);
      if (folded) return { text: folded, block: false };
    }
    return { text: scalar(v), block: false };
  }

  function map(obj: Record<string, unknown>, indent: string, path: string): string {
    return Object.entries(obj)
      .map(([k, v]) => {
        const key = scalar(k);
        const childPath = joinPath(path, k);
        const { text, block } = inline(v, indent, childPath);
        return block ? `${indent}${key}:\n${text}` : `${indent}${key}: ${text}`;
      })
      .join("\n");
  }

  function seq(arr: unknown[], indent: string, path: string): string {
    return arr
      .map((v, i) => {
        const childPath = joinPath(path, i);
        if (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
          const obj = v as Record<string, unknown>;
          const flow = flowMap(childPath, obj);
          if (flow) return `${indent}- ${flow}`;
          // First key on the dash line, the rest aligned under it.
          const body = map(obj, indent + "  ", childPath);
          return `${indent}- ${body.slice(indent.length + 2)}`;
        }
        if (Array.isArray(v) && v.length > 0 && !flowSeq(v)) {
          const body = seq(v, indent + "  ", childPath);
          return `${indent}- ${body.slice(indent.length + 2)}`;
        }
        const { text } = inline(v, indent, childPath);
        return `${indent}- ${text}`;
      })
      .join("\n");
  }

  if (Array.isArray(value)) return `${value.length ? seq(value, "", "") : "[]"}\n`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `${Object.keys(obj).length ? map(obj, "", "") : "{}"}\n`;
  }
  return `${inline(value, "", "").text}\n`;
}
