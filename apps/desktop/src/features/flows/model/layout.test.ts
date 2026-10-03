import { describe, expect, it } from "vitest";

import type { EdgeCondition } from "../types";
import { autoLayout, CENTER_Y, COLUMN_WIDTH, loopLanes, ORIGIN_X, ROW_HEIGHT } from "./layout";
import { buildTopology, layers, upstream } from "./topology";

const e = (source: string, target: string, condition: EdgeCondition = "default") => ({ id: `${source}-${target}-${condition}`, source, target, condition });

describe("topology", () => {
  it("finds the entry and back edges like the engine", () => {
    const topo = buildTopology(["dev", "build", "final"], [e("dev", "build"), e("build", "final"), e("build", "dev", "failed"), e("final", "dev", "failed")]);
    expect(topo.entry).toBe("dev");
    expect([...topo.backEdges].sort()).toEqual(["build-dev-failed", "final-dev-failed"]);
    expect(topo.reachable.size).toBe(3);
  });

  it("reports several entry candidates", () => {
    const topo = buildTopology(["a", "b", "c"], [e("a", "c"), e("b", "c")]);
    expect(topo.entry).toBeNull();
    expect(topo.entryCandidates).toEqual(["a", "b"]);
  });

  it("breaks cycles without loop conditions so layering terminates", () => {
    const topo = buildTopology(["a", "b"], [e("a", "b"), e("b", "a")]);
    const l = layers(topo);
    expect(l.size).toBe(2);
  });

  it("lists upstream nodes nearest first", () => {
    const topo = buildTopology(["plan", "gate", "dev", "review"], [e("plan", "gate"), e("gate", "dev"), e("dev", "review"), e("review", "dev", "failed")]);
    expect(upstream(topo, "review")).toEqual(["dev", "gate", "plan"]);
  });
});

describe("autoLayout", () => {
  it("puts one longest-path layer per column, left to right", () => {
    const { positions } = autoLayout(["dev", "build", "final"], [e("dev", "build"), e("build", "final"), e("final", "dev", "failed")]);
    expect(positions.get("dev")).toEqual({ x: ORIGIN_X, y: CENTER_Y });
    expect(positions.get("build")).toEqual({ x: ORIGIN_X + COLUMN_WIDTH, y: CENTER_Y });
    expect(positions.get("final")).toEqual({ x: ORIGIN_X + 2 * COLUMN_WIDTH, y: CENTER_Y });
  });

  it("centers parallel branches vertically and joins after the longest branch", () => {
    const { positions } = autoLayout(["fork", "a", "b", "a2", "join"], [e("fork", "a"), e("fork", "b"), e("a", "a2"), e("a2", "join"), e("b", "join")]);
    const ya = positions.get("a")!.y;
    const yb = positions.get("b")!.y;
    expect(Math.abs(ya - yb)).toBe(ROW_HEIGHT);
    expect((ya + yb) / 2).toBe(CENTER_Y);
    expect(positions.get("join")!.x).toBe(ORIGIN_X + 3 * COLUMN_WIDTH);
  });

  it("orders a column by its parents to avoid crossings", () => {
    // p1 sits above p2; their children should keep that order even if listed reversed.
    const { positions } = autoLayout(["root", "p1", "p2", "c2", "c1"], [e("root", "p1"), e("root", "p2"), e("p1", "c1"), e("p2", "c2")]);
    expect(positions.get("p1")!.y).toBeLessThan(positions.get("p2")!.y);
    expect(positions.get("c1")!.y).toBeLessThan(positions.get("c2")!.y);
  });

  it("places disconnected nodes after the graph", () => {
    const { positions } = autoLayout(["a", "b", "lonely"], [e("a", "b")]);
    expect(positions.get("lonely")!.x).toBeGreaterThanOrEqual(positions.get("a")!.x);
  });

  it("stacks nested loops in lanes", () => {
    const edges = [e("a", "b"), e("b", "c"), e("c", "d"), e("b", "a", "failed"), e("d", "a", "failed"), e("c", "b", "failed")];
    const { topology, layer } = autoLayout(["a", "b", "c", "d"], edges);
    const lanes = loopLanes(topology, layer);
    // Loops sharing a node overlap horizontally there, so they take separate lanes.
    expect(lanes.get("b-a-failed")).toBe(1);
    expect(lanes.get("c-b-failed")).toBe(2);
    expect(lanes.get("d-a-failed")).toBe(3);
  });
});
