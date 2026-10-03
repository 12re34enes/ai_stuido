/**
 * Live task page: one event stream for the task (`useEventStream({task_id})`, persisted events
 * only) that patches the React Query caches in place — node states morph on the canvas instead
 * of refetching — and feeds the transient UI state (hand-off batons, progress lines, the agents'
 * last output line).
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import type { StudioEvent } from "@/lib/events";
import { useEventStream } from "@/lib/events";
import type { AgentState, Usage } from "@/lib/types";

import { tdKeys } from "./api";
import { nodeRunsAfter } from "./replay";
import type { Run, RunStatus, SessionView, TaskDetail, TaskStatus } from "./types";

export interface LiveSink {
  handoff: (edgeId: string, at: number) => void;
  progress: (nodeId: string, value: { status: string; pct: number | null }) => void;
  lastLine: (sessionId: string, line: string) => void;
  waiting: (nodeId: string, reason: string | null) => void;
  conflict: (payload: Record<string, unknown>) => void;
}

/** Debounced invalidation: one refetch per key per `ms`, however many events arrive. */
export type Scheduler = (key: readonly unknown[], ms: number) => void;

export function makeScheduler(qc: QueryClient): Scheduler & { cancel: () => void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const fn = ((key: readonly unknown[], ms: number) => {
    const k = JSON.stringify(key);
    if (timers.has(k)) return;
    timers.set(
      k,
      setTimeout(() => {
        timers.delete(k);
        void qc.invalidateQueries({ queryKey: key });
      }, ms),
    );
  }) as Scheduler & { cancel: () => void };
  fn.cancel = () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
  return fn;
}

const RUN_TERMINAL: Record<string, RunStatus> = { "run.completed": "completed", "run.failed": "failed", "run.cancelled": "cancelled" };
const str = (v: unknown) => (typeof v === "string" ? v : "");

function firstLine(text: string, max = 140): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function patchRun(qc: QueryClient, runId: string, fn: (run: Run) => Run): boolean {
  const key = tdKeys.run(runId);
  const cur = qc.getQueryData<Run>(key);
  if (!cur) return false;
  qc.setQueryData<Run>(key, fn(cur));
  return true;
}

function patchDetail(qc: QueryClient, taskId: string, fn: (d: TaskDetail) => TaskDetail) {
  qc.setQueryData<TaskDetail>(tdKeys.task(taskId), (old) => (old ? fn(old) : old));
}

function patchSessions(qc: QueryClient, runId: string, sessionId: string, patch: Partial<SessionView>): boolean {
  const key = tdKeys.sessions(runId);
  const cur = qc.getQueryData<SessionView[]>(key);
  if (!cur?.some((s) => s.id === sessionId)) return false;
  qc.setQueryData<SessionView[]>(
    key,
    cur.map((s) => (s.id === sessionId ? { ...s, ...patch } : s)),
  );
  return true;
}

/** Route one frame's batch of task events into cache patches and sink calls. Exported for tests. */
export function applyTaskEvents(qc: QueryClient, taskId: string, batch: readonly StudioEvent[], sink: LiveSink, schedule: Scheduler): void {
  for (const ev of batch) {
    const p = ev.payload;
    const runId = ev.run_id ?? str(p.run_id);
    const t = ev.type;

    const runs = runId ? nodeRunsAfter(qc.getQueryData<Run>(tdKeys.run(runId))?.nodes ?? [], ev) : null;
    if (runs && runId) {
      // A refetch already in flight may carry older state than this event: drop it, keep the
      // patch, and refetch again shortly.
      if (qc.isFetching({ queryKey: tdKeys.run(runId), exact: true }) > 0) {
        void qc.cancelQueries({ queryKey: tdKeys.run(runId), exact: true }, { revert: false });
        schedule(tdKeys.run(runId), 700);
      }
      patchRun(qc, runId, (r) => ({ ...r, nodes: runs }));
      if (t === "node.completed" || t === "node.failed") schedule(tdKeys.run(runId), 700); // full output
      if (t === "node.started") sink.progress(str(p.node_id), { status: "", pct: null });
      if (t === "node.waiting") sink.waiting(str(p.node_id), str(p.reason) || null);
      else sink.waiting(str(p.node_id), null);
      continue;
    }

    if (t === "run.edge") {
      sink.handoff(str(p.edge_id), Date.parse(ev.ts) || Date.now());
    } else if (t === "node.progress") {
      sink.progress(str(p.node_id), { status: str(p.status), pct: typeof p.progress === "number" ? p.progress : null });
    } else if (t === "run.started") {
      schedule(tdKeys.task(taskId), 0);
    } else if (t === "run.updated" || t in RUN_TERMINAL || t === "run.reopened") {
      const status: RunStatus = RUN_TERMINAL[t] ?? (t === "run.reopened" ? "running" : (str(p.status) as RunStatus) || "running");
      const terminal = t in RUN_TERMINAL;
      if (runId) {
        patchRun(qc, runId, (r) => ({ ...r, status, finished_at: terminal ? ev.ts : null }));
        patchDetail(qc, taskId, (d) => ({
          ...d,
          current_run: d.current_run?.id === runId ? { ...d.current_run, status, finished_at: terminal ? ev.ts : null } : d.current_run,
          runs: d.runs.map((r) => (r.id === runId ? { ...r, status, finished_at: terminal ? ev.ts : null, error: str(p.error) || r.error } : r)),
        }));
      }
      if (terminal || t === "run.reopened") {
        schedule(tdKeys.task(taskId), 300);
        schedule(tdKeys.usage(taskId), 300);
      }
    } else if (t === "task.updated" || t === "task.completed" || t === "task.failed") {
      const status = (t === "task.completed" ? "completed" : t === "task.failed" ? "failed" : str(p.status)) as TaskStatus | "";
      if (status) patchDetail(qc, taskId, (d) => ({ ...d, task: { ...d.task, status } }));
      if (t !== "task.updated" || status === "cancelled") schedule(tdKeys.task(taskId), 300);
    } else if (t.startsWith("gate.") || t === "boundary.violation") {
      if (runId) {
        schedule(tdKeys.gates(runId), 150);
        schedule(tdKeys.evidence(runId), 400);
      }
      schedule(tdKeys.quality(taskId), 800);
    } else if (t === "checkpoint.created") {
      if (runId) schedule(tdKeys.checkpoints(runId), 200);
    } else if (t === "checkpoint.restored") {
      if (runId) {
        schedule(tdKeys.run(runId), 0);
        schedule(tdKeys.checkpoints(runId), 0);
        schedule(tdKeys.worktrees(runId), 0);
      }
      schedule(tdKeys.task(taskId), 0);
    } else if (t === "node.session" || t === "agent.session.started" || t === "agent.session.ended") {
      if (runId) schedule(tdKeys.sessions(runId), t === "agent.session.ended" ? 600 : 100);
    } else if (t === "agent.status" && ev.session_id) {
      const state = str(p.state) as AgentState;
      if (!runId || !state || !patchSessions(qc, runId, ev.session_id, { state })) {
        if (runId) schedule(tdKeys.sessions(runId), 250);
      }
    } else if (t === "agent.usage" && ev.session_id) {
      if (runId) patchSessions(qc, runId, ev.session_id, { last_usage: p as unknown as Usage });
      schedule(tdKeys.usage(taskId), 1500);
    } else if (t === "agent.message" && ev.session_id && p.role !== "user") {
      const line = firstLine(str(p.text));
      if (line) sink.lastLine(ev.session_id, line);
    } else if (t === "agent.tool.call" && ev.session_id) {
      const line = str(p.summary) || str(p.tool);
      if (line) sink.lastLine(ev.session_id, line);
    } else if (t === "node.worktree" || t === "agent.file.changed") {
      if (runId) schedule(tdKeys.worktrees(runId), 800);
      schedule(["taskDetail", "worktree"], 1500);
    } else if (t === "conflict.detected") {
      sink.conflict(p);
      schedule(["taskDetail", "worktree"], 0);
    }
  }
}

export interface LiveState {
  handoffs: ReadonlyMap<string, number>;
  progress: ReadonlyMap<string, { status: string; pct: number | null }>;
  lastLines: ReadonlyMap<string, string>;
  /** node id → why it waits (from `node.waiting`), cleared when it moves on. */
  waiting: ReadonlyMap<string, string>;
}

/**
 * Subscribe the page to its task's events. Returns the transient live state; caches are patched
 * directly. Hand-offs expire after `handoffMs` (the component re-renders when they do).
 */
export function useTaskLive(taskId: string, opts: { onConflict?: (p: Record<string, unknown>) => void; handoffMs?: number } = {}): LiveState & { now: number; seedHandoffs: (edgeIds: string[]) => void } {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>(() => ({ handoffs: new Map(), progress: new Map(), lastLines: new Map(), waiting: new Map() }));
  const [now, setNow] = useState(() => Date.now());
  const scheduler = useRef<ReturnType<typeof makeScheduler> | null>(null);
  const onConflict = useRef(opts.onConflict);
  useEffect(() => {
    onConflict.current = opts.onConflict;
  });
  const handoffMs = opts.handoffMs ?? 2600;

  useEffect(() => {
    const sched = makeScheduler(qc);
    scheduler.current = sched;
    return () => {
      sched.cancel();
      scheduler.current = null;
    };
  }, [qc]);

  const onBatch = useCallback(
    (batch: StudioEvent[]) => {
      const handoffs: [string, number][] = [];
      const progress: [string, { status: string; pct: number | null }][] = [];
      const lines: [string, string][] = [];
      const waits: [string, string | null][] = [];
      applyTaskEvents(
        qc,
        taskId,
        batch,
        {
          // Live hand-offs are timed from arrival so clock skew never hides the baton.
          handoff: (edgeId) => handoffs.push([edgeId, Date.now()]),
          progress: (nodeId, v) => progress.push([nodeId, v]),
          lastLine: (sid, line) => lines.push([sid, line]),
          waiting: (nodeId, reason) => waits.push([nodeId, reason]),
          conflict: (p) => onConflict.current?.(p),
        },
        scheduler.current ?? (() => undefined),
      );
      if (handoffs.length || progress.length || lines.length || waits.length) {
        setState((prev) => {
          let waiting = prev.waiting;
          if (waits.length) {
            const next = new Map(prev.waiting);
            for (const [id, reason] of waits) {
              if (reason) next.set(id, reason);
              else next.delete(id);
            }
            waiting = next;
          }
          return {
            handoffs: handoffs.length ? new Map([...prev.handoffs, ...handoffs]) : prev.handoffs,
            progress: progress.length ? new Map([...prev.progress, ...progress]) : prev.progress,
            lastLines: lines.length ? new Map([...prev.lastLines, ...lines]) : prev.lastLines,
            waiting,
          };
        });
        if (handoffs.length) setNow(Date.now());
      }
    },
    [qc, taskId],
  );

  useEventStream(taskId ? { task_id: taskId, ephemeral: false } : null, onBatch);

  // Re-render once the newest hand-off has played out, so the baton settles into a done edge.
  const newest = Math.max(0, ...state.handoffs.values());
  useEffect(() => {
    if (!newest) return;
    const left = newest + handoffMs - Date.now();
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Date.now()), left + 30);
    return () => clearTimeout(t);
  }, [handoffMs, newest]);

  /** Play hand-offs now (e.g. into the running nodes when the page opens). */
  const seedHandoffs = useCallback((edgeIds: string[]) => {
    if (!edgeIds.length) return;
    const at = Date.now();
    setState((prev) => ({ ...prev, handoffs: new Map([...prev.handoffs, ...edgeIds.map((id) => [id, at] as [string, number])]) }));
    setNow(at);
  }, []);

  return { ...state, now, seedHandoffs };
}
