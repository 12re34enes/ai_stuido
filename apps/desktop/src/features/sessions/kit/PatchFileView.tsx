/**
 * One file of a parsed patch: a DiffView for edits, plain highlighted code for files that were
 * created or deleted (a diff against an empty side only adds noise), a header row otherwise.
 */
import { FileDiff } from "lucide-react";

import { CodeBlock, DiffView } from "@/ui";

import { sessionStrings as t } from "../strings";
import type { PatchFile } from "./patch";

const extOf = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1];

export function PatchFileView({ file, maxHeight = 360, label }: { file: PatchFile; maxHeight?: number; label?: string }) {
  const name = label ?? (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
  if (file.empty) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-code px-3 font-mono text-2xs text-fg-muted">
        <FileDiff className="size-3.5 text-fg-faint" aria-hidden />
        {name}
      </div>
    );
  }
  if (file.original === "" && file.deletions === 0) {
    return <CodeBlock code={file.modified} filename={`${name} · ${t.stream.newFile}`} language={extOf(file.path)} maxHeight={maxHeight} lineNumbers />;
  }
  if (file.modified === "" && file.additions === 0) {
    return (
      <CodeBlock code={file.original} filename={`${name} · ${t.stream.deletedFile}`} language={extOf(file.path)} maxHeight={maxHeight} lineNumbers className="opacity-80" />
    );
  }
  return <DiffView original={file.original} modified={file.modified} filename={name} maxHeight={maxHeight} />;
}
