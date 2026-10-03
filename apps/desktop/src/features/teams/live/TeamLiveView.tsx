/**
 * Live team view (spec §25 "Canlı ekip görünümü") for one run's team node: KPI row, the living
 * org chart (hover = detail card, click = live stream in the drawer + message box), and the
 * Gantt-like assignment timeline. Embedded in the task page; full page at /teams/live/:runId.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { ChevronDown, CircleAlert, CircleSlash, Flag, Hourglass, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useState } from "react";

import { openSessionDrawer } from "@/features/sessions/drawer";
import { ApiError } from "@/lib/api";
import { isMissingEndpoint } from "@/lib/connection";
import { spring, transition, variants } from "@/motion/tokens";
import { Button, cn, EmptyState, Skeleton } from "@/ui";

import { errorText } from "../../flows/util";
import { teamKpis } from "../model/live";
import { s } from "../strings";
import type { AgentRole, RunSession } from "../types";
import { AssignmentTimeline } from "./AssignmentTimeline";
import { LiveContext, type LiveContextValue } from "./context";
import { KpiRow } from "./KpiRow";
import { LiveCanvas } from "./LiveCanvas";
import { MemberPanel } from "./MemberPanel";
import { useTeamLive } from "./useTeamLive";

export interface TeamLiveViewProps {
  runId: string;
  nodeId?: string | null;
  /** `embedded`: fixed-height canvas inside the task page; `page`: fills the available height. */
  variant?: "embedded" | "page";
  className?: string;
}

function LoadingState({ variant }: { variant: "embedded" | "page" }) {
  return (
    <div className={cn("flex flex-col", variant === "page" && "h-full")} data-testid="team-live-loading" aria-busy>
      <div className="flex gap-4 border-b border-line-subtle px-4 py-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={32} className="flex-1 rounded-md" />
        ))}
      </div>
      <div className={cn("flex flex-col items-center justify-center gap-6", variant === "page" ? "flex-1" : "h-[420px]")}>
        <Skeleton width={236} height={88} className="rounded-xl" />
        <div className="flex gap-6">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width={200} height={84} className="rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

const ROLE_AGENT: Record<string, AgentRole> = { advisor: "advisor", tester: "tester", lead: "planner", worker: "writer" };

export function TeamLiveView({ runId, nodeId = null, variant = "embedded", className }: TeamLiveViewProps) {
  const { state, view, sessions } = useTeamLive(runId, nodeId);
  const [selected, setSelected] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const sessionMap = useMemo(() => new Map<string, RunSession>((sessions.data ?? []).map((sv) => [sv.id, sv])), [sessions.data]);

  const openStream = useCallback(
    (memberId: string) => {
      const m = state.spec?.members.find((x) => x.id === memberId);
      const sid = state.members[memberId]?.sessionId;
      if (!m || !sid) return;
      const row = sessionMap.get(sid);
      openSessionDrawer({
        id: sid,
        provider: row?.provider ?? m.provider,
        label: m.name,
        title: row?.title ?? null,
        role: row?.role ?? ROLE_AGENT[m.role] ?? "writer",
        model: row?.model ?? state.members[memberId]?.model ?? m.model,
      });
    },
    [sessionMap, state.members, state.spec],
  );

  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (id && state.members[id]?.sessionId) openStream(id);
    },
    [openStream, state.members],
  );

  const ctx = useMemo<LiveContextValue>(() => ({ runId, state, sessions: sessionMap, selected, select, openStream }), [openStream, runId, select, selected, sessionMap, state]);
  const kpis = useMemo(() => teamKpis(state), [state]);

  if (!state.spec) {
    if (view.isPending) return <LoadingState variant={variant} />;
    const notFound = view.error instanceof ApiError && view.error.status === 404;
    const missing = view.isError && isMissingEndpoint(view.error);
    return (
      <div className={cn("grid place-items-center px-6", variant === "page" ? "h-full" : "h-[300px]", className)} data-testid="team-live-empty">
        <EmptyState
          icon={notFound || missing ? <Hourglass /> : <CircleAlert />}
          title={notFound ? (state.started ? s.live.loading : s.live.notStartedTitle) : missing ? s.live.notFoundTitle : s.live.errorTitle}
          description={notFound ? s.live.notStartedBody : missing ? s.live.notFoundBody : errorText(view.error)}
          action={
            !notFound && (
              <Button size="sm" variant="secondary" onClick={() => void view.refetch()}>
                {s.retry}
              </Button>
            )
          }
        />
      </div>
    );
  }

  return (
    <LiveContext.Provider value={ctx}>
      <section className={cn("flex flex-col", variant === "page" && "h-full min-h-0", className)} aria-label={s.live.title} data-testid="team-live-view">
        <KpiRow kpis={kpis} className="border-b border-line-subtle bg-surface" />
        <div className={cn("relative bg-canvas-subtle bg-[radial-gradient(var(--line)_1px,transparent_1px)] [background-size:18px_18px]", variant === "page" ? "min-h-0 flex-1" : "h-[480px]")}>
          <ReactFlowProvider>
            <LiveCanvas />
          </ReactFlowProvider>
          <div className="pointer-events-none absolute bottom-3 left-3 z-10">
            <MemberPanel />
          </div>
          {state.teamName && variant === "embedded" && (
            <div className="pointer-events-none absolute top-3 left-3 z-10 flex max-w-[30%] items-center gap-1.5 rounded-full border border-line-subtle bg-surface/90 py-0.5 pr-2.5 pl-2 text-xs text-fg-muted shadow-1 backdrop-blur-md" data-testid="team-live-name">
              <Users className="size-3 shrink-0" aria-hidden />
              <span className="truncate text-fg">{state.teamName}</span>
              {view.data && view.data.attempt > 1 && <span className="shrink-0 text-fg-faint">· {s.live.attempt(view.data.attempt)}</span>}
            </div>
          )}
          <AnimatePresence>
            {state.finished && (
              <motion.div
                key={`finished-${state.finished.status}`}
                className={cn(
                  "pointer-events-none absolute top-3 left-1/2 z-10 flex max-w-[56%] -translate-x-1/2 items-center gap-2 rounded-full border bg-surface/95 py-1 pr-3.5 pl-2.5 text-sm shadow-2 backdrop-blur-md",
                  state.finished.status === "completed" ? "border-success/30" : state.finished.status === "failed" ? "border-danger/30" : "border-line",
                )}
                initial={{ opacity: 0, y: -10, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
                exit={{ opacity: 0, transition: transition.exit }}
                role="status"
                data-testid="team-finished"
                data-status={state.finished.status}
              >
                {state.finished.status === "completed" ? (
                  <Flag className="size-3.5 shrink-0 text-success" aria-hidden />
                ) : state.finished.status === "failed" ? (
                  <CircleAlert className="size-3.5 shrink-0 text-danger" aria-hidden />
                ) : (
                  <CircleSlash className="size-3.5 shrink-0 text-fg-muted" aria-hidden />
                )}
                <span className="shrink-0 font-medium text-fg">
                  {state.finished.status === "completed" ? s.live.finished : state.finished.status === "failed" ? s.live.finishedFailed : s.live.finishedCancelled}
                </span>
                {(state.finished.summary ?? state.finished.error) && <span className="truncate text-fg-muted">· {state.finished.summary ?? state.finished.error}</span>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="border-t border-line-subtle bg-surface">
          <button
            type="button"
            onClick={() => setTimelineOpen((o) => !o)}
            aria-expanded={timelineOpen}
            className="flex h-9 w-full items-center gap-2 px-4 text-left text-xs font-medium text-fg-muted outline-none transition-colors hover:text-fg focus-visible:shadow-[inset_var(--focus-ring)]"
          >
            <motion.span animate={{ rotate: timelineOpen ? 0 : -90 }} transition={spring.snappy} className="flex">
              <ChevronDown className="size-3.5" aria-hidden />
            </motion.span>
            {s.live.timeline}
          </button>
          <AnimatePresence initial={false}>
            {timelineOpen && (
              <motion.div key="timeline" {...variants.fade} className="pb-2">
                <AssignmentTimeline />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>
    </LiveContext.Provider>
  );
}
