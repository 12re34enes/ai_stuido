/**
 * Syntax highlighting without an editor: parse with the CodeMirror language for `name` (loaded
 * lazily from @codemirror/language-data) and emit token classes (`tok-keyword` …) that
 * styles/code.css colors from design tokens. Works for both themes with no JS theme switch.
 */
import type { Language } from "@codemirror/language";

export interface Token {
  text: string;
  cls: string;
}

const cache = new Map<string, Promise<Language | null>>();

/** Resolve "ts", "tsx", "python", "yaml", "diff" … to a CodeMirror Language (null if unknown). */
export function loadLanguage(name: string | undefined): Promise<Language | null> {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return Promise.resolve(null);
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      const { languages } = await import("@codemirror/language-data");
      const { LanguageDescription } = await import("@codemirror/language");
      const desc =
        LanguageDescription.matchLanguageName(languages, key, true) ?? LanguageDescription.matchFilename(languages, `x.${key}`);
      if (!desc) return null;
      const support = await desc.load();
      return support.language;
    })().catch(() => null);
    cache.set(key, p);
  }
  return p;
}

/** Tokenize code into lines of class-tagged spans. */
export async function highlightLines(code: string, language: string | undefined): Promise<Token[][] | null> {
  const lang = await loadLanguage(language);
  if (!lang) return null;
  const { highlightCode, classHighlighter } = await import("@lezer/highlight");
  const tree = lang.parser.parse(code);
  const lines: Token[][] = [[]];
  highlightCode(
    code,
    tree,
    classHighlighter,
    (text, cls) => lines[lines.length - 1]!.push({ text, cls }),
    () => lines.push([]),
  );
  return lines;
}
