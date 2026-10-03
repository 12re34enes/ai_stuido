/**
 * Turkish one-line descriptions of tool calls for the stream ("`pnpm test` çalıştırıldı",
 * "src/app.ts düzenlendi"). Built from the call's input so the tense follows its state
 * (running → present progressive, done → past); falls back to the adapter's summary.
 */
import { Bot, FilePen, FileText, Globe, Plug, Search, Sparkles, SquareTerminal, Wrench, type LucideIcon } from "lucide-react";

import type { ToolItem, ToolKind } from "./model";

export const toolIcon: Record<ToolKind, LucideIcon> = {
  command: SquareTerminal,
  file_read: FileText,
  file_edit: FilePen,
  search: Search,
  web: Globe,
  mcp: Plug,
  studio: Sparkles,
  subagent: Bot,
  other: Wrench,
};

export const toolKindLabel: Record<ToolKind, string> = {
  command: "Komut",
  file_read: "Dosya okuma",
  file_edit: "Dosya düzenleme",
  search: "Arama",
  web: "Web",
  mcp: "MCP aracı",
  studio: "Studio aracı",
  subagent: "Alt ajan",
  other: "Araç",
};

export interface ToolDescription {
  /** Leading verb phrase or sentence. */
  text: string;
  /** Monospace target shown inline (command, path, pattern), or null. */
  code: string | null;
  /** Text after the code ("çalıştırıldı"). */
  after: string;
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function firstLine(text: string, limit = 96): string {
  const lines = text.trim().split("\n");
  const line = (lines[0] ?? "").trimEnd();
  const cut = line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
  return lines.length > 1 && cut === line ? `${cut} …` : cut;
}

/** Path relative to cwd when inside it. */
export function relPath(path: string, cwd?: string | null): string {
  if (!cwd || !path.startsWith("/")) return path;
  const base = cwd.replace(/\/+$/, "");
  if (path === base) return ".";
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/** Strip a `bash -lc '…'` wrapper Codex puts around shell commands. */
export function unwrapShell(command: string): string {
  const m = /^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(command.trim());
  return m?.[2] ?? command;
}

function commandOf(input: Record<string, unknown>): string | null {
  const c = input.command;
  if (Array.isArray(c)) {
    const parts = c.filter((x): x is string => typeof x === "string");
    if (parts.length >= 3 && /sh$/.test(parts[0] ?? "") && parts[1]?.startsWith("-")) return parts.slice(2).join(" ");
    return parts.join(" ") || null;
  }
  const v = s(c) ?? s(input.cmd);
  return v ? unwrapShell(v) : null;
}

function pathOf(input: Record<string, unknown>, cwd?: string | null): string | null {
  const p = s(input.file_path) ?? s(input.notebook_path) ?? s(input.path);
  if (p) return relPath(p, cwd);
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const first = changes[0] as Record<string, unknown> | undefined;
  const fp = first ? s(first.path) : null;
  if (fp) return changes.length > 1 ? `${relPath(fp, cwd)} +${changes.length - 1}` : relPath(fp, cwd);
  return null;
}

/** The command a tool call runs (for the LogView header and copy). */
export function toolCommand(item: Pick<ToolItem, "input" | "toolKind">): string | null {
  return item.toolKind === "command" ? commandOf(item.input) : null;
}

export function describeTool(item: Pick<ToolItem, "tool" | "toolKind" | "input" | "summary" | "result">, cwd?: string | null): ToolDescription {
  const done = item.result !== null;
  const failed = item.result?.isError === true;
  const input = item.input;
  const tense = (running: string, finished: string, error: string) => (failed ? error : done ? finished : running);
  const name = item.tool;

  switch (item.toolKind) {
    case "command": {
      const cmd = commandOf(input);
      if (cmd) return { text: "", code: firstLine(cmd), after: tense("çalıştırılıyor", "çalıştırıldı", "başarısız oldu") };
      break;
    }
    case "file_read": {
      const p = pathOf(input, cwd);
      if (p) return { text: "", code: p, after: tense("okunuyor", "okundu", "okunamadı") };
      break;
    }
    case "file_edit": {
      const p = pathOf(input, cwd);
      const created = name === "Write";
      if (p)
        return {
          text: "",
          code: p,
          after: created ? tense("yazılıyor", "yazıldı", "yazılamadı") : tense("düzenleniyor", "düzenlendi", "düzenlenemedi"),
        };
      break;
    }
    case "search": {
      const pattern = s(input.pattern) ?? s(input.query);
      if (pattern) return { text: "", code: firstLine(pattern, 60), after: tense("aranıyor", "arandı", "aranamadı") };
      const p = pathOf(input, cwd);
      if (p) return { text: "", code: p, after: tense("listeleniyor", "listelendi", "listelenemedi") };
      break;
    }
    case "web": {
      const url = s(input.url);
      if (url) return { text: "", code: firstLine(url, 72), after: tense("getiriliyor", "getirildi", "getirilemedi") };
      const q = s(input.query);
      if (q) return { text: "Web'de", code: firstLine(q, 60), after: tense("aranıyor", "arandı", "aranamadı") };
      break;
    }
    case "subagent": {
      const desc = s(input.description) ?? s(input.subagent_type) ?? s(input.prompt);
      return { text: tense("Alt ajan çalışıyor", "Alt ajan bitti", "Alt ajan başarısız"), code: null, after: desc ? `· ${firstLine(desc, 60)}` : "" };
    }
    case "studio": {
      const short = name.replace(/^mcp__[^_]+__/, "");
      return { text: tense("Studio aracı", "Studio aracı", "Studio aracı"), code: short, after: tense("çalışıyor", "kullanıldı", "başarısız oldu") };
    }
    case "mcp": {
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      return { text: "MCP", code: m ? `${m[1]}/${m[2]}` : name, after: tense("çağrılıyor", "çağrıldı", "başarısız oldu") };
    }
    default:
      break;
  }
  if (name === "TodoWrite")
    return { text: tense("Yapılacaklar güncelleniyor", "Yapılacaklar güncellendi", "Yapılacaklar güncellenemedi"), code: null, after: "" };
  if (item.summary) return { text: item.summary, code: null, after: "" };
  return { text: "", code: name, after: tense("kullanılıyor", "kullanıldı", "başarısız oldu") };
}

/** Plain-text form (accessibility labels, tests). */
export function describeToolText(item: Parameters<typeof describeTool>[0], cwd?: string | null): string {
  const d = describeTool(item, cwd);
  return [d.text, d.code, d.after].filter(Boolean).join(" ");
}
