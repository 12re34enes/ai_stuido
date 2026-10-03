/**
 * CodeMirror merge view (lazy-loaded by DiffView so the editor stays out of the main bundle).
 */
import { syntaxHighlighting } from "@codemirror/language";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, gutter, GutterMarker, lineNumbers } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { useEffect, useRef } from "react";

import { wholeFileKind } from "./diffStats";
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

class ChangeMarker extends GutterMarker {}
const changeMarker = new ChangeMarker();

/**
 * A new or deleted file. With one side empty the merge view shows a phantom empty deleted line and
 * marks every token as an intra-line change; here the whole document is simply added or removed.
 */
function wholeFile(kind: "added" | "removed"): Extension {
  return [
    gutter({ class: "cm-changeGutter", lineMarker: () => changeMarker, initialSpacer: () => changeMarker }),
    EditorView.theme({
      ".cm-line": { backgroundColor: kind === "added" ? "var(--diff-add-bg)" : "var(--diff-del-bg)" },
      ".cm-changeGutter .cm-gutterElement": { background: kind === "added" ? "var(--success)" : "var(--danger)" },
    }),
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
    const whole = wholeFileKind(original, modified);
    let views: EditorView[];
    let destroy: () => void;
    if (whole && mode === "unified") {
      const view = new EditorView({
        parent,
        state: EditorState.create({ doc: whole === "added" ? modified : original, extensions: [...base(langB), wholeFile(whole)] }),
      });
      views = [view];
      destroy = () => view.destroy();
    } else if (mode === "split") {
      const mv = new MergeView({
        a: { doc: original, extensions: base(langA) },
        b: { doc: modified, extensions: base(langB) },
        parent,
        gutter: true,
        highlightChanges: !whole,
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
