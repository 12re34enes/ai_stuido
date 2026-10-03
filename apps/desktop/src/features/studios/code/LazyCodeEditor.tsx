/** Lazy wrapper so CodeMirror's editing packages stay out of the page chunks until needed. */
import { lazy, Suspense } from "react";

import { SkeletonText } from "@/ui";

import type { CodeEditorProps } from "./CodeEditor";

const CodeEditor = lazy(() => import("./CodeEditor"));

export type { CodeEditorProps, EditorIssueMark } from "./CodeEditor";

export function LazyCodeEditor(props: CodeEditorProps) {
  return (
    <Suspense fallback={<SkeletonText lines={8} className={`p-4 ${props.className ?? ""}`} />}>
      <CodeEditor {...props} />
    </Suspense>
  );
}
