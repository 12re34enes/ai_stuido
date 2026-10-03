/** Checkpoints of a run (spec §18): newest first, restore behind a confirmation dialog. */
import { BookMarked, GitCommitHorizontal, History, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { common } from "@/i18n/common";
import { formatDateTime, formatTime, relativeTime } from "@/i18n/format";
import { variants } from "@/motion/tokens";
import { Button, Dialog, EmptyState, Skeleton, Tooltip } from "@/ui";

import { s } from "../strings";
import type { CheckpointInfo } from "../types";
import { SectionError } from "./bits";

export interface CheckpointsProps {
  checkpoints: CheckpointInfo[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  nodeLabel: (nodeId: string) => string;
  onRestore: (ck: CheckpointInfo) => void;
  restoringId: string | null;
  disabled?: boolean;
}

export function Checkpoints({ checkpoints, loading, error, onRetry, nodeLabel, onRestore, restoringId, disabled }: CheckpointsProps) {
  const [confirm, setConfirm] = useState<CheckpointInfo | null>(null);
  if (error) return <SectionError error={error} onRetry={onRetry} />;
  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={52} className="rounded-lg" />
        ))}
      </div>
    );
  }
  const list = [...(checkpoints ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (list.length === 0) return <EmptyState size="sm" icon={<History />} title={s.noCheckpointsTitle} description={s.noCheckpointsBody} />;

  return (
    <>
      <ol className="relative flex flex-col" aria-label={s.tabCheckpoints}>
        <AnimatePresence initial={false}>
          {list.map((ck, i) => (
            <motion.li key={ck.id} layout {...variants.listItem} className="group relative flex gap-3 pb-1">
              <div className="flex w-7 shrink-0 flex-col items-center">
                <span className="mt-2.5 grid size-7 place-items-center rounded-full border border-line bg-surface text-fg-muted shadow-1">
                  <GitCommitHorizontal className="size-3.5" aria-hidden />
                </span>
                {i < list.length - 1 && <span aria-hidden className="mt-1 w-px flex-1 bg-line" />}
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2.5 transition-colors group-hover:bg-surface-hover">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-fg">{ck.label}</span>
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-muted">
                    <span>{nodeLabel(ck.node_id)}</span>
                    <span aria-hidden className="text-fg-faint">·</span>
                    <Tooltip content={formatDateTime(ck.created_at)}>
                      <span tabIndex={0} className="rounded-sm outline-none focus-visible:shadow-[var(--focus-ring)]">
                        {formatTime(ck.created_at)} · {relativeTime(ck.created_at)}
                      </span>
                    </Tooltip>
                    {Object.keys(ck.refs).length > 0 && (
                      <>
                        <span aria-hidden className="text-fg-faint">·</span>
                        <span>{s.refs(Object.keys(ck.refs).length)}</span>
                      </>
                    )}
                    {ck.memory_commit && (
                      <>
                        <span aria-hidden className="text-fg-faint">·</span>
                        <span className="inline-flex items-center gap-1">
                          <BookMarked className="size-3 text-fg-faint" aria-hidden />
                          {s.memoryCommit} <code className="font-mono text-2xs">{ck.memory_commit.slice(0, 7)}</code>
                        </span>
                      </>
                    )}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw />}
                  loading={restoringId === ck.id}
                  disabled={disabled}
                  onClick={() => setConfirm(ck)}
                  aria-label={`${s.restore}: ${ck.label}`}
                >
                  {s.restore}
                </Button>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={s.restoreTitle}
        description={confirm ? s.restoreBody(confirm.label) : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              {common.cancel}
            </Button>
            <Button
              variant="danger"
              icon={<RotateCcw />}
              onClick={() => {
                if (confirm) onRestore(confirm);
                setConfirm(null);
              }}
            >
              {s.restoreConfirm}
            </Button>
          </>
        }
      />
    </>
  );
}
