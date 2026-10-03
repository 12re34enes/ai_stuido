import { QueryClient } from "@tanstack/react-query";

import { tdKeys } from "../api";
import { applyTaskEvents, type LiveSink } from "../live";
import type { Run, SessionView, TaskDetail } from "../types";

import { duoGraph, ev, nodeRun, run } from "./fixtures";

function setup() {
  const qc = new QueryClient();
  const r = run(duoGraph(), [nodeRun("dev", "running", { id: "nr_dev_1" })]);
  qc.setQueryData(tdKeys.run("run_1"), r);
  const detail = { task: { id: "task_1", status: "running" }, runs: [{ id: "run_1", status: "running", error: null, started_at: r.started_at, finished_at: null }], current_run: r } as unknown as TaskDetail;
  qc.setQueryData(tdKeys.task("task_1"), detail);
  qc.setQueryData<SessionView[]>(tdKeys.sessions("run_1"), [{ id: "ses_1", state: "thinking" } as SessionView]);
  const calls = { handoffs: [] as string[], progress: [] as string[], lines: [] as string[], waits: [] as string[], conflicts: 0 };
  const sink: LiveSink = {
    handoff: (id) => calls.handoffs.push(id),
    progress: (id, v) => calls.progress.push(`${id}:${v.status}`),
    lastLine: (sid, line) => calls.lines.push(`${sid}:${line}`),
    waiting: (id, reason) => calls.waits.push(`${id}:${reason ?? "-"}`),
    conflict: () => calls.conflicts++,
  };
  const scheduled: string[] = [];
  const schedule = (key: readonly unknown[]) => scheduled.push(key.join("/"));
  const apply = (...events: Parameters<typeof ev>[]) => applyTaskEvents(qc, "task_1", events.map((a) => ev(...a)), sink, schedule);
  return { qc, calls, scheduled, apply };
}

describe("applyTaskEvents", () => {
  it("morphs node runs in place: complete, hand off, start the next node", () => {
    const { qc, calls, scheduled, apply } = setup();
    apply(
      ["node.completed", 10, { node_id: "dev", node_run_id: "nr_dev_1", status: "passed", output_preview: "Bitti" }],
      ["run.edge", 10, { edge_id: "e_dev_boundary", source: "dev", target: "boundary" }],
      ["node.started", 11, { node_id: "boundary", node_run_id: "nr_b_1", attempt: 1 }],
    );
    const r = qc.getQueryData<Run>(tdKeys.run("run_1"))!;
    expect(r.nodes.map((n) => [n.node_id, n.status])).toEqual([
      ["dev", "passed"],
      ["boundary", "running"],
    ]);
    expect(r.nodes[0]!.output).toBe("Bitti");
    expect(calls.handoffs).toEqual(["e_dev_boundary"]);
    expect(calls.waits).toEqual(["dev:-", "boundary:-"]);
    expect(scheduled).toContain("taskDetail/run/run_1"); // fetch the full output
  });

  it("patches run and task status on run end and refetches the detail", () => {
    const { qc, scheduled, apply } = setup();
    apply(["run.completed", 20, { status: "completed" }], ["task.completed", 20, { title: "x", quality_score: 88 }]);
    expect(qc.getQueryData<Run>(tdKeys.run("run_1"))!.status).toBe("completed");
    const d = qc.getQueryData<TaskDetail>(tdKeys.task("task_1"))!;
    expect(d.task.status).toBe("completed");
    expect(d.current_run?.status).toBe("completed");
    expect(d.runs[0]!.status).toBe("completed");
    expect(scheduled).toContain("taskDetail/task/task_1");
  });

  it("updates agent state, last line and usage", () => {
    const { qc, calls, scheduled, apply } = setup();
    apply(
      ["agent.status", 1, { state: "running_tool" }, { session_id: "ses_1" }],
      ["agent.tool.call", 2, { tool: "Bash", summary: "pnpm test" }, { session_id: "ses_1" }],
      ["agent.message", 3, { text: "Testler geçti.\n\nŞimdi incelemeye veriyorum." }, { session_id: "ses_1" }],
      ["agent.usage", 4, { input_tokens: 10, output_tokens: 5 }, { session_id: "ses_1" }],
    );
    const s = qc.getQueryData<SessionView[]>(tdKeys.sessions("run_1"))![0]!;
    expect(s.state).toBe("running_tool");
    expect(s.last_usage).toMatchObject({ input_tokens: 10 });
    expect(calls.lines).toEqual(["ses_1:pnpm test", "ses_1:Şimdi incelemeye veriyorum."]);
    expect(scheduled).toContain("taskDetail/task/task_1/usage");
  });

  it("refetches gates and evidence on gate results, sessions for unknown agents", () => {
    const { scheduled, apply } = setup();
    apply(["gate.failed", 1, { node_id: "build", gate: "build_test" }], ["agent.status", 2, { state: "thinking" }, { session_id: "ses_new" }]);
    expect(scheduled).toEqual(expect.arrayContaining(["taskDetail/run/run_1/gates", "taskDetail/run/run_1/evidence", "taskDetail/run/run_1/sessions"]));
  });

  it("tracks why a node waits until it moves on", () => {
    const { calls, apply } = setup();
    apply(["node.waiting", 1, { node_id: "dev", node_run_id: "nr_dev_1", reason: "Plan onayı bekleniyor" }], ["node.running", 2, { node_id: "dev", node_run_id: "nr_dev_1" }]);
    expect(calls.waits).toEqual(["dev:Plan onayı bekleniyor", "dev:-"]);
  });

  it("forwards progress and conflicts", () => {
    const { calls, apply } = setup();
    apply(["node.progress", 1, { node_id: "dev", status: "Testleri yazıyorum", progress: 40 }], ["conflict.detected", 2, { repo: "web", conflicts: ["a.ts"] }]);
    expect(calls.progress).toEqual(["dev:Testleri yazıyorum"]);
    expect(calls.conflicts).toBe(1);
  });
});
