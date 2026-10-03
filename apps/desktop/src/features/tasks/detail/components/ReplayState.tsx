/** Replay "state at the playhead": the current event, the selected node, gates so far, agents, approvals. */
import { AnimatePresence, motion } from "motion/react";

import type { Provider } from "@/lib/types";
import { spring, transition, variants } from "@/motion/tokens";
import { AgentCard, Badge, cn, isAgentBusy } from "@/ui";
import { GateMark } from "@/ui/flow";

import type { EventDescription } from "../describe";
import type { NodeView } from "../graph";
import type { ReplayState } from "../replay";
import { clock } from "../replayClock";
import { s } from "../strings";
import type { GateKind, SessionView } from "../types";
import { SectionTitle } from "./bits";
import { EventIconBadge } from "./EventList";
import { NodeStatusBadge } from "./NodePanel";

export interface ReplayStatePanelProps {
  index: number;
  current: EventDescription | null;
  elapsed: number;
  node: NodeView | undefined;
  state: ReplayState;
  sessions: SessionView[];
  sessionLabel: (id: string) => string;
  nodeLabel: (id: string) => string;
}

export function ReplayStatePanel({ index, current, elapsed, node, state, sessions, sessionLabel, nodeLabel }: ReplayStatePanelProps) {
  const agents = Object.values(state.agents).sort((a, b) => Number(isAgentBusy(b.state)) - Number(isAgentBusy(a.state)));
  const gates = [...state.gates].reverse();
  const approvals = Object.values(state.approvals);

  return (
    <section aria-labelledby="state-title" className="flex min-w-0 flex-col gap-5 rounded-xl border border-line bg-surface p-5 shadow-1">
      <SectionTitle id="state-title">{s.stateAt}</SectionTitle>

      {/* the event under the playhead */}
      <div className="relative min-h-[52px]" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          {current ? (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0, transition: spring.smooth }}
              exit={{ opacity: 0, y: -6, transition: transition.exit }}
              className="flex items-center gap-3 rounded-lg bg-canvas-subtle px-3 py-2.5"
            >
              <EventIconBadge description={current} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-2xs font-medium tracking-[0.02em] text-fg-faint">{s.now}</span>
                <span className="truncate text-sm text-fg">{current.title}</span>
                {current.detail && <span className="truncate text-xs text-fg-muted">{current.detail}</span>}
              </span>
              <span className="shrink-0 font-mono text-xs text-fg-muted tabular">{clock(elapsed)}</span>
            </motion.div>
          ) : (
            <motion.p key="none" {...variants.fade} className="py-3 text-sm text-fg-faint">
              {s.replayEmpty}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <div className="grid grid-cols-2 gap-5">
        {/* selected node */}
        <div className="flex min-w-0 flex-col gap-2.5">
          {node && (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="min-w-0 truncate text-md leading-6 text-fg">{node.node.label}</h2>
                <NodeStatusBadge status={node.status} />
                {node.attempts > 1 && <Badge tone="neutral">{s.round(node.attempts)}</Badge>}
              </div>
              <AnimatePresence initial={false} mode="popLayout">
                {node.status === "waiting" && state.waiting[node.id] ? (
                  <motion.p key="wait" {...variants.fadeUp} className="text-sm text-warning">
                    {state.waiting[node.id]}
                  </motion.p>
                ) : node.status === "running" && state.progress[node.id]?.status ? (
                  <motion.p key="progress" {...variants.fadeUp} className="text-sm text-fg-muted">
                    {state.progress[node.id]!.status}
                  </motion.p>
                ) : node.status === "failed" && node.run?.error ? (
                  <motion.p key="error" {...variants.fadeUp} className="text-sm text-danger">
                    {node.run.error}
                  </motion.p>
                ) : node.status === "passed" && node.run?.output ? (
                  <motion.p key="output" {...variants.fadeUp} className="line-clamp-4 text-sm leading-6 text-fg-muted">
                    {node.run.output}
                  </motion.p>
                ) : node.status === "running" && node.node.config.kind === "gate" ? (
                  <motion.p key="checking" {...variants.fadeUp} className="text-sm text-fg-muted">
                    {s.gateChecking}
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </>
          )}
        </div>

        {/* gate results so far */}
        <div className="flex min-w-0 flex-col gap-2">
          <SectionTitle count={gates.length || undefined}>{s.gatesAt}</SectionTitle>
          {gates.length === 0 ? (
            <p className="text-sm text-fg-faint">{s.noGatesTitle}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              <AnimatePresence initial={false}>
                {gates.slice(0, 6).map((g) => (
                  <motion.li
                    key={`${g.nodeId}-${g.attempt}-${g.time}`}
                    layout
                    {...variants.listItem}
                    className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-1.5", g.status === "failed" ? "bg-danger-soft/50" : "bg-canvas-subtle")}
                  >
                    <GateMark status={g.status} size={16} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-xs font-medium text-fg">
                        {s.gateKind[g.gate as GateKind] ?? nodeLabel(g.nodeId)}
                        {g.attempt > 1 && <span className="font-normal text-fg-faint"> · {s.round(g.attempt)}</span>}
                      </span>
                      <span className="truncate text-2xs text-fg-muted">{g.summary}</span>
                    </span>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <SectionTitle count={agents.length || undefined}>{s.agentsAt}</SectionTitle>
        {agents.length === 0 ? (
          <p className="text-sm text-fg-faint">{s.noAgentsYet}</p>
        ) : (
          <motion.ul layout className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
            <AnimatePresence initial={false} mode="popLayout">
              {agents.map((a) => {
                const rec = sessions.find((x) => x.id === a.sessionId);
                const provider: Provider = a.provider ?? rec?.provider ?? "claude";
                return (
                  <motion.li key={a.sessionId} layout {...variants.listItem} className={cn(!isAgentBusy(a.state) && "opacity-80")}>
                    <AgentCard
                      provider={provider}
                      title={rec?.label || a.label || sessionLabel(a.sessionId)}
                      model={a.model ?? rec?.model}
                      role={rec?.role}
                      state={a.state}
                      lastLine={a.lastLine}
                      usage={a.usage ?? undefined}
                    />
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </motion.ul>
        )}
      </div>

      {approvals.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionTitle count={approvals.length}>{s.approval}</SectionTitle>
          <ul className="flex flex-col gap-1.5">
            {approvals.map((a) => (
              <li key={a.id} className="flex items-center gap-2.5 rounded-lg bg-canvas-subtle px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-fg">{a.title || a.kind}</span>
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={a.status} initial={{ scale: 0.85, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: spring.bouncy }} exit={{ opacity: 0, transition: transition.exit }}>
                    <Badge tone={a.status === "approved" ? "success" : a.status === "rejected" ? "danger" : a.status === "pending" ? "warning" : "neutral"}>{s.approvalStatus[a.status] ?? a.status}</Badge>
                  </motion.span>
                </AnimatePresence>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
