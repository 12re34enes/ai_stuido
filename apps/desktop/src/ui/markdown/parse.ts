/**
 * A small, safe Markdown parser producing a typed AST (rendered by MarkdownView as React nodes —
 * never as HTML strings). Supports the subset agents and memory files use: headings, paragraphs,
 * emphasis, inline code, fenced code, lists (nested), task items, blockquotes, rules, tables
 * and links (http/https/mailto only). Raw HTML is shown as text.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "br" };

export interface ListItem {
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "blockquote"; children: Block[] }
  | { type: "hr" }
  | { type: "table"; align: ("left" | "center" | "right" | null)[]; header: Inline[][]; rows: Inline[][][] };

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

export function safeHref(href: string): string | null {
  const h = href.trim();
  return SAFE_HREF.test(h) ? h : null;
}

// ----------------------------------------------------------------------------- inline

interface InlineRule {
  re: RegExp;
  make: (m: RegExpExecArray) => Inline;
}

const INLINE: InlineRule[] = [
  { re: /`([^`]+)`/y, make: (m) => ({ type: "code", text: m[1] ?? "" }) },
  { re: /\*\*([\s\S]+?)\*\*/y, make: (m) => ({ type: "strong", children: parseInline(m[1] ?? "") }) },
  { re: /__([\s\S]+?)__/y, make: (m) => ({ type: "strong", children: parseInline(m[1] ?? "") }) },
  { re: /~~([\s\S]+?)~~/y, make: (m) => ({ type: "del", children: parseInline(m[1] ?? "") }) },
  { re: /\*([^*\s][^*]*?)\*/y, make: (m) => ({ type: "em", children: parseInline(m[1] ?? "") }) },
  { re: /_([^_\s][^_]*?)_(?![A-Za-z0-9])/y, make: (m) => ({ type: "em", children: parseInline(m[1] ?? "") }) },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y,
    make: (m) => {
      const href = safeHref(m[2] ?? "");
      const children = parseInline(m[1] ?? "");
      return href ? { type: "link", href, children } : { type: "text", text: m[0] };
    },
  },
  {
    re: /<(https?:\/\/[^>\s]+)>/y,
    make: (m) => ({ type: "link", href: m[1] ?? "", children: [{ type: "text", text: m[1] ?? "" }] }),
  },
  {
    re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y,
    make: (m) => ({ type: "link", href: m[0], children: [{ type: "text", text: m[0] }] }),
  },
  { re: / {2,}\n|\\\n/y, make: () => ({ type: "br" }) },
];

const SPECIAL = /[`*_~[<h \\]/;

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };
  while (i < src.length) {
    const ch = src[i] ?? "";
    if (SPECIAL.test(ch)) {
      let matched = false;
      for (const rule of INLINE) {
        rule.re.lastIndex = i;
        const m = rule.re.exec(src);
        if (m) {
          // Underscore emphasis only at word boundaries (snake_case stays text).
          if (ch === "_" && i > 0 && /[A-Za-z0-9]/.test(src[i - 1] ?? "")) break;
          flush();
          out.push(rule.make(m));
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    if (ch === "\\" && /[\\`*_{}[\]()#+\-.!~|>]/.test(src[i + 1] ?? "")) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

// ----------------------------------------------------------------------------- blocks

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>\s?/;
const LIST = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function isBlockStart(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST.test(line);
}

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) body.push(lines[i++] ?? "");
      i++; // closing fence (or EOF)
      blocks.push({ type: "code", lang: fence[2] ?? "", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, children: parseInline(heading[2] ?? "") });
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] ?? "").trim() && QUOTE.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(QUOTE, ""));
        i++;
      }
      blocks.push({ type: "blockquote", children: parseBlocks(body) });
      continue;
    }

    const list = LIST.exec(line);
    if (list) {
      const indent = list[1]?.length ?? 0;
      const ordered = /\d/.test(list[2] ?? "");
      const start = ordered ? parseInt(list[2] ?? "1", 10) : 1;
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i] ?? "");
        if (!m || (m[1]?.length ?? 0) !== indent || /\d/.test(m[2] ?? "") !== ordered) break;
        const content: string[] = [m[3] ?? ""];
        const contentIndent = indent + (m[2]?.length ?? 1) + 1;
        i++;
        while (i < lines.length) {
          const next = lines[i] ?? "";
          if (!next.trim()) {
            // A blank line continues the item only if indented content follows.
            const after = lines[i + 1] ?? "";
            if (after.trim() && after.search(/\S/) >= contentIndent) {
              content.push("");
              i++;
              continue;
            }
            break;
          }
          const lead = next.search(/\S/);
          if (lead >= Math.min(contentIndent, indent + 2)) {
            content.push(next.slice(Math.min(lead, contentIndent)));
            i++;
          } else if (!isBlockStart(next) && lead > indent - 1 && !LIST.test(next)) {
            content.push(next.trim()); // lazy continuation
            i++;
          } else break;
        }
        let checked: boolean | null = null;
        const task = /^\[([ xX])\]\s+/.exec(content[0] ?? "");
        if (task) {
          checked = task[1] !== " ";
          content[0] = (content[0] ?? "").slice(task[0].length);
        }
        items.push({ checked, children: parseBlocks(content) });
        while (i < lines.length && !(lines[i] ?? "").trim() && LIST.exec(lines[i + 1] ?? "")?.[1]?.length === indent) i++;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    if (line.includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1] ?? "").map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim()) {
        rows.push(splitRow(lines[i] ?? "").map(parseInline));
        i++;
      }
      blocks.push({ type: "table", align, header: header.map(parseInline), rows });
      continue;
    }

    // Paragraph: until a blank line or another block starts.
    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() && !isBlockStart(lines[i] ?? "")) {
      if ((lines[i] ?? "").includes("|") && TABLE_SEP.test(lines[i + 1] ?? "")) break;
      para.push(lines[i] ?? "");
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n").replace(/^ +/gm, "")) });
  }
  return blocks;
}
