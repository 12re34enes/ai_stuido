import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StudioEvent } from "@/lib/events";

import { applyLoopEvent, applyNodeEvent, applyTaskEvents, HANDOFF_MS, useTaskPulse } from "./live";
import { taskKeys } from "./queries";
import type { FlowGraph, NodeRun, Run, Task } from "./types";

function ev(type: string, payload: Record<string, unknown> = {}, extra: Partial<StudioEvent> = {}): StudioEvent {
  return { id: 1, ts: "2026-10-03T08:00:00Z", type, severity: "info", actor: "system", workspace_id: "ws_1", task_id: "task_1", run_id: "run_1", session_id: null, payload, ephemeral: false, ...extra };
}

const graph: FlowGraph = {
  nodes: [
    { id: "dev", label: "Yazar", config: { kind: "agent", provider: "claude" } },
    { id: "build", label: "Build", config: { kind: "gate", gate: "build_test" } },
    { id: "review", label: "İnceleme", config: { kind: "gate", gate: "cross_review" } },
  ],
  edges: [
    { id: "e1", source: "dev", target: "build", condition: "default" },
    { id: "e2", source: "build", target: "review", condition: "default" },
    { id: "e3", source: "review", target: "dev", condition: "failed" },
  ],
};

function nodeRun(node_id: string, status: NodeRun["status"], attempt = 1): NodeRun {
  return { id: `nr_${node_id}_${attempt}`, run_id: "run_1", node_id, status, attempt, session_ids: [], worktree_ids: [], output: null, data: null, error: null, started_at: "2026-10-03T07:00:00Z", finished_at: null };
}

function run(nodes: NodeRun[]): Run {
  return { id: "run_1", task_id: "task_1", workspace_id: "ws_1", graph, status: "running", nodes, started_at: "2026-10-03T07:00:00Z", finished_at: null };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    workspace_id: "ws_1",
    title: "Görev",
    prompt: "Görev",
    mode: "duo",
    flow_id: null,
    studio_id: null,
    repo_ids: null,
    base_ref: null,
    inputs: {},
    budget: null,
    priority: 0,
    status: "running",
    scheduled_at: null,
    source: "user",
    source_ref: null,
    current_run_id: "run_1",
    quality_score: null,
    created_at: "2026-10-03T07:00:00Z",
    updated_at: "2026-10-03T07:00:00Z",
    ...over,
  };
}

describe("applyNodeEvent", () => {
  it("updates an existing node run", () => {
    const next = applyNodeEvent(run([nodeRun("dev", "running")]), ev("node.completed", { node_id: "dev", node_run_id: "nr_dev_1", status: "passed" }));
    expect(next?.nodes[0]).toMatchObject({ status: "passed", finished_at: "2026-10-03T08:00:00Z" });
  });

  it("adds a node run for a newly started node", () => {
    const next = applyNodeEvent(run([nodeRun("dev", "passed")]), ev("node.started", { node_id: "build", node_run_id: "nr_build_1", attempt: 1 }));
    expect(next?.nodes.map((n) => [n.node_id, n.status])).toEqual([
      ["dev", "passed"],
      ["build", "running"],
    ]);
  });

  it("returns null for unrelated or no-op events", () => {
    expect(applyNodeEvent(run([]), ev("node.whatever", { node_id: "dev" }))).toBeNull();
    expect(applyNodeEvent(run([nodeRun("dev", "running")]), ev("node.running", { node_id: "dev", node_run_id: "nr_dev_1" }))).toBeNull();
  });
});

describe("applyLoopEvent", () => {
  it("resets the looped region to pending, keeping the failed gate", () => {
    const r = run([nodeRun("dev", "passed"), nodeRun("build", "passed"), nodeRun("review", "failed")]);
    const next = applyLoopEvent(r, ev("run.loop", { from: "review", to: "dev", round: 1 }));
    expect(next?.nodes.map((n) => n.status)).toEqual(["pending", "pending", "failed"]);
  });
});

describe("applyTaskEvents", () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers();
    qc = new QueryClient();
    useTaskPulse.setState({ handoffs: {}, activity: {}, fresh: {} });
  });
  afterEach(() => vi.useRealTimers());

  it("patches task status in flat and paged lists", () => {
    const flat = taskKeys.flat({ workspaceId: "ws_1" });
    const pages = taskKeys.pages({ workspaceId: "ws_1" });
    qc.setQueryData(flat, [task()]);
    qc.setQueryData(pages, { pages: [[task()]], pageParams: [0] });
    applyTaskEvents(qc, [ev("task.updated", { status: "waiting" })]);
    expect(qc.getQueryData<Task[]>(flat)?.[0]?.status).toBe("waiting");
    expect(qc.getQueryData<{ pages: Task[][] }>(pages)?.pages[0]?.[0]?.status).toBe("waiting");
  });

  it("records the quality score on completion", () => {
    const flat = taskKeys.flat({ workspaceId: "ws_1" });
    qc.setQueryData(flat, [task()]);
    applyTaskEvents(qc, [ev("task.completed", { quality_score: 87 })]);
    expect(qc.getQueryData<Task[]>(flat)?.[0]).toMatchObject({ status: "completed", quality_score: 87 });
  });

  it("advances the cached run and tracks hand-offs and activity", () => {
    qc.setQueryData(taskKeys.run("run_1"), run([nodeRun("dev", "running")]));
    applyTaskEvents(qc, [
      ev("node.completed", { node_id: "dev", node_run_id: "nr_dev_1", status: "passed" }),
      ev("run.edge", { source: "dev", target: "build" }),
      ev("node.started", { node_id: "build", node_run_id: "nr_build_1", attempt: 1, label: "Build" }),
      ev("node.waiting", { node_id: "build", node_run_id: "nr_build_1", reason: "Onay bekleniyor" }),
    ]);
    const r = qc.getQueryData<Run>(taskKeys.run("run_1"));
    expect(r?.nodes.map((n) => [n.node_id, n.status])).toEqual([
      ["dev", "passed"],
      ["build", "waiting"],
    ]);
    expect(useTaskPulse.getState().handoffs.task_1).toBeDefined();
    expect(useTaskPulse.getState().activity.run_1).toBe("Onay bekleniyor");
    vi.advanceTimersByTime(HANDOFF_MS + 10);
    expect(useTaskPulse.getState().handoffs.task_1).toBeUndefined();
  });

  it("invalidates lists for new tasks and marks them fresh", () => {
    const spy = vi.spyOn(qc, "invalidateQueries");
    applyTaskEvents(qc, [ev("task.created", { task_id: "task_9" }, { task_id: "task_9" })]);
    expect(spy).toHaveBeenCalledWith({ queryKey: taskKeys.all });
    expect(useTaskPulse.getState().fresh.task_9).toBe(true);
  });

  it("removes deleted tasks", () => {
    const flat = taskKeys.flat({ workspaceId: "ws_1" });
    qc.setQueryData(flat, [task(), task({ id: "task_2" })]);
    applyTaskEvents(qc, [ev("task.deleted", {})]);
    expect(qc.getQueryData<Task[]>(flat)?.map((t) => t.id)).toEqual(["task_2"]);
  });
});
