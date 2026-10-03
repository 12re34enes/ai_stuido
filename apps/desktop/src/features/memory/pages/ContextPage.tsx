import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { formatNumber } from "@/i18n/format";
import { readPref, writePref } from "@/lib/storage";
import { variants } from "@/motion/tokens";
import { CodeBlock, CopyButton, MarkdownView, ProgressBar, SegmentedControl, SkeletonText } from "@/ui";

import { LoadError } from "@/features/studios/components/Page";

import { useAgentContext } from "../api";
import { memoryStrings as s } from "../strings";
import type { AgentRole } from "../types";

/** Hard cap of the memory context (backend memory/context.py CONTEXT_CAP). */
const CONTEXT_CAP = 8000;
const ROLES: AgentRole[] = ["writer", "reviewer", "planner", "advisor", "tester", "judge", "synthesizer"];

export function ContextPage({ ws }: { ws: string }) {
  const [role, setRole] = useState<AgentRole>(() => readPref<AgentRole>("memory.context.role", "writer"));
  const [view, setView] = useState<"rendered" | "raw">("rendered");
  const ctx = useAgentContext(ws, role);
  const chars = ctx.data?.chars ?? 0;
  const pct = Math.min(100, (chars / CONTEXT_CAP) * 100);

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-6 px-10 pt-8 pb-20">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-2xl text-fg">{s.contextTitle}</h2>
        <p className="max-w-[640px] text-sm text-fg-muted">{s.contextSubtitle}</p>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          aria-label={s.role}
          value={role}
          onValueChange={(r) => {
            setRole(r);
            writePref("memory.context.role", r);
          }}
          options={ROLES.map((r) => ({ value: r, label: s.roles[r] }))}
        />
        <SegmentedControl
          size="sm"
          aria-label={s.raw}
          value={view}
          onValueChange={setView}
          options={[
            { value: "rendered", label: s.rendered },
            { value: "raw", label: s.raw },
          ]}
        />
      </div>
      <section className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-1" aria-label={s.contextTitle} aria-busy={ctx.isFetching}>
        <div className="flex items-center gap-4">
          <ProgressBar value={pct} tone={pct > 90 ? "warning" : "accent"} size="sm" aria-label={s.chars(formatNumber(chars), formatNumber(CONTEXT_CAP))} className="max-w-[260px]" />
          <span className="text-xs text-fg-muted tabular">{s.chars(formatNumber(chars), formatNumber(CONTEXT_CAP))}</span>
          <div className="flex-1" />
          {ctx.data && <CopyButton value={ctx.data.text} size="sm" label={s.copyContext} />}
        </div>
        {ctx.isError && !ctx.data ? (
          <LoadError title={s.contextLoadError} error={ctx.error} onRetry={() => void ctx.refetch()} />
        ) : !ctx.data ? (
          <SkeletonText lines={10} />
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={`${ctx.data.role}:${view}`} {...variants.fadeUp} className={ctx.isPlaceholderData ? "opacity-60 transition-opacity" : "transition-opacity"}>
              {view === "raw" ? (
                <CodeBlock code={ctx.data.text} language="markdown" wrap copyable={false} />
              ) : (
                <div className="rounded-lg border border-line-subtle bg-canvas-subtle px-5 py-4">
                  <MarkdownView source={ctx.data.text} />
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        )}
      </section>
    </div>
  );
}
