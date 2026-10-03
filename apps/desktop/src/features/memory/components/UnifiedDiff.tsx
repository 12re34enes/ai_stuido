import { FileDiff, FileMinus, FilePlus } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, type ReactNode } from "react";

import { duration, ease } from "@/motion/tokens";
import { useReducedMotionPref } from "@/motion/hooks";
import { cn } from "@/ui";

import { parseUnifiedDiff, type DiffFile, type DiffLine } from "../diff";

const rowTone: Record<DiffLine["type"], string> = {
  add: "bg-[var(--diff-add-bg)]",
  del: "bg-[var(--diff-del-bg)]",
  ctx: "",
  meta: "text-fg-faint italic",
};

const marker: Record<DiffLine["type"], string> = { add: "+", del: "−", ctx: " ", meta: "" };

function FileBlock({ file, index }: { file: DiffFile; index: number }) {
  const reduced = useReducedMotionPref();
  const icon = file.status === "added" ? <FilePlus className="size-3.5 shrink-0 text-fg-faint" aria-hidden /> : file.status === "deleted" ? <FileMinus className="size-3.5 shrink-0 text-fg-faint" aria-hidden /> : <FileDiff className="size-3.5 shrink-0 text-fg-faint" aria-hidden />;
  // Running row index per hunk, so the reveal stagger flows across hunks.
  const offsets = file.hunks.map((_, i) => file.hunks.slice(0, i).reduce((n, h) => n + h.lines.length, 0));
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.standard, ease: ease.out, delay: Math.min(index, 6) * 0.05 }}
      className="overflow-hidden rounded-lg border border-line bg-code"
      aria-label={file.path}
    >
      <header className="flex h-9 items-center gap-2 border-b border-line-subtle px-3">
        {icon}
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">{file.path}</span>
        <span className="flex gap-1.5 font-mono text-2xs tabular">
          <span className="text-success">+{file.added}</span>
          <span className="text-danger">−{file.removed}</span>
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse font-mono text-xs leading-[1.6] [&_td]:align-top">
          <tbody>
            {file.hunks.map((h, hi) => (
              <HunkRows key={hi} lines={h.lines} header={h.header} section={h.section}>
                {(line, li) => {
                  const r = offsets[hi]! + li;
                  return (
                    <motion.tr
                      key={li}
                      className={rowTone[line.type]}
                      initial={reduced || r > 60 ? false : { opacity: 0, x: line.type === "add" ? 6 : line.type === "del" ? -6 : 0 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: duration.standard, ease: ease.out, delay: Math.min(r, 60) * 0.008 }}
                    >
                      <td className="w-10 px-2 text-right text-fg-faint select-none tabular">{line.oldNo ?? ""}</td>
                      <td className="w-10 px-2 text-right text-fg-faint select-none tabular">{line.newNo ?? ""}</td>
                      <td
                        className={cn(
                          "w-4 text-center select-none",
                          line.type === "add" ? "text-success" : line.type === "del" ? "text-danger" : "text-fg-faint",
                        )}
                      >
                        {marker[line.type]}
                      </td>
                      <td className="pr-4 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{line.text || "​"}</td>
                    </motion.tr>
                  );
                }}
              </HunkRows>
            ))}
          </tbody>
        </table>
      </div>
    </motion.section>
  );
}

function HunkRows({ lines, header, section, children }: { lines: DiffLine[]; header: string; section: string; children: (line: DiffLine, i: number) => ReactNode }) {
  return (
    <>
      <tr className="bg-surface-sunken/70">
        <td colSpan={4} className="px-3 py-1 font-sans text-2xs text-fg-muted">
          <span className="font-mono">{header.replace(/ @@.*$/, " @@")}</span>
          {section && <span className="ml-2">{section}</span>}
        </td>
      </tr>
      {lines.map((l, i) => children(l, i))}
    </>
  );
}

/** Multi-file unified diff (git output) with line numbers; lines slide in on reveal. */
export function UnifiedDiff({ diff, className }: { diff: string; className?: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  return (
    <div className={cn("flex flex-col gap-3", className)} data-selectable>
      {files.map((f, i) => (
        <FileBlock key={`${f.path}-${i}`} file={f} index={i} />
      ))}
    </div>
  );
}
