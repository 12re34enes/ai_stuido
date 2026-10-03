import { CARD_W, GAP_X, JUNCTION, deriveFlow, latestRuns, layoutGraph, navigationOrder, topology } from "../graph";
import type { FlowGraph } from "../types";

import { at, duoGraph, nodeRun, raceGraph } from "./fixtures";

describe("topology", () => {
  it("finds the entry and classifies loop edges as back edges (like the engine)", () => {
    const t = topology(duoGraph());
    expect(t.entry).toBe("dev");
    expect([...t.backEdges].sort()).toEqual(["e_boundary_dev_failed", "e_build_dev_failed", "e_final_dev_failed", "e_review_dev_failed"]);
    expect(t.order).toEqual(["dev", "boundary", "build", "review", "final"]);
  });

  it("keeps a forward failure edge forward when it does not close a cycle", () => {
    const g: FlowGraph = {
      nodes: [
        { id: "a", label: "A", config: { kind: "agent" } },
        { id: "b", label: "B", config: { kind: "gate", gate: "build_test" } },
        { id: "notify", label: "Bildir", config: { kind: "human" } },
      ],
      edges: [
        { id: "ab", source: "a", target: "b", condition: "default" },
        { id: "bn", source: "b", target: "notify", condition: "failed" },
      ],
    };
    expect(topology(g).backEdges.size).toBe(0);
  });
});

describe("layoutGraph", () => {
  it("lays a linear flow out left→right on one axis", () => {
    const l = layoutGraph(duoGraph());
    const xs = ["dev", "boundary", "build", "review", "final"].map((id) => l.nodes[id]!.x);
    expect(xs).toEqual([0, 1, 2, 3, 4].map((i) => i * (CARD_W + GAP_X)));
    expect(new Set(Object.values(l.nodes).map((n) => n.y)).size).toBe(1);
    expect(l.width).toBe(5 * CARD_W + 4 * GAP_X);
  });

  it("stacks parallel branches and keeps junction columns narrow", () => {
    const l = layoutGraph(raceGraph());
    const fork = l.nodes.fork!;
    const a = l.nodes.dev_a!;
    const b = l.nodes.dev_b!;
    expect(fork.shape).toBe("junction");
    expect(fork.width).toBe(JUNCTION);
    expect(a.layer).toBe(1);
    expect(b.layer).toBe(1);
    expect(a.x).toBe(b.x);
    expect(a.x).toBe(JUNCTION + GAP_X);
    expect(a.y).toBeLessThan(b.y);
    // the junction is centred between the branches
    expect(fork.y + fork.height / 2).toBeCloseTo((a.y + a.height / 2 + b.y + b.height / 2) / 2);
    expect(l.nodes.compare!.layer).toBe(2);
    expect(l.nodes.merge!.layer).toBe(3);
  });

  it("orders keyboard navigation by column then row", () => {
    expect(navigationOrder(layoutGraph(raceGraph()))).toEqual(["fork", "dev_a", "dev_b", "compare", "merge"]);
  });

  it("survives an empty graph", () => {
    const l = layoutGraph({ nodes: [], edges: [] });
    expect(l.width).toBe(0);
    expect(Object.keys(l.nodes)).toEqual([]);
  });
});

describe("deriveFlow", () => {
  it("uses the latest attempt per node", () => {
    const runs = [nodeRun("dev", "passed", { attempt: 1 }), nodeRun("dev", "running", { attempt: 2, started_at: "2026-10-03T08:05:00Z" })];
    expect(latestRuns(runs).get("dev")?.attempt).toBe(2);
  });

  it("marks taken edges done and focuses the running node", () => {
    const runs = [nodeRun("dev", "passed", { started_at: at(0) }), nodeRun("boundary", "passed", { started_at: at(60) }), nodeRun("build", "running", { started_at: at(90) })];
    const v = deriveFlow(duoGraph(), runs);
    const byId = Object.fromEntries(v.edges.map((e) => [e.id, e]));
    expect(byId.e_dev_boundary?.state).toBe("done");
    expect(byId.e_boundary_build?.state).toBe("done");
    expect(byId.e_build_review?.state).toBe("idle");
    expect(v.focus).toBe("build");
    expect(v.done).toBe(2);
    expect(v.total).toBe(5);
  });

  it("after a loop-back shows the loop edge and treats the re-run region as pending", () => {
    const runs = [
      nodeRun("dev", "passed", { attempt: 1, started_at: at(0) }),
      nodeRun("boundary", "passed", { started_at: at(60) }),
      nodeRun("build", "failed", { started_at: at(90) }),
      nodeRun("dev", "running", { attempt: 2, started_at: at(300) }),
    ];
    const v = deriveFlow(duoGraph(), runs);
    const byId = Object.fromEntries(v.edges.map((e) => [e.id, e]));
    expect(byId.e_build_dev_failed).toMatchObject({ back: true, visible: true, state: "failed", round: 2 });
    expect(byId.e_review_dev_failed?.visible).toBe(false);
    expect(v.nodes.boundary).toMatchObject({ status: "pending", stale: true });
    expect(v.nodes.build).toMatchObject({ status: "pending", stale: true });
    expect(v.nodes.boundary?.run?.status).toBe("passed");
    expect(byId.e_dev_boundary?.state).toBe("idle");
    expect(v.focus).toBe("dev");
    expect(v.done).toBe(0);
  });

  it("animates a hand-off only inside the hand-off window", () => {
    const g = duoGraph();
    const runs = [nodeRun("dev", "passed"), nodeRun("boundary", "running")];
    const handoffs = new Map([["e_dev_boundary", 1000]]);
    expect(deriveFlow(g, runs, { handoffs, now: 2000 }).edges[0]!.state).toBe("active");
    expect(deriveFlow(g, runs, { handoffs, now: 9000 }).edges[0]!.state).toBe("done");
  });

  it("does not count structural nodes as steps", () => {
    const v = deriveFlow(raceGraph(), [nodeRun("fork", "passed"), nodeRun("dev_a", "passed"), nodeRun("dev_b", "running")]);
    expect(v.total).toBe(4);
    expect(v.done).toBe(1);
    expect(v.focus).toBe("dev_b");
  });

  it("focuses a waiting node over a running one", () => {
    const v = deriveFlow(raceGraph(), [nodeRun("dev_a", "running"), nodeRun("dev_b", "waiting")]);
    expect(v.focus).toBe("dev_b");
  });
});
