/**
 * Editable CodeMirror for YAML (studio editor) and Markdown (memory documents). Themed from the
 * design tokens (the same theme as the UI kit's diff view), lazy-loaded via ./LazyCodeEditor.
 *
 * - `issues` paint error/warning lines and gutter dots; `reveal` scrolls to and selects a line.
 * - ⌘S calls `onSave`, Tab indents with spaces, Esc leaves the editor (keyboard users can move on).
 * - `value` is the source of truth: external changes (loading another version) replace the doc.
 */
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, gutter, GutterMarker, keymap, type DecorationSet } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";

import { studioEditorTheme } from "@/ui/code/editorTheme";

export interface EditorIssueMark {
  line: number;
  level: "error" | "warning";
  message: string;
}

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: "yaml" | "markdown";
  readOnly?: boolean;
  issues?: EditorIssueMark[];
  /** Scroll to and select this 1-based line whenever `nonce` changes. */
  reveal?: { line: number; nonce: number } | null;
  onSave?: () => void;
  autoFocus?: boolean;
  ariaLabel: string;
  className?: string;
}

const setIssues = StateEffect.define<EditorIssueMark[]>();

class IssueMarker extends GutterMarker {
  constructor(
    readonly level: "error" | "warning",
    readonly message: string,
  ) {
    super();
  }
  eq(other: IssueMarker) {
    return other.level === this.level && other.message === this.message;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-studio-issue-dot cm-studio-issue-dot-${this.level}`;
    el.title = this.message;
    return el;
  }
}

interface IssueState {
  lines: DecorationSet;
  markers: ReturnType<RangeSetBuilder<GutterMarker>["finish"]>;
}

function buildIssues(state: EditorState, issues: EditorIssueMark[]): IssueState {
  const byLine = new Map<number, EditorIssueMark>();
  for (const i of issues) {
    if (i.line < 1 || i.line > state.doc.lines) continue;
    const prev = byLine.get(i.line);
    if (!prev || (prev.level === "warning" && i.level === "error")) byLine.set(i.line, i);
  }
  const lines = new RangeSetBuilder<Decoration>();
  const markers = new RangeSetBuilder<GutterMarker>();
  for (const n of [...byLine.keys()].sort((a, b) => a - b)) {
    const issue = byLine.get(n)!;
    const line = state.doc.line(n);
    lines.add(line.from, line.from, Decoration.line({ class: `cm-studio-issue cm-studio-issue-${issue.level}` }));
    markers.add(line.from, line.from, new IssueMarker(issue.level, issue.message));
  }
  return { lines: lines.finish(), markers: markers.finish() };
}

const issueField = StateField.define<IssueState>({
  create: (state) => buildIssues(state, []),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setIssues)) return buildIssues(tr.state, e.value);
    return tr.docChanged ? { lines: value.lines.map(tr.changes), markers: value.markers.map(tr.changes) } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.lines),
});

const issueGutter = gutter({
  class: "cm-studio-issue-gutter",
  markers: (view) => view.state.field(issueField).markers,
});

const editorChrome = EditorView.theme({
  "&": { height: "100%", fontSize: "12.5px" },
  ".cm-scroller": { overflow: "auto", lineHeight: "1.65" },
  ".cm-content": { padding: "12px 0 40vh" },
  ".cm-gutters": { borderRight: "1px solid var(--line-subtle)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fg) 3%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--fg-muted)" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--fg-faint)", padding: "0 4px" },
  ".cm-studio-issue-gutter": { width: "10px" },
  ".cm-studio-issue-gutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-studio-issue-dot": { display: "block", width: "6px", height: "6px", borderRadius: "999px" },
  ".cm-studio-issue-dot-error": { background: "var(--danger)" },
  ".cm-studio-issue-dot-warning": { background: "var(--warning)" },
  ".cm-studio-issue-error": { backgroundColor: "color-mix(in srgb, var(--danger) 9%, transparent)" },
  ".cm-studio-issue-warning": { backgroundColor: "color-mix(in srgb, var(--warning) 9%, transparent)" },
  ".cm-tooltip": { background: "var(--surface-raised)", border: "1px solid var(--line)", borderRadius: "8px", color: "var(--fg)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { background: "var(--accent-soft)", color: "var(--fg)" },
  ".cm-panels": { background: "var(--surface)", color: "var(--fg)", borderColor: "var(--line)" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--warning) 25%, transparent)" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 12%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)", outline: "none" },
  ".cm-placeholder": { color: "var(--fg-faint)" },
});

export default function CodeEditor({ value, onChange, language, readOnly, issues, reveal, onSave, autoFocus, ariaLabel, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onSave });
  useEffect(() => {
    handlers.current = { onChange, onSave };
  });

  // Create once per language / read-only mode.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const extensions: Extension[] = [
      basicSetup,
      language === "yaml" ? yaml() : [markdown(), EditorView.lineWrapping],
      studioEditorTheme,
      editorChrome,
      syntaxHighlighting(classHighlighter),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      issueField,
      issueGutter,
      EditorView.contentAttributes.of({ "aria-label": ariaLabel, spellcheck: language === "markdown" ? "true" : "false" }),
      EditorState.readOnly.of(!!readOnly),
      EditorView.editable.of(!readOnly),
      Prec.high(
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              handlers.current.onSave?.();
              return true;
            },
          },
          {
            key: "Tab",
            run: (v) => {
              if (v.state.readOnly) return false;
              v.dispatch(v.state.replaceSelection("  "), { scrollIntoView: true, userEvent: "input" });
              return true;
            },
          },
          {
            key: "Escape",
            run: (v) => {
              v.contentDOM.blur();
              return true;
            },
          },
        ]),
      ),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) handlers.current.onChange?.(u.state.doc.toString());
      }),
    ];
    const v = new EditorView({ parent, state: EditorState.create({ doc: value, extensions }) });
    view.current = v;
    if (autoFocus) v.focus();
    return () => {
      v.destroy();
      view.current = null;
    };
    // `value` is synced by the effect below; recreating on every keystroke would lose state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, readOnly, ariaLabel]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current !== value) v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: setIssues.of(issues ?? []) });
  }, [issues]);

  useEffect(() => {
    const v = view.current;
    if (!v || !reveal) return;
    const n = Math.min(Math.max(1, reveal.line), v.state.doc.lines);
    const line = v.state.doc.line(n);
    v.dispatch({ selection: { anchor: line.from, head: line.to }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) });
    v.focus();
  }, [reveal]);

  return <div ref={host} className={className} data-selectable />;
}
