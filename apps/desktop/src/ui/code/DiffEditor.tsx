/**
 * CodeMirror merge view (lazy-loaded by DiffView so the editor stays out of the main bundle).
 */
import { syntaxHighlighting } from "@codemirror/language";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { useEffect, useRef } from "react";

import { studioEditorTheme } from "./editorTheme";
import { loadLanguage } from "./highlight";

export interface DiffEditorProps {
  original: string;
  modified: string;
  language?: string;
  mode: "unified" | "split";
}

function base(lang: Compartment): Extension[] {
  return [
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    lineNumbers(),
    studioEditorTheme,
    syntaxHighlighting(classHighlighter),
    lang.of([]),
  ];
}

export default function DiffEditor({ original, modified, language, mode }: DiffEditorProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const langA = new Compartment();
    const langB = new Compartment();
    const collapse = { margin: 3, minSize: 6 };
    let views: EditorView[];
    let destroy: () => void;
    if (mode === "split") {
      const mv = new MergeView({
        a: { doc: original, extensions: base(langA) },
        b: { doc: modified, extensions: base(langB) },
        parent,
        gutter: true,
        highlightChanges: true,
        collapseUnchanged: collapse,
      });
      views = [mv.a, mv.b];
      destroy = () => mv.destroy();
    } else {
      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: modified,
          extensions: [
            ...base(langB),
            unifiedMergeView({ original, mergeControls: false, gutter: true, highlightChanges: true, collapseUnchanged: collapse }),
          ],
        }),
      });
      views = [view];
      destroy = () => view.destroy();
    }
    let alive = true;
    void loadLanguage(language).then((lang) => {
      if (!alive || !lang) return;
      const compartments = mode === "split" ? [langA, langB] : [langB];
      views.forEach((v, i) => v.dispatch({ effects: compartments[i]!.reconfigure(lang) }));
    });
    return () => {
      alive = false;
      destroy();
    };
  }, [language, mode, modified, original]);

  return <div ref={host} className="min-h-0 [&_.cm-mergeView]:min-w-0" />;
}
