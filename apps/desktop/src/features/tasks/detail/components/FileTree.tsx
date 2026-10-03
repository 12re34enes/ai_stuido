/** Changed files as a collapsible tree with status letters and +/− counts; ↑/↓ moves the selection. */
import { ChevronRight, Folder } from "lucide-react";
import { motion } from "motion/react";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { spring } from "@/motion/tokens";
import { cn } from "@/ui";

import { flattenTree, statusLetter, type TreeNode } from "../patch";
import { s } from "../strings";
import type { FileDiff, FileStatus } from "../types";

const letterTone: Record<FileStatus, string> = {
  added: "text-success",
  modified: "text-warning",
  deleted: "text-danger",
  renamed: "text-info",
  copied: "text-info",
  binary: "text-fg-faint",
};

export function FileTree({ tree, selected, onSelect }: { tree: TreeNode[]; selected: string | null; onSelect: (path: string) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const layoutGroup = useId();
  const files = useMemo(() => flattenTree(tree), [tree]);
  const ref = useRef<HTMLUListElement>(null);

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = files.findIndex((f) => f.path === selected);
    const next = files[Math.max(0, Math.min(files.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      onSelect(next.path);
      requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)?.focus());
    }
  };

  const render = (nodes: TreeNode[], depth: number) =>
    nodes.map((n) => {
      if (n.type === "dir") {
        const open = !collapsed.has(n.path);
        return (
          <li key={`d:${n.path}`} role="treeitem" aria-expanded={open} aria-selected={false}>
            <button
              type="button"
              onClick={() => toggle(n.path)}
              tabIndex={-1}
              className="flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-xs text-fg-muted outline-none hover:bg-surface-hover"
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="flex text-fg-faint">
                <ChevronRight className="size-3" />
              </motion.span>
              <Folder className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs">{n.name}</span>
            </button>
            {open && (
              <ul role="group" className="flex flex-col">
                {render(n.children, depth + 1)}
              </ul>
            )}
          </li>
        );
      }
      const active = n.path === selected;
      return (
        <li key={`f:${n.path}`} role="treeitem" aria-selected={active}>
          <button
            type="button"
            data-path={n.path}
            onClick={() => onSelect(n.path)}
            tabIndex={active || (!selected && files[0]?.path === n.path) ? 0 : -1}
            title={n.path}
            className={cn(
              "relative flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
              active ? "text-fg" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
            )}
            style={{ paddingLeft: 10 + depth * 14 }}
          >
            {active && <motion.span layoutId={`${layoutGroup}-file`} transition={spring.layout} className="absolute inset-0 rounded-md bg-accent-soft" />}
            <span className={cn("relative w-3 shrink-0 text-center font-mono text-2xs font-semibold", letterTone[n.file.status])} aria-label={n.file.status}>
              {statusLetter[n.file.status]}
            </span>
            <span className="relative min-w-0 flex-1 truncate font-mono text-xs">{n.name}</span>
            <FileCounts file={n.file} />
          </button>
        </li>
      );
    });

  return (
    <ul ref={ref} role="tree" aria-label={s.fileTree} onKeyDown={onKey} className="flex flex-col">
      {render(tree, 0)}
    </ul>
  );
}

export function FileCounts({ file, className }: { file: Pick<FileDiff, "additions" | "deletions">; className?: string }) {
  return (
    <span className={cn("relative flex shrink-0 items-center gap-1 font-mono text-2xs tabular", className)}>
      {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
      {file.deletions > 0 && <span className="text-danger">−{file.deletions}</span>}
    </span>
  );
}
