import { FileDiff } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";

import { diffStats } from "./code/diffStats";
import { cn } from "./cn";
import { SegmentedControl } from "./SegmentedControl";
import { SkeletonText } from "./Skeleton";
import { uiStrings } from "./strings";

const DiffEditor = lazy(() => import("./code/DiffEditor"));

export interface DiffViewProps {
  original: string;
  modified: string;
  /** Language or extension for syntax colors; inferred from `filename` when omitted. */
  language?: string;
  filename?: string;
  mode?: "unified" | "split";
  /** Show the unified/split toggle in the header. */
  allowModeSwitch?: boolean;
  /** Max height before scrolling (px). */
  maxHeight?: number;
  className?: string;
}

function extensionOf(filename?: string) {
  const m = filename?.match(/\.([a-z0-9]+)$/i);
  return m?.[1];
}

/** Diff of two texts on CodeMirror's merge view, themed from design tokens. */
export function DiffView({
  original,
  modified,
  language,
  filename,
  mode: modeProp = "unified",
  allowModeSwitch = true,
  maxHeight,
  className,
}: DiffViewProps) {
  const [mode, setMode] = useState(modeProp);
  const stats = useMemo(() => diffStats(original, modified), [original, modified]);
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border border-line bg-code", className)}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line-subtle pr-1.5 pl-3">
        <FileDiff className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">{filename ?? ""}</span>
        <span className="flex items-center gap-1.5 font-mono text-2xs tabular">
          <span className="text-success">{uiStrings.additions(stats.added)}</span>
          <span className="text-danger">{uiStrings.deletions(stats.removed)}</span>
        </span>
        {allowModeSwitch && (
          <SegmentedControl
            size="sm"
            value={mode}
            onValueChange={setMode}
            aria-label="Görünüm"
            options={[
              { value: "unified", label: uiStrings.unifiedDiff },
              { value: "split", label: uiStrings.splitDiff },
            ]}
          />
        )}
      </div>
      <div className="min-h-0 overflow-auto" style={{ maxHeight }}>
        <Suspense fallback={<SkeletonText lines={6} className="p-4" />}>
          <DiffEditor original={original} modified={modified} language={language ?? extensionOf(filename)} mode={mode} />
        </Suspense>
      </div>
    </div>
  );
}
