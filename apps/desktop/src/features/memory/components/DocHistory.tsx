import { useQuery } from "@tanstack/react-query";
import { GitCommitVertical, History, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { ApiError } from "@/lib/api";
import { variants } from "@/motion/tokens";
import { Button, Dialog, DiffView, EmptyState, SegmentedControl, Skeleton, SkeletonText, toast } from "@/ui";

import { LoadError } from "@/features/studios/components/Page";

import { fetchDocAt, memoryKeys, useHistory, useWriteDoc } from "../api";
import { forDiff } from "../markdown";
import { memoryStrings as s } from "../strings";
import type { MemoryDoc } from "../types";
import { CommitList } from "./CommitList";

function useDocAt(ws: string, path: string, commit: string | null) {
  return useQuery({
    queryKey: memoryKeys.doc(ws, path, commit ?? "none"),
    queryFn: () => fetchDocAt(ws, path, commit!),
    enabled: !!commit,
    staleTime: Infinity,
    retry: false,
  });
}

/** One document's commits; selecting one shows what it changed (or how it differs from now). */
export function DocHistory({ ws, doc, onRestored }: { ws: string; doc: MemoryDoc; onRestored: () => void }) {
  const history = useHistory(ws, doc.path);
  const commits = history.data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [compare, setCompare] = useState<"previous" | "current">("previous");
  const [confirm, setConfirm] = useState(false);
  const write = useWriteDoc(ws);

  const selected = picked ?? commits[0]?.sha ?? null;
  const index = commits.findIndex((c) => c.sha === selected);
  const commit = index >= 0 ? commits[index]! : null;
  const previous = index >= 0 ? (commits[index + 1] ?? null) : null;
  const at = useDocAt(ws, doc.path, selected);
  const before = useDocAt(ws, doc.path, compare === "previous" ? (previous?.sha ?? null) : null);

  const original = compare === "previous" ? (previous ? before.data?.content : "") : at.data?.content;
  const modified = compare === "previous" ? at.data?.content : doc.content;
  const loading = original === undefined || modified === undefined;
  const isLatest = index === 0;

  const restore = () => {
    if (!at.data || !commit) return;
    write.mutate(
      { path: doc.path, content: at.data.content, message: s.restoreDocMessage(doc.path, commit.short_sha) },
      {
        onSuccess: () => {
          setConfirm(false);
          toast.success(s.restoredDoc, { description: s.restoreDocMessage(doc.path, commit.short_sha) });
          onRestored();
        },
        onError: (err) => toast.error(s.restoreFailed, { description: err instanceof ApiError ? err.message : undefined }),
      },
    );
  };

  if (history.isPending)
    return (
      <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-5" aria-busy>
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={46} className="rounded-lg" />
          ))}
        </div>
        <Skeleton height={320} className="rounded-lg" />
      </div>
    );
  if (history.isError) return <LoadError title={s.historyLoadError} error={history.error} onRetry={() => void history.refetch()} />;
  if (commits.length === 0) return <EmptyState icon={<History />} title={s.historyEmpty} />;

  return (
    <motion.div {...variants.fadeUp} className="grid grid-cols-[280px_minmax(0,1fr)] items-start gap-5">
      <div className="max-h-[calc(100vh-var(--topbar-height)-220px)] overflow-y-auto pr-1">
        <CommitList commits={commits} selected={selected} onSelect={setPicked} layoutId="memory-doc-commit" />
      </div>
      <section className="flex min-w-0 flex-col gap-3" aria-label={commit?.message ?? s.historyTitle}>
        <div className="flex items-center justify-between gap-3">
          <SegmentedControl
            size="sm"
            aria-label={s.historyTitle}
            value={compare}
            onValueChange={setCompare}
            options={[
              { value: "previous", label: s.compareToPrevious },
              { value: "current", label: s.compareToCurrent, disabled: isLatest },
            ]}
          />
          <Button size="sm" variant="secondary" icon={<RotateCcw />} disabled={isLatest || !at.data} onClick={() => setConfirm(true)}>
            {s.restoreDoc}
          </Button>
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          {loading ? (
            <motion.div key="loading" {...variants.fade}>
              <SkeletonText lines={8} />
            </motion.div>
          ) : original === modified ? (
            <motion.p key="same" {...variants.fadeUp} className="rounded-lg bg-surface-sunken px-4 py-6 text-center text-xs text-fg-muted">
              {s.noChanges}
            </motion.p>
          ) : (
            <motion.div key={`${selected}-${compare}`} {...variants.fadeUp} className="flex flex-col gap-2">
              {compare === "previous" && !previous && (
                <p className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <GitCommitVertical className="size-3.5" />
                  {s.firstVersionHint}
                </p>
              )}
              <DiffView original={forDiff(original)} modified={forDiff(modified)} filename={doc.path} language="markdown" maxHeight={560} />
            </motion.div>
          )}
        </AnimatePresence>
      </section>
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={s.restoreDocTitle(commit?.short_sha ?? "")}
        description={s.restoreDocDescription}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {s.cancel}
            </Button>
            <Button variant="primary" icon={<RotateCcw />} loading={write.isPending} onClick={restore}>
              {s.restoreDoc}
            </Button>
          </>
        }
      />
    </motion.div>
  );
}
