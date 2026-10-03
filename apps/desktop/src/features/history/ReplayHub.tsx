/**
 * Replay hub (spec §18 "Oturum tekrar oynatma"): recent engine runs open their timeline page;
 * sessions open the session replay (persisted events + scrubber).
 */
import { ChevronRight, History, ListChecks, Play, TerminalSquare } from "lucide-react";
import { motion } from "motion/react";
import { useMemo } from "react";
import { Link } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { isMissingEndpoint } from "@/lib/connection";
import { useCurrentWorkspace } from "@/lib/workspace";
import { stagger, variants } from "@/motion/tokens";
import { agentDotStatus, Badge, cn, EmptyState, ProviderMark, Skeleton, StatusDot, uiStrings, type DotStatus } from "@/ui";

import { useSessions } from "../sessions/api";
import { ErrorState, PageColumn } from "../sessions/kit/Page";
import { sessionStrings } from "../sessions/strings";
import { sessionTitle, shortPath } from "../sessions/format";
import { useRecentTasks, type EngineTask } from "./api";
import { historyStrings as t } from "./strings";

const r = t.replay;

const taskDot: Record<string, DotStatus> = {
  running: "running",
  waiting: "waiting",
  queued: "idle",
  draft: "idle",
  completed: "success",
  failed: "error",
  cancelled: "offline",
};

function Panel({ icon, title, hint, children }: { icon: React.ReactNode; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-1" aria-label={title}>
      <header className="flex items-start gap-3 border-b border-line-subtle px-5 py-4">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-fg-muted [&_svg]:size-4">{icon}</span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-md leading-6 text-fg">{title}</h2>
          <p className="text-xs text-fg-muted">{hint}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-1 p-2" aria-busy>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <Skeleton circle width={12} height={12} />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton height={10} width={`${70 - i * 8}%`} />
            <Skeleton height={8} width="30%" />
          </div>
        </div>
      ))}
    </div>
  );
}

const rowClass =
  "group flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]";

function RunRow({ task, now }: { task: EngineTask; now: number }) {
  const body = (
    <>
      <StatusDot status={taskDot[task.status] ?? "idle"} size={12} label={r.taskStatus[task.status] ?? task.status} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-fg">{task.title}</span>
        <span className="flex items-center gap-1.5 text-2xs text-fg-muted">
          <span>{r.modes[task.mode] ?? task.mode}</span>
          <span className="text-fg-faint">·</span>
          <span>{r.taskStatus[task.status] ?? task.status}</span>
          {task.quality_score !== null && (
            <>
              <span className="text-fg-faint">·</span>
              <span className="tabular">{r.quality(task.quality_score)}</span>
            </>
          )}
        </span>
      </div>
      <time dateTime={task.updated_at} className="shrink-0 text-2xs text-fg-faint">
        {relativeTime(task.updated_at, new Date(now))}
      </time>
      <ChevronRight className="size-4 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
    </>
  );
  return (
    <motion.li variants={variants.listItem} className="list-none">
      {task.current_run_id ? (
        <Link to={`/tasks/runs/${task.current_run_id}`} className={rowClass}>
          {body}
        </Link>
      ) : (
        <div className={cn(rowClass, "opacity-60")}>{body}</div>
      )}
    </motion.li>
  );
}

export function ReplayHub() {
  const now = useNow(60_000);
  const { workspace } = useCurrentWorkspace();
  const tasks = useRecentTasks(workspace?.id ?? null);
  const sessions = useSessions();
  const recentSessions = useMemo(
    () => [...(sessions.data ?? [])].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 30),
    [sessions.data],
  );
  const runs = (tasks.data ?? []).filter((x) => x.current_run_id || x.status !== "draft");

  return (
    <PageColumn size="wide" className="h-full overflow-y-auto pb-10">
      <div className="grid grid-cols-2 gap-5">
        <Panel icon={<ListChecks />} title={r.runs} hint={r.runsHint}>
          {tasks.isLoading ? (
            <RowsSkeleton />
          ) : tasks.isError ? (
            isMissingEndpoint(tasks.error) ? (
              <EmptyState size="sm" icon={<History />} title={r.runsUnavailable} />
            ) : (
              <ErrorState size="sm" title={r.runsUnavailable} error={tasks.error} onRetry={() => void tasks.refetch()} />
            )
          ) : runs.length === 0 ? (
            <EmptyState size="sm" icon={<History />} title={r.noRuns} />
          ) : (
            <motion.ul initial="initial" animate="animate" variants={stagger(0.03)} className="flex flex-col p-2">
              {runs.map((task) => (
                <RunRow key={task.id} task={task} now={now} />
              ))}
            </motion.ul>
          )}
        </Panel>
        <Panel icon={<TerminalSquare />} title={r.sessions} hint={r.sessionsHint}>
          {sessions.isLoading ? (
            <RowsSkeleton />
          ) : sessions.isError ? (
            <ErrorState size="sm" title={t.events.loadError} error={sessions.error} onRetry={() => void sessions.refetch()} />
          ) : recentSessions.length === 0 ? (
            <EmptyState size="sm" icon={<TerminalSquare />} title={r.noSessions} />
          ) : (
            <motion.ul initial="initial" animate="animate" variants={stagger(0.03)} className="flex flex-col p-2">
              {recentSessions.map((s) => (
                <motion.li key={s.id} variants={variants.listItem} className="list-none">
                  <Link to={`/history/replay/${s.id}`} className={rowClass} aria-label={`${r.replay}: ${sessionTitle(s)}`}>
                    <ProviderMark provider={s.provider} variant="tile" size={22} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className={cn("truncate text-sm text-fg", s.provider === "claude" ? "font-serif" : "font-mono text-xs font-medium")}>
                        {sessionTitle(s)}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-2xs text-fg-muted">
                        <StatusDot status={agentDotStatus(s.state)} tone={s.provider} size={9} label="" />
                        <span className="shrink-0">{uiStrings.agentState[s.state]}</span>
                        <span className="text-fg-faint">·</span>
                        <span className="truncate font-mono">{shortPath(s.cwd)}</span>
                      </span>
                    </div>
                    {s.origin !== "created" && <Badge variant="outline">{sessionStrings.origin[s.origin]}</Badge>}
                    <time dateTime={s.updated_at} className="shrink-0 text-2xs text-fg-faint">
                      {relativeTime(s.updated_at, new Date(now))}
                    </time>
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full text-fg-faint transition-colors group-hover:bg-accent-soft group-hover:text-accent">
                      <Play className="size-3 fill-current" aria-hidden />
                    </span>
                  </Link>
                </motion.li>
              ))}
            </motion.ul>
          )}
        </Panel>
      </div>
    </PageColumn>
  );
}
