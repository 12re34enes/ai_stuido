import { FileText, History, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { ApiError } from "@/lib/api";
import { variants } from "@/motion/tokens";
import { Button, Dialog, EmptyState, Skeleton, SkeletonText, toast } from "@/ui";

import { LoadError } from "@/features/studios/components/Page";

import { useDiff, useHistory, useRestore } from "../api";
import { CommitList } from "../components/CommitList";
import { UnifiedDiff } from "../components/UnifiedDiff";
import { memoryStrings as s } from "../strings";

/** Whole-repo history: what each commit changed across files, and restoring the memory to a commit. */
export function HistoryPage({ ws }: { ws: string }) {
  const history = useHistory(ws);
  const commits = history.data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const restore = useRestore(ws);
  const selected = picked ?? commits[0]?.sha ?? null;
  const index = commits.findIndex((c) => c.sha === selected);
  const commit = index >= 0 ? commits[index]! : null;
  const parent = index >= 0 ? (commits[index + 1] ?? null) : null;
  const diff = useDiff(ws, parent?.sha, commit?.sha);

  const doRestore = () => {
    if (!commit) return;
    restore.mutate(commit.sha, {
      onSuccess: () => {
        setConfirm(false);
        setPicked(null);
        toast.success(s.restoredAll, { description: commit.short_sha });
      },
      onError: (err) => toast.error(s.restoreFailed, { description: err instanceof ApiError ? err.message : undefined }),
    });
  };

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-10 pt-8 pb-20">
      <header className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-2xl text-fg">{s.historyTitle}</h2>
          <p className="max-w-[620px] text-sm text-fg-muted">{s.historySubtitle}</p>
        </div>
        <Button variant="secondary" icon={<RotateCcw />} disabled={!commit || index === 0} onClick={() => setConfirm(true)}>
          {s.restoreAll}
        </Button>
      </header>
      {history.isError && !history.data ? (
        <LoadError title={s.historyLoadError} error={history.error} onRetry={() => void history.refetch()} className="mt-8" />
      ) : history.isPending ? (
        <div className="grid grid-cols-[320px_minmax(0,1fr)] gap-6" aria-busy>
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={52} className="rounded-lg" />
            ))}
          </div>
          <Skeleton height={360} className="rounded-lg" />
        </div>
      ) : commits.length === 0 ? (
        <EmptyState icon={<History />} title={s.historyEmpty} className="mt-8" />
      ) : (
        <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-6">
          <div className="sticky top-4 max-h-[calc(100vh-var(--topbar-height)-140px)] overflow-y-auto pr-1">
            <CommitList commits={commits} selected={selected} onSelect={setPicked} showPaths layoutId="memory-repo-commit" />
          </div>
          <section className="flex min-w-0 flex-col gap-3" aria-label={commit?.message ?? s.historyTitle}>
            {commit && (
              <motion.div key={commit.sha} {...variants.fadeUp} className="flex flex-col gap-1">
                <h3 className="text-lg text-fg">{commit.message}</h3>
                {commit.body && <p className="text-sm whitespace-pre-line text-fg-muted">{commit.body}</p>}
                <p className="text-xs text-fg-faint">
                  <span className="font-mono">{commit.short_sha}</span> · {s.files(commit.paths.length)}
                </p>
              </motion.div>
            )}
            <AnimatePresence mode="popLayout" initial={false}>
              {!parent && commit ? (
                <motion.div key={`first-${commit.sha}`} {...variants.fadeUp} className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4">
                  <span className="text-sm text-fg">{s.firstVersion}</span>
                  <ul className="flex flex-col gap-1">
                    {commit.paths.map((p) => (
                      <li key={p} className="flex items-center gap-2 font-mono text-xs text-fg-muted">
                        <FileText className="size-3.5 text-fg-faint" />
                        {p}
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ) : diff.isPending || !diff.data ? (
                <motion.div key="loading" {...variants.fade}>
                  <SkeletonText lines={10} />
                </motion.div>
              ) : diff.data.diff.trim() === "" ? (
                <motion.p key="empty" {...variants.fadeUp} className="rounded-lg bg-surface-sunken px-4 py-6 text-center text-xs text-fg-muted">
                  {s.noChanges}
                </motion.p>
              ) : (
                <motion.div key={`${diff.data.base}-${diff.data.head}`} {...variants.fadeUp} className="flex flex-col gap-2">
                  {diff.data.truncated && <p className="text-xs text-warning">{s.truncated}</p>}
                  <UnifiedDiff diff={diff.data.diff} />
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        </div>
      )}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={s.restoreAllTitle(commit?.short_sha ?? "")}
        description={s.restoreAllDescription}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {s.cancel}
            </Button>
            <Button variant="primary" icon={<RotateCcw />} loading={restore.isPending} onClick={doRestore}>
              {s.restoreAll}
            </Button>
          </>
        }
      />
    </div>
  );
}
