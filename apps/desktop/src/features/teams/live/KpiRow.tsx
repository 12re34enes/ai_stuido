/** Compact KPI row of a running team: assignments, active members, test pass rate, merges. */
import { CheckCheck, FlaskConical, GitMerge, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";

import { spring, transition } from "@/motion/tokens";
import { AnimatedNumber, cn, ProgressBar } from "@/ui";

import type { TeamKpis } from "../model/live";
import { s } from "../strings";

function Kpi({ icon, label, children, footer, testId }: { icon: ReactNode; label: string; children: ReactNode; footer?: ReactNode; testId: string }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 px-4 py-2" data-testid={testId}>
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-sunken text-fg-muted [&_svg]:size-3.5" aria-hidden>
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-2xs text-fg-muted">{label}</span>
        <span className="flex items-baseline gap-1.5 text-md leading-5 font-medium text-fg tabular">{children}</span>
        {footer}
      </div>
    </div>
  );
}

export function KpiRow({ kpis, className }: { kpis: TeamKpis; className?: string }) {
  const testsPct = kpis.testsRun ? Math.round((kpis.testsPassed / kpis.testsRun) * 100) : null;
  return (
    <div className={cn("flex items-stretch divide-x divide-line-subtle", className)} role="group" aria-label={s.live.label}>
      <Kpi icon={<CheckCheck />} label={s.live.kpiAssignments} testId="kpi-assignments" footer={<ProgressBar size="xs" value={kpis.total ? (kpis.done / kpis.total) * 100 : 0} tone={kpis.failed ? "warning" : "success"} aria-label={`${kpis.done}/${kpis.total}`} className="mt-0.5 w-full max-w-28" />}>
        <AnimatedNumber value={kpis.done} />
        <span className="text-xs font-normal text-fg-faint">/ <AnimatedNumber value={kpis.total} /></span>
      </Kpi>
      <Kpi icon={<Users />} label={s.live.kpiActive} testId="kpi-active">
        <AnimatedNumber value={kpis.active} />
        <span className="text-xs font-normal text-fg-faint">/ {kpis.members}</span>
      </Kpi>
      <Kpi icon={<FlaskConical />} label={s.live.kpiTests} testId="kpi-tests">
        {testsPct === null ? (
          <span className="text-fg-faint">{s.live.kpiNoTests}</span>
        ) : (
          <>
            <AnimatedNumber value={testsPct} prefix="%" />
            <span className="text-xs font-normal text-fg-faint">
              {kpis.testsPassed}/{kpis.testsRun}
            </span>
          </>
        )}
      </Kpi>
      <Kpi icon={<GitMerge />} label={s.live.kpiMerges} testId="kpi-merges">
        <AnimatedNumber value={kpis.merges} />
        <AnimatePresence initial={false}>
          {kpis.conflicts > 0 && (
            <motion.span key="c" className="rounded-full bg-warning-soft px-1.5 text-2xs font-medium text-warning" initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1, transition: spring.bouncy }} exit={{ opacity: 0, transition: transition.exit }}>
              {s.live.kpiConflicts(kpis.conflicts)}
            </motion.span>
          )}
        </AnimatePresence>
      </Kpi>
    </div>
  );
}
