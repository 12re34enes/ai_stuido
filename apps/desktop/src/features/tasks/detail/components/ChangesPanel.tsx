/**
 * Changes of a run (spec §7): its worktrees, each with a file tree + diff and a merge-tree
 * preview against the target branch (clean / conflicting paths).
 */
import { AlertTriangle, CircleCheck, Code2, Copy, FileWarning, FolderOpen, GitBranch, GitMerge, GitPullRequestArrow } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

import { openInEditor, revealInFinder } from "@/native";
import { spring, variants } from "@/motion/tokens";
import { Badge, cn, DiffView, EmptyState, IconButton, SegmentedControl, Skeleton, SkeletonText, toast } from "@/ui";

import { useMergePreview, useRunWorktrees, useWorktreeDiff } from "../api";
import { buildFileTree, flattenTree, patchToTexts } from "../patch";
import { s } from "../strings";
import type { FileDiff, Repo, Worktree } from "../types";
import { SectionError } from "./bits";
import { FileCounts, FileTree } from "./FileTree";

function shortSha(sha: string) {
  return sha.slice(0, 7);
}

function MergePreviewRow({ worktree }: { worktree: Worktree }) {
  const q = useMergePreview(worktree.id);
  if (q.isPending) {
    return <Skeleton height={40} className="rounded-lg" />;
  }
  if (q.isError) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  const mp = q.data;
  return (
    <motion.div
      {...variants.fadeUp}
      className={cn(
        "flex flex-col gap-2 rounded-lg border px-3 py-2.5",
        mp.clean ? "border-success/25 bg-success-soft/40" : "border-danger/30 bg-danger-soft/40",
      )}
    >
      <div className="flex items-center gap-2.5 text-sm">
        {mp.clean ? <CircleCheck className="size-4 shrink-0 text-success" aria-hidden /> : <AlertTriangle className="size-4 shrink-0 text-danger" aria-hidden />}
        <span className="font-medium text-fg">{s.mergePreview}</span>
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-fg-muted">
          <span className="truncate">{worktree.branch}</span>
          <span aria-hidden className="text-fg-faint">{s.into}</span>
          <span className="truncate">{mp.target_ref}</span>
          <span className="text-fg-faint">@{shortSha(mp.target_sha)}</span>
        </span>
        <span className={cn("ml-auto shrink-0 text-xs font-medium", mp.clean ? "text-success" : "text-danger")}>
          {mp.clean ? s.mergeClean : s.mergeConflicts(mp.conflicts.length)}
        </span>
      </div>
      {!mp.clean && mp.conflicts.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pl-6">
          {mp.conflicts.map((c) => (
            <li key={c}>
              <code className="rounded-[5px] bg-surface px-1.5 py-0.5 font-mono text-2xs text-danger shadow-1">{c}</code>
            </li>
          ))}
        </ul>
      )}
    </motion.div>
  );
}

function FileDiffView({ file, truncated }: { file: FileDiff; truncated: boolean }) {
  const texts = useMemo(() => patchToTexts(file.patch), [file.patch]);
  if (file.status === "binary" || (!file.patch && file.status !== "deleted" && file.status !== "added")) {
    return (
      <div className="grid h-40 place-items-center rounded-lg border border-line bg-code">
        <span className="flex items-center gap-2 text-sm text-fg-muted">
          <FileWarning className="size-4" aria-hidden />
          {file.status === "binary" ? s.binaryFile : s.largeFile}
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <DiffView original={texts.original} modified={texts.modified} filename={file.path} maxHeight={560} />
      {truncated && <p className="text-2xs text-fg-faint">{s.truncated}</p>}
    </div>
  );
}

function WorktreeChanges({ worktree, repo }: { worktree: Worktree; repo?: Repo }) {
  const q = useWorktreeDiff(worktree.id);
  const tree = useMemo(() => buildFileTree(q.data?.files ?? []), [q.data]);
  const files = useMemo(() => flattenTree(tree), [tree]);
  const [picked, setPicked] = useState<string | null>(null);
  const selectedPath = picked && files.some((f) => f.path === picked) ? picked : (files[0]?.path ?? null);
  const selected = files.find((f) => f.path === selectedPath) ?? null;

  const copyPath = () => {
    void navigator.clipboard?.writeText(worktree.path).then(() => toast.success(s.copied), () => undefined);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-fg-muted">
          <GitBranch className="size-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <code className="truncate font-mono text-sm text-fg" data-selectable>
              {worktree.branch}
            </code>
            <Badge tone={worktree.status === "active" ? "accent" : worktree.status === "merged" ? "success" : "neutral"}>{s.worktreeStatus[worktree.status]}</Badge>
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
            {repo?.name && <span>{repo.name}</span>}
            {repo?.name && <span aria-hidden className="text-fg-faint">·</span>}
            <span className="font-mono text-2xs">
              {worktree.base_ref}@{shortSha(worktree.base_sha)}
            </span>
            {q.data && (
              <>
                <span aria-hidden className="text-fg-faint">·</span>
                <span>{s.files(q.data.files.length)}</span>
                <FileCounts file={q.data} />
              </>
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label={s.openInEditor} icon={<Code2 />} onClick={() => void openInEditor(worktree.path)} />
          <IconButton label={s.revealInFinder} icon={<FolderOpen />} onClick={() => void revealInFinder(worktree.path)} />
          <IconButton label={s.copyPath} icon={<Copy />} onClick={copyPath} />
        </div>
      </div>

      <MergePreviewRow worktree={worktree} />

      {q.isPending ? (
        <div className="grid grid-cols-[240px_minmax(0,1fr)] gap-4">
          <SkeletonText lines={6} />
          <Skeleton height={220} className="rounded-lg" />
        </div>
      ) : q.isError ? (
        <SectionError error={q.error} onRetry={() => void q.refetch()} />
      ) : files.length === 0 ? (
        <EmptyState size="sm" icon={<GitPullRequestArrow />} title={s.noChangesTitle} description={s.noChangesBody} />
      ) : (
        <div className="grid grid-cols-[240px_minmax(0,1fr)] items-start gap-4">
          <div className="sticky top-4 max-h-[560px] overflow-y-auto rounded-lg border border-line bg-surface p-1">
            <FileTree tree={tree} selected={selectedPath} onSelect={setPicked} />
          </div>
          <div className="min-w-0" aria-live="polite">
            <AnimatePresence mode="popLayout" initial={false}>
              {selected && (
                <motion.div key={selected.path} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0, transition: spring.smooth }} exit={{ opacity: 0, transition: { duration: 0.1 } }} aria-label={s.diffOf(selected.path)}>
                  <FileDiffView file={selected} truncated={Boolean(q.data?.truncated)} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}
    </div>
  );
}

export function ChangesPanel({ runId, repos }: { runId: string | null; repos?: Repo[] }) {
  const q = useRunWorktrees(runId);
  const worktrees = useMemo(() => (q.data ?? []).filter((w) => w.status !== "removed"), [q.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked && worktrees.some((w) => w.id === picked) ? picked : (worktrees[0]?.id ?? null);
  const selected = worktrees.find((w) => w.id === selectedId);

  if (!runId) return <EmptyState size="sm" icon={<GitMerge />} title={s.noChangesTitle} description={s.noChangesBody} />;
  if (q.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton height={32} width="40%" />
        <Skeleton height={40} className="rounded-lg" />
        <SkeletonText lines={5} />
      </div>
    );
  }
  if (q.isError) return <SectionError error={q.error} onRetry={() => void q.refetch()} />;
  if (worktrees.length === 0) return <EmptyState size="sm" icon={<GitMerge />} title={s.noChangesTitle} description={s.noChangesBody} />;

  return (
    <div className="flex flex-col gap-5">
      {worktrees.length > 1 && (
        <SegmentedControl
          size="sm"
          aria-label={s.worktrees}
          value={selectedId ?? ""}
          onValueChange={setPicked}
          options={worktrees.map((w) => ({ value: w.id, label: w.label ?? w.branch.split("/").pop() ?? w.id, hint: w.branch }))}
        />
      )}
      {selected && (
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={selected.id} {...variants.fadeUp}>
            <WorktreeChanges worktree={selected} repo={repos?.find((r) => r.id === selected.repo_id)} />
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}
