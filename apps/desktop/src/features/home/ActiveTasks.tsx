/**
 * Active tasks as live flow strips (spec §19): node states come from each task's run and are
 * patched by `node.*` / `run.*` / `gate.*` events; hand-offs send a baton along the strip.
 */
import { Clock } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo } from "react";
import { Link } from "react-router";

import { useNow } from "@/hooks/useNow";
import { formatDuration } from "@/i18n/format";
import { spring, variants } from "@/motion/tokens";
import { Skeleton, cn } from "@/ui";
import { FlowStrip } from "@/ui/flow";

import { useModeGraphs } from "../tasks/create/queries";
import { runSteps, stepsForRun } from "../tasks/list/graph";
import { useHandoff, useTaskPulse } from "../tasks/list/live";
import { useQueue, useRuns } from "../tasks/list/queries";
import { taskLayoutId } from "../tasks/list/status";
import { TaskKindBadge, TaskStatusDot } from "../tasks/list/TaskParts";
import { MODES, type BuiltinMode, type FlowGraph, type QueueEntry, type Run, type Task } from "../tasks/list/types";
import { elapsedLabel } from "./format";
import { Section } from "./Section";
import { homeStrings as s } from "./strings";

function ActiveTaskCard({ task, run, queueEntry, modeGraph }: { task: Task; run: Run | undefined; queueEntry: QueueEntry | undefined; modeGraph: FlowGraph | undefined }) {
  const handoff = useHandoff(task.id);
  const activity = useTaskPulse((st) => (run ? st.activity[run.id] : undefined));
  const now = useNow(30_000);
  const strip = useMemo(() => (run ? stepsForRun(run) : modeGraph && !task.studio_id && !task.flow_id ? runSteps(modeGraph) : null), [run, modeGraph, task.studio_id, task.flow_id]);

  let line: { key: string; text: string; tone: "muted" | "warning" };
  if (task.status === "queued") {
    const text = queueEntry?.hold_until
      ? s.active.holdUntil(formatDuration(new Date(queueEntry.hold_until).getTime() - now))
      : queueEntry
        ? s.active.queuedAt(queueEntry.position)
        : s.active.queued;
    line = { key: `q:${text}`, text: queueEntry?.hold_reason ? `${text} · ${queueEntry.hold_reason}` : text, tone: "muted" };
  } else if (!run || !strip) {
    line = { key: "starting", text: s.active.starting, tone: "muted" };
  } else {
    const waiting = strip.current.filter((c) => c.waiting);
    const running = strip.current.filter((c) => !c.waiting);
    if (task.status === "waiting" || waiting.length) {
      const label = waiting.map((c) => c.label).join(" · ") || strip.current[0]?.label || "";
      line = { key: `w:${activity ?? label}`, text: activity && waiting.length ? activity : s.active.waiting(label), tone: "warning" };
    } else if (running.length) {
      const label = running.map((c) => c.label).join(" · ");
      line = { key: `r:${label}`, text: s.active.running(label), tone: "muted" };
    } else {
      line = { key: "starting", text: s.active.starting, tone: "muted" };
    }
  }

  const started = run?.started_at ?? null;
  const surfaceTone = task.status === "waiting" ? "border-warning/35" : "border-line";

  return (
    <motion.li layout="position" variants={variants.listItem} initial="initial" animate="animate" exit="exit" transition={spring.layout} className="relative">
      <motion.div
        layoutId={taskLayoutId(task.id)}
        aria-hidden
        className={cn("absolute inset-0 rounded-[14px] border bg-surface shadow-1 transition-[border-color] duration-300", surfaceTone)}
        style={{ borderRadius: 14 }}
        transition={spring.gentle}
      />
      <div className="group relative flex flex-col gap-3 rounded-[14px] px-4 pt-3 pb-3.5 transition-shadow duration-200 hover:shadow-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <TaskStatusDot task={task} />
          <Link
            to={`/tasks/${encodeURIComponent(task.id)}`}
            state={{ morph: true }}
            aria-label={s.active.open(task.title)}
            className="min-w-0 flex-1 truncate rounded-sm text-sm font-medium text-fg outline-none after:absolute after:inset-0 after:rounded-[14px] after:content-[''] focus-visible:after:shadow-[var(--focus-ring)]"
          >
            {task.title}
          </Link>
          <TaskKindBadge task={task} />
          {started && (
            <span className="flex shrink-0 items-center gap-1 text-xs text-fg-faint tabular">
              <Clock className="size-3" />
              {elapsedLabel(now - new Date(started).getTime())}
            </span>
          )}
        </div>
        {strip ? (
          <div className="relative z-10 w-full min-w-0">
            <FlowStrip steps={strip.steps} size="md" handoff={handoff} aria-label={s.active.flow(task.title)} />
          </div>
        ) : (
          <Skeleton height={28} className="w-full" />
        )}
        <div className="relative h-4 overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p
              key={line.key}
              className={cn("truncate text-xs leading-4", line.tone === "warning" ? "text-warning" : "text-fg-muted")}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: spring.smooth }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.14 } }}
            >
              {line.text}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
    </motion.li>
  );
}

const ORDER: Record<string, number> = { waiting: 0, running: 1, queued: 2 };

export function ActiveTasks({ tasks, workspaceId }: { tasks: Task[]; workspaceId: string }) {
  const runIds = useMemo(() => tasks.map((t) => t.current_run_id).filter((id): id is string => !!id && tasks.some((t) => t.status !== "queued" && t.current_run_id === id)), [tasks]);
  const runResults = useRuns(runIds);
  const runs = new Map<string, Run>();
  runIds.forEach((id, i) => {
    const data = runResults[i]?.data;
    if (data) runs.set(id, data);
  });
  const hasQueued = tasks.some((t) => t.status === "queued");
  const queue = useQueue(hasQueued ? workspaceId : null);
  const graphs = useModeGraphs(workspaceId);
  const queueById = new Map((queue.data ?? []).map((q) => [q.task.id, q]));
  const sorted = [...tasks].sort((a, b) => {
    const d = (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3);
    if (d) return d;
    if (a.status === "queued") return (queueById.get(a.id)?.position ?? 999) - (queueById.get(b.id)?.position ?? 999);
    return b.updated_at.localeCompare(a.updated_at);
  });

  return (
    <Section id="active" title={s.active.title} count={tasks.length}>
      <ul className="flex flex-col gap-2.5">
        <AnimatePresence initial={false} mode="popLayout">
          {sorted.map((t) => (
            <ActiveTaskCard
              key={t.id}
              task={t}
              run={t.current_run_id && t.status !== "queued" ? runs.get(t.current_run_id) : undefined}
              queueEntry={queueById.get(t.id)}
              modeGraph={(MODES as readonly string[]).includes(t.mode) ? graphs[t.mode as BuiltinMode].data : undefined}
            />
          ))}
        </AnimatePresence>
      </ul>
    </Section>
  );
}
