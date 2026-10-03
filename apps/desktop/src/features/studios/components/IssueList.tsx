import { CircleX, CloudOff, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";

import { variants } from "@/motion/tokens";
import { cn, Spinner } from "@/ui";
import { GateMark } from "@/ui/flow";

import { studioStrings as s } from "../strings";
import type { EditorIssue } from "../studioYaml";

export type ValidationState = "idle" | "parsing" | "validating" | "valid" | "invalid";

/** Header pill: validating spinner, error/warning counts or a drawn check. */
export function ValidationPill({ state, errors, warnings }: { state: ValidationState; errors: number; warnings: number }) {
  const key = state === "validating" ? "v" : errors ? `e${errors}` : warnings ? `w${warnings}` : state === "valid" ? "ok" : "idle";
  return (
    <span aria-live="polite" className="relative inline-flex h-7 items-center">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={key} {...variants.pop} className="inline-flex items-center gap-1.5 text-xs">
          {state === "validating" ? (
            <>
              <Spinner size={13} label="" className="text-fg-faint" />
              <span className="text-fg-muted">{s.validating}</span>
            </>
          ) : errors ? (
            <>
              <CircleX className="size-3.5 text-danger" aria-hidden />
              <span className="font-medium text-danger">{s.errors(errors)}</span>
              {warnings > 0 && <span className="text-fg-muted">· {s.warnings(warnings)}</span>}
            </>
          ) : warnings ? (
            <>
              <TriangleAlert className="size-3.5 text-warning" aria-hidden />
              <span className="text-fg-muted">{s.warnings(warnings)}</span>
            </>
          ) : state === "valid" ? (
            <>
              <GateMark status="passed" size={14} />
              <span className="text-fg-muted">{s.valid}</span>
            </>
          ) : null}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function IssueList({ issues, state, serverDown, onReveal }: { issues: EditorIssue[]; state: ValidationState; serverDown: boolean; onReveal: (line: number) => void }) {
  const sorted = [...issues].sort((a, b) => (a.level === b.level ? (a.line ?? 1e9) - (b.line ?? 1e9) : a.level === "error" ? -1 : 1));
  return (
    <div className="flex flex-col gap-3 p-4">
      <AnimatePresence initial={false}>
        {serverDown && (
          <motion.p key="down" {...variants.fadeUp} className="flex items-start gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-xs text-fg-muted">
            <CloudOff className="mt-px size-3.5 shrink-0" aria-hidden />
            {s.validationUnavailable}
          </motion.p>
        )}
      </AnimatePresence>
      {sorted.length === 0 ? (
        <AnimatePresence mode="popLayout" initial={false}>
          {state === "valid" ? (
            <motion.div key="valid" {...variants.fadeUp} className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <GateMark status="passed" size={36} />
              <div className="flex flex-col gap-1">
                <p className="font-serif text-md text-fg">{s.valid}</p>
                <p className="text-xs text-fg-muted">{s.validHint}</p>
              </div>
            </motion.div>
          ) : (
            <motion.div key="wait" {...variants.fade} className="flex items-center justify-center gap-2 py-10 text-xs text-fg-muted">
              <Spinner size={14} label="" />
              {s.validating}
            </motion.div>
          )}
        </AnimatePresence>
      ) : (
        <ul className="flex flex-col gap-1.5">
          <AnimatePresence initial={false} mode="popLayout">
            {sorted.map((issue) => (
              <motion.li key={`${issue.source}:${issue.level}:${issue.line ?? ""}:${issue.message}`} layout {...variants.listItem} className="list-none">
                <button
                  type="button"
                  disabled={!issue.line}
                  onClick={() => issue.line && onReveal(issue.line)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
                    issue.level === "error" ? "border-danger/25 bg-danger-soft/40 hover:bg-danger-soft/70" : "border-warning/25 bg-warning-soft/40 hover:bg-warning-soft/70",
                    !issue.line && "cursor-default",
                  )}
                >
                  {issue.level === "error" ? (
                    <CircleX className="mt-0.5 size-3.5 shrink-0 text-danger" aria-label="Hata" />
                  ) : (
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-label="Uyarı" />
                  )}
                  <span className="min-w-0 flex-1 text-xs leading-[1.5] text-fg">{issue.message}</span>
                  {issue.line && <span className="shrink-0 pt-px font-mono text-2xs text-fg-muted tabular">{s.line(issue.line)}</span>}
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </div>
  );
}
