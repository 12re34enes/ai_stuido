/**
 * CodeMirror theme built from design tokens (CSS variables), so editors and diffs follow the
 * active (or scoped) theme without reconfiguration. Syntax colors come from `tok-*` classes.
 */
import { EditorView } from "@codemirror/view";

export const studioEditorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--code-bg)",
    color: "var(--fg)",
    fontSize: "12px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--accent)" },
  ".cm-line": { padding: "0 12px" },
  ".cm-gutters": {
    backgroundColor: "var(--code-bg)",
    color: "var(--fg-faint)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 6px 0 12px", minWidth: "28px" },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-soft) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },

  // ---- merge / diff
  ".cm-mergeView": { backgroundColor: "var(--code-bg)" },
  ".cm-mergeViewEditor + .cm-mergeViewEditor": { borderLeft: "1px solid var(--line)" },
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "var(--diff-del-bg)" },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "var(--diff-add-bg)" },
  "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": {
    background: "var(--diff-del-strong)",
    borderRadius: "2px",
  },
  "&.cm-merge-b .cm-changedText": { background: "var(--diff-add-strong)", borderRadius: "2px" },
  ".cm-insertedLine, .cm-deletedLine, .cm-deletedLine del": { textDecoration: "none" },
  ".cm-deletedChunk": { paddingLeft: "0" },
  ".cm-deletedChunk .cm-deletedLine": { padding: "0 12px" },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0" },
  "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: "var(--danger)" },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--success)" },
  ".cm-inlineChangedLineGutter": { background: "var(--info)" },
  ".cm-collapsedLines": {
    padding: "4px 12px",
    margin: "2px 0",
    color: "var(--fg-muted)",
    fontFamily: "var(--font-sans)",
    fontSize: "11px",
    background: "var(--surface-sunken)",
    borderTop: "1px solid var(--line-subtle)",
    borderBottom: "1px solid var(--line-subtle)",
    cursor: "pointer",
  },
  ".cm-collapsedLines:before, .cm-collapsedLines:after": { display: "none" },
});
