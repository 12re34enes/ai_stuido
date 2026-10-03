/**
 * Live task state: engine events (`task.*`, `run.*`, `node.*`, `gate.*`, `agent.handoff`) patch the
 * React Query caches in place so status dots morph and flow strips advance without refetching.
 * Hand-offs (`run.edge`, `agent.handoff`) light up a baton on the task's flow strip.
 */
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { create } from "zustand";

import { useEventStream, type StudioEvent } from "@/lib/events";

import { nodesBetween } from "./graph";
import { patchTask, removeTask, taskKeys } from "./queries";
import type { NodeRun, NodeStatus, Run, RunStatus, Task, TaskStatus } from "./types";

export const TASK_LIVE_TYPES = ["task.*", "run.*", "node.*", "gate.*", "agent.handoff"];

/** How long a hand-off baton keeps travelling after the event (two trips). */
export const HANDOFF_MS = 2800;
/** How long a newly created task counts as "fresh" (its row animates in). */
const FRESH_MS = 2500;

// ----------------------------------------------------------------------------- pulse store

interface PulseState {
  /** task id → sequence number of the hand-off currently animating (cleared after HANDOFF_MS) */
  handoffs: Record<string, number>;
  /** run id → latest human-readable activity (Turkish, from event payloads) */
  activity: Record<string, string>;
  /** task ids created moments ago (rows animate in) */
  fresh: Record<string, true>;
  markHandoff: (taskId: string) => void;
  markFresh: (taskId: string) => void;
  setActivity: (runId: string, text: string) => void;
}

let handoffSeq = 0;

export const useTaskPulse = create<PulseState>()((set, get) => ({
  handoffs: {},
  activity: {},
  fresh: {},
  markFresh: (taskId) => {
    set((s) => ({ fresh: { ...s.fresh, [taskId]: true } }));
    setTimeout(() => {
      const { [taskId]: _done, ...rest } = get().fresh;
      set({ fresh: rest });
    }, FRESH_MS);
  },
  markHandoff: (taskId) => {
    const seq = ++handoffSeq;
    set((s) => ({ handoffs: { ...s.handoffs, [taskId]: seq } }));
    setTimeout(() => {
      if (get().handoffs[taskId] !== seq) return; // a newer hand-off extended it
      const { [taskId]: _done, ...rest } = get().handoffs;
      set({ handoffs: rest });
    }, HANDOFF_MS);
  },
  setActivity: (runId, text) => set((s) => ({ activity: { ...s.activity, [runId]: text } })),
}));

/** True while a hand-off baton should travel on this task's strip. */
export function useHandoff(taskId: string): boolean {
  return useTaskPulse((s) => taskId in s.handoffs);
}

// ----------------------------------------------------------------------------- pure patches

const NODE_EVENT_STATUS: Record<string, NodeStatus> = {
  "node.started": "running",
  "node.resumed": "running",
  "node.running": "running",
  "node.waiting": "waiting",
  "node.completed": "passed",
  "node.failed": "failed",
  "node.skipped": "skipped",
  "node.cancelled": "cancelled",
};

const RUN_EVENT_STATUS: Record<string, RunStatus> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
};

const TERMINAL_NODE: NodeStatus[] = ["passed", "failed", "skipped", "cancelled"];

/** Apply a `node.*` event to a run; null when the event does not change it. */
export function applyNodeEvent(run: Run, ev: StudioEvent): Run | null {
  const status = NODE_EVENT_STATUS[ev.type];
  const p = ev.payload as { node_id?: string; node_run_id?: string; attempt?: number; status?: NodeStatus; error?: string };
  if (!status || !p.node_id) return null;
  const finalStatus = ev.type === "node.completed" || ev.type === "node.failed" ? (p.status ?? status) : status;
  const i = run.nodes.findIndex((n) => (p.node_run_id ? n.id === p.node_run_id : n.node_id === p.node_id && n.attempt === (p.attempt ?? n.attempt)));
  const finished = TERMINAL_NODE.includes(finalStatus) ? ev.ts : null;
  if (i >= 0) {
    const cur = run.nodes[i]!;
    if (cur.status === finalStatus) return null;
    const next: NodeRun = { ...cur, status: finalStatus, finished_at: finished ?? cur.finished_at, error: p.error ?? cur.error };
    const nodes = [...run.nodes];
    nodes[i] = next;
    return { ...run, nodes };
  }
  const attempt = p.attempt ?? Math.max(0, ...run.nodes.filter((n) => n.node_id === p.node_id).map((n) => n.attempt)) + 1;
  const created: NodeRun = {
    id: p.node_run_id ?? `${run.id}:${p.node_id}:${attempt}`,
    run_id: run.id,
    node_id: p.node_id,
    status: finalStatus,
    attempt,
    session_ids: [],
    worktree_ids: [],
    output: null,
    data: null,
    error: p.error ?? null,
    started_at: ev.ts,
    finished_at: finished,
  };
  return { ...run, nodes: [...run.nodes, created] };
}

/** A loop resets the region between its target and the gate to pending (`run.loop`). */
export function applyLoopEvent(run: Run, ev: StudioEvent): Run | null {
  const p = ev.payload as { from?: string; to?: string };
  if (!p.from || !p.to) return null;
  const region = nodesBetween(run.graph, p.to, p.from);
  region.delete(p.from); // the gate itself just finished (failed); it stays as is
  let changed = false;
  const nodes = run.nodes.map((n) => {
    if (!region.has(n.node_id) || n.status === "pending") return n;
    const latest = !run.nodes.some((m) => m.node_id === n.node_id && m.attempt > n.attempt);
    if (!latest) return n;
    changed = true;
    return { ...n, status: "pending" as NodeStatus };
  });
  return changed ? { ...run, nodes } : null;
}

const TASK_STATUSES: TaskStatus[] = ["draft", "queued", "running", "waiting", "completed", "failed", "cancelled"];

function asTaskStatus(v: unknown): TaskStatus | null {
  return typeof v === "string" && (TASK_STATUSES as string[]).includes(v) ? (v as TaskStatus) : null;
}

/** Route a batch of engine events into cache patches. Exported for tests. */
export function applyTaskEvents(qc: QueryClient, batch: StudioEvent[]): void {
  let refetchLists = false;
  let refetchQueue = false;
  const refetchRuns = new Set<string>();
  const pulse = useTaskPulse.getState();

  const patchRun = (runId: string | null, fn: (run: Run) => Run | null) => {
    if (!runId) return;
    const run = qc.getQueryData<Run>(taskKeys.run(runId));
    if (!run) return;
    const next = fn(run);
    if (next) qc.setQueryData(taskKeys.run(runId), next);
  };

  for (const ev of batch) {
    const p = ev.payload as Record<string, unknown>;
    const taskId = ev.task_id ?? (typeof p.task_id === "string" ? p.task_id : null);
    const runId = ev.run_id ?? (typeof p.run_id === "string" ? p.run_id : null);
    const label = typeof p.label === "string" ? p.label : "";

    switch (ev.type) {
      case "task.created":
        if (taskId) pulse.markFresh(taskId);
        refetchLists = true;
        refetchQueue = true;
        break;
      case "task.updated": {
        const status = asTaskStatus(p.status);
        if (taskId && status) {
          if (!patchTask(qc, taskId, { status, updated_at: ev.ts })) refetchLists = true;
        } else refetchLists = true;
        refetchQueue = true;
        break;
      }
      case "task.completed":
        if (taskId) {
          const score = typeof p.quality_score === "number" ? p.quality_score : null;
          patchTask(qc, taskId, (t) => ({ ...t, status: "completed", quality_score: score ?? t.quality_score, updated_at: ev.ts }));
        }
        refetchLists = true;
        break;
      case "task.failed":
        if (taskId) patchTask(qc, taskId, { status: "failed", updated_at: ev.ts });
        refetchLists = true;
        refetchQueue = true;
        break;
      case "task.deleted":
        if (taskId) removeTask(qc, taskId);
        refetchQueue = true;
        break;
      case "task.rated":
        refetchLists = true;
        break;
      case "run.started":
        if (taskId) patchTask(qc, taskId, (t: Task) => ({ ...t, status: "running", current_run_id: runId ?? t.current_run_id }));
        refetchQueue = true;
        break;
      case "run.updated": {
        const status = p.status as RunStatus | undefined;
        if (status) patchRun(runId, (run) => (run.status === status ? null : { ...run, status }));
        break;
      }
      case "run.completed":
      case "run.failed":
      case "run.cancelled": {
        const status = RUN_EVENT_STATUS[ev.type]!;
        patchRun(runId, (run) => ({ ...run, status, finished_at: ev.ts }));
        if (taskId && ev.type === "run.cancelled") patchTask(qc, taskId, { status: "cancelled", updated_at: ev.ts });
        break;
      }
      case "run.edge":
        if (taskId) pulse.markHandoff(taskId);
        break;
      case "run.loop":
        patchRun(runId, (run) => applyLoopEvent(run, ev));
        if (taskId) pulse.markHandoff(taskId);
        if (runId && typeof p.reason === "string" && p.reason) pulse.setActivity(runId, p.reason);
        break;
      case "run.reopened":
      case "node.retry":
        if (runId) refetchRuns.add(runId);
        break;
      case "agent.handoff":
        if (taskId) pulse.markHandoff(taskId);
        break;
      default:
        if (ev.type.startsWith("node.")) {
          patchRun(runId, (run) => applyNodeEvent(run, ev));
          if (runId && ev.type === "node.waiting" && typeof p.reason === "string") pulse.setActivity(runId, p.reason);
          else if (runId && ev.type === "node.started" && label) pulse.setActivity(runId, label);
        }
        break;
    }
  }
  if (refetchLists) void qc.invalidateQueries({ queryKey: taskKeys.all });
  if (refetchQueue) void qc.invalidateQueries({ queryKey: taskKeys.queueAll });
  for (const id of refetchRuns) void qc.invalidateQueries({ queryKey: taskKeys.run(id) });
}

/** Keep task lists, runs and the queue of a workspace live while mounted. */
export function useTaskLiveSync(workspaceId: string | null | undefined): void {
  const qc = useQueryClient();
  useEventStream(workspaceId ? { types: TASK_LIVE_TYPES, workspace_id: workspaceId, ephemeral: false } : null, (batch) =>
    applyTaskEvents(qc, batch),
  );
}
