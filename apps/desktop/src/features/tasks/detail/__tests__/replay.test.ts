import { describeEvent, isKeyEvent } from "../describe";
import { deriveFlow } from "../graph";
import { Replay, buildTimeAxis, keyMoments, lastIndexAtOrBefore } from "../replay";
import { clock, defaultSpeed } from "../replayClock";

import { T0, duoGraph, ev } from "./fixtures";

const ctx = { nodeLabel: (id: string) => ({ dev: "Yazar", boundary: "Sınır denetimi", build: "Build/test" })[id] ?? id, sessionLabel: () => "Yazar · Claude" };

/** A duo run: dev → boundary → build fails → loop back → dev round 2 → … */
function duoEvents() {
  return [
    ev("run.started", 0, { run_id: "run_1" }),
    ev("node.started", 1, { node_id: "dev", node_run_id: "nr_dev_1", attempt: 1, label: "Yazar" }),
    ev("node.session", 2, { node_id: "dev", provider: "claude", model: "claude-opus-5-5", role: "writer" }, { session_id: "ses_1" }),
    ev("agent.status", 3, { state: "running_tool" }, { session_id: "ses_1" }),
    ev("agent.tool.call", 4, { tool: "Bash", summary: "pnpm test" }, { session_id: "ses_1" }),
    ev("node.completed", 30, { node_id: "dev", node_run_id: "nr_dev_1", attempt: 1, status: "passed", output_preview: "Bitti" }),
    ev("run.edge", 30, { edge_id: "e_dev_boundary", source: "dev", target: "boundary" }),
    ev("node.started", 31, { node_id: "boundary", node_run_id: "nr_b_1", attempt: 1 }),
    ev("gate.passed", 32, { node_id: "boundary", gate: "boundary_check", summary: "ihlal yok", attempt: 1 }),
    ev("node.completed", 32, { node_id: "boundary", node_run_id: "nr_b_1", status: "passed" }),
    ev("run.edge", 32, { edge_id: "e_boundary_build", source: "boundary", target: "build" }),
    ev("node.started", 33, { node_id: "build", node_run_id: "nr_build_1", attempt: 1 }),
    // one hour of silence (e.g. waiting) before the build fails
    ev("gate.failed", 3633, { node_id: "build", gate: "build_test", summary: "1/4 komut başarısız", attempt: 1 }),
    ev("node.failed", 3633, { node_id: "build", node_run_id: "nr_build_1", status: "failed", error: "1/4 komut başarısız" }),
    ev("run.loop", 3633, { from: "build", to: "dev", round: 1, max_rounds: 3, reason: "testler kırık" }),
    ev("node.started", 3634, { node_id: "dev", node_run_id: "nr_dev_2", attempt: 2 }),
  ];
}

describe("buildTimeAxis", () => {
  it("is the identity (offset by start) without long gaps", () => {
    const axis = buildTimeAxis([T0, T0 + 1000, T0 + 5000]);
    expect(axis.duration).toBe(5000);
    expect(axis.toPos(T0 + 2500)).toBe(2500);
    expect(axis.toTime(2500)).toBe(T0 + 2500);
    expect(axis.gaps).toEqual([]);
  });

  it("compresses silences longer than the threshold and maps both ways", () => {
    const axis = buildTimeAxis([T0, T0 + 10_000, T0 + 3_610_000, T0 + 3_615_000], { gapThreshold: 20_000, gapCompressed: 2_000 });
    expect(axis.gaps).toEqual([{ from: 10_000, to: 12_000, realMs: 3_600_000 }]);
    expect(axis.duration).toBe(17_000);
    expect(axis.toPos(T0 + 3_610_000)).toBe(12_000);
    expect(axis.toPos(T0 + 3_612_000)).toBe(14_000);
    // halfway through the compressed gap is halfway through the real gap
    expect(axis.toTime(11_000)).toBe(T0 + 10_000 + 1_800_000);
    expect(axis.toPos(axis.toTime(15_500))).toBeCloseTo(15_500);
  });

  it("clamps outside the range and survives no events", () => {
    const axis = buildTimeAxis([]);
    expect(axis.duration).toBe(0);
    expect(axis.toPos(123)).toBe(0);
    const a2 = buildTimeAxis([T0, T0 + 100]);
    expect(a2.toPos(T0 - 50)).toBe(0);
    expect(a2.toPos(T0 + 500)).toBe(100);
  });
});

describe("lastIndexAtOrBefore", () => {
  it("binary searches the playhead index", () => {
    expect(lastIndexAtOrBefore([1, 3, 3, 7], 0)).toBe(-1);
    expect(lastIndexAtOrBefore([1, 3, 3, 7], 3)).toBe(2);
    expect(lastIndexAtOrBefore([1, 3, 3, 7], 100)).toBe(3);
  });
});

describe("Replay", () => {
  it("reconstructs node runs, agents and gates at any index", () => {
    const events = duoEvents();
    const r = new Replay(events, 4);
    const graph = duoGraph();

    const early = r.stateAt(4); // dev running, agent running a tool
    expect(early.nodeRuns.map((n) => [n.node_id, n.status])).toEqual([["dev", "running"]]);
    expect(early.agents.ses_1).toMatchObject({ nodeId: "dev", provider: "claude", state: "running_tool", lastLine: "pnpm test" });

    const mid = r.stateAt(11); // build started
    expect(deriveFlow(graph, mid.nodeRuns).nodes.boundary?.status).toBe("passed");
    expect(mid.gates).toHaveLength(1);
    expect(mid.handoffs.e_boundary_build).toBe(T0 + 32_000);

    const end = r.stateAt(events.length - 1);
    const view = deriveFlow(graph, end.nodeRuns);
    expect(view.nodes.dev).toMatchObject({ status: "running", attempts: 2 });
    expect(view.nodes.build?.status).toBe("pending"); // stale: will re-run after the loop
    expect(view.edges.find((e) => e.id === "e_build_dev_failed")).toMatchObject({ visible: true, state: "failed" });
    expect(end.gates.map((g) => g.status)).toEqual(["passed", "failed"]);
  });

  it("gives the same state from snapshots as from a full fold", () => {
    const events = duoEvents();
    const a = new Replay(events, 3);
    const b = new Replay(events, 1000);
    for (let i = -1; i < events.length; i++) {
      expect(a.stateAt(i)).toEqual(b.stateAt(i));
    }
  });

  it("finds the event index for a wall time", () => {
    const r = new Replay(duoEvents());
    expect(r.indexAtTime(T0 - 1)).toBe(-1);
    expect(r.indexAtTime(T0 + 31_500)).toBe(7);
  });

  it("marks run end status and approvals", () => {
    const r = new Replay([
      ev("approval.requested", 1, { approval_id: "apr_1", title: "Son onay", kind: "final" }),
      ev("approval.decided", 2, { approval_id: "apr_1", status: "approved" }),
      ev("run.completed", 3, { status: "completed" }),
    ]);
    const st = r.stateAt(2);
    expect(st.approvals.apr_1?.status).toBe("approved");
    expect(st.runStatus).toBe("completed");
  });
});

describe("replay clock", () => {
  it("formats elapsed time and picks a speed that keeps a replay short", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65_400)).toBe("1:05");
    expect(clock(3_725_000)).toBe("1:02:05");
    expect(defaultSpeed(60_000)).toBe(1);
    expect(defaultSpeed(150_000)).toBe(2);
    expect(defaultSpeed(10 * 60_000)).toBe(8);
  });
});

describe("key moments and descriptions", () => {
  it("extracts gate results, hand-offs, loops and errors with Turkish labels", () => {
    const events = new Replay(duoEvents()).events;
    const moments = keyMoments(events, (e) => describeEvent(e, ctx).title);
    expect(moments.map((m) => m.kind)).toEqual(["start", "handoff", "gate-pass", "handoff", "gate-fail", "error", "loop"]);
    expect(moments[1]!.label).toBe("Yazar → Sınır denetimi");
    expect(moments[4]!.label).toBe("Build/test kanıtı geçmedi");
  });

  it("filters agent chatter out of the key list", () => {
    expect(isKeyEvent(ev("agent.tool.call", 0))).toBe(false);
    expect(isKeyEvent(ev("gate.passed", 0))).toBe(true);
  });

  it("describes approvals and loops", () => {
    expect(describeEvent(ev("approval.decided", 0, { status: "rejected", note: "Önce test" }), ctx)).toMatchObject({ title: "Onay reddedildi", detail: "Önce test", tone: "danger" });
    expect(describeEvent(ev("run.loop", 0, { from: "build", to: "dev", round: 2, max_rounds: 3 }), ctx).title).toBe("Build/test işi Yazar adımına geri gönderdi");
  });
});
