/**
 * CodeMirror editor for prompt templates (`template`), condition expressions (`expression`) and
 * small JSON documents (`json`). Token-themed, grows with its content, and suggests template
 * variables from the current graph.
 */
import { json } from "@codemirror/lang-json";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, placeholder as placeholderExt } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { minimalSetup } from "codemirror";
import { useEffect, useRef } from "react";

import { studioEditorTheme } from "@/ui/code/editorTheme";
import { cn } from "@/ui";

import type { TemplateVar } from "../../model/templateVars";
import { setVariables, templateSupport } from "./templateSupport";

export interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  mode?: "template" | "expression" | "json";
  /** Template variables for suggestions (template / expression modes). */
  variables?: TemplateVar[];
  /** Existing node ids (references to other ids are underlined). */
  nodeIds?: string[];
  placeholder?: string;
  /** Single line: Enter does not insert a newline (titles, branch names, expressions). */
  singleLine?: boolean;
  minLines?: number;
  maxHeight?: number;
  invalid?: boolean;
  readOnly?: boolean;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  className?: string;
}

const editorChrome = EditorView.theme({
  "&": { backgroundColor: "transparent", fontSize: "12px", minHeight: "inherit" },
  ".cm-content": { padding: "6px 0", fontFamily: "var(--font-mono)" },
  ".cm-line": { padding: "0 10px" },
  ".cm-scroller": { lineHeight: "1.6", fontFamily: "var(--font-mono)", flexGrow: "1", cursor: "text" },
});

const singleLineFilter = EditorState.transactionFilter.of((tr) => (tr.newDoc.lines > 1 ? [] : tr));

export function PromptEditor({
  value,
  onChange,
  mode = "template",
  variables,
  nodeIds,
  placeholder,
  singleLine = false,
  minLines = 3,
  maxHeight = 320,
  invalid,
  readOnly,
  id,
  className,
  ...aria
}: PromptEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const editable = useRef(new Compartment());
  /** True while we push an external value into the editor (not a user edit: no onChange). */
  const syncing = useRef(false);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // Create once per mode; value/variables sync below without recreating the view.
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const extensions: Extension[] = [
      minimalSetup,
      studioEditorTheme,
      editorChrome,
      syntaxHighlighting(classHighlighter),
      EditorView.lineWrapping,
      editable.current.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(!!readOnly)]),
      EditorView.contentAttributes.of({
        "aria-label": aria["aria-label"] ?? "",
        ...(aria["aria-describedby"] ? { "aria-describedby": aria["aria-describedby"] } : {}),
        ...(id ? { id } : {}),
        "aria-multiline": String(!singleLine),
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !syncing.current) onChangeRef.current(u.state.doc.toString());
      }),
    ];
    if (placeholder) extensions.push(placeholderExt(placeholder));
    if (singleLine) extensions.push(singleLineFilter);
    if (mode === "json") extensions.push(json());
    else extensions.push(templateSupport(mode));
    const v = new EditorView({ parent, state: EditorState.create({ doc: value, extensions }) });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the view is created once per mode
  }, [mode, singleLine]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    syncing.current = true;
    try {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    } finally {
      syncing.current = false;
    }
  }, [value]);

  useEffect(() => {
    const v = view.current;
    if (!v || mode === "json") return;
    v.dispatch({ effects: setVariables.of({ vars: variables ?? [], nodeIds: nodeIds ?? [] }) });
  }, [variables, nodeIds, mode]);

  useEffect(() => {
    view.current?.dispatch({
      effects: editable.current.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(!!readOnly)]),
    });
  }, [readOnly]);

  const lineHeight = 19.2;
  return (
    <div
      ref={host}
      data-testid={id ? `editor-${id}` : undefined}
      className={cn(
        "studio-prompt-editor overflow-auto rounded-md border bg-code transition-[border-color,box-shadow] duration-150",
        invalid
          ? "border-danger focus-within:shadow-[0_0_0_3px_var(--danger-soft)]"
          : "border-line hover:border-line-strong focus-within:border-accent focus-within:shadow-[var(--focus-ring)]",
        readOnly && "opacity-70",
        className,
      )}
      style={{ minHeight: singleLine ? undefined : Math.round(minLines * lineHeight + 14), maxHeight }}
    />
  );
}
