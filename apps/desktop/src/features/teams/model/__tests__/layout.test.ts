import { describe, expect, it } from "vitest";

import { orgEdges, structureKey, withPositions } from "../graph";
import { layoutTeam, neighborInDirection, type TeamLayout } from "../layout";
import { normalizeSpec } from "../spec";
import { exampleSpec, member } from "./fixtures";

const W = 200;
const H = 70;
const size = () => ({ w: W, h: H });

function box(layout: TeamLayout, id: string) {
  const p = layout.positions.get(id)!;
  const s = layout.sizes.get(id)!;
  return { x0: p.x, x1: p.x + s.w, y0: p.y, y1: p.y + s.h, cx: p.x + s.w / 2 };
}

describe("tidy tree layout", () => {
  const layout = layoutTeam(exampleSpec(), size);

  it("never overlaps two cards", () => {
    const ids = [...layout.positions.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = box(layout, ids[i]!);
        const b = box(layout, ids[j]!);
        const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        expect(overlap, `${ids[i]} overlaps ${ids[j]}`).toBe(false);
      }
    }
  });

  it("puts the lead's advisor above it, workers in rows below", () => {
    expect(layout.rows.get("advisor")).toBe(0);
    expect(layout.rows.get("lead")).toBe(1);
    expect(layout.rows.get("dev-a")).toBe(2);
    expect(layout.rows.get("dev-a-1")).toBe(3);
    expect(box(layout, "advisor").cx).toBeCloseTo(box(layout, "lead").cx, 5);
    expect(box(layout, "advisor").y1).toBeLessThan(box(layout, "lead").y0);
  });

  it("centers a manager over its children and keeps sibling order", () => {
    const a = box(layout, "dev-a");
    const a1 = box(layout, "dev-a-1");
    const a2 = box(layout, "dev-a-2");
    expect(a.cx).toBeCloseTo((a1.cx + a2.cx) / 2, 5);
    expect(box(layout, "dev-a").x0).toBeLessThan(box(layout, "dev-b").x0);
    expect(box(layout, "dev-b").x0).toBeLessThan(box(layout, "dev-c").x0);
  });

  it("places a dependent tester beside its target and independent testers under their parent", () => {
    const b = box(layout, "dev-b");
    const qa = box(layout, "qa-b");
    expect(layout.rows.get("qa-b")).toBe(layout.rows.get("dev-b"));
    expect(qa.x0).toBeGreaterThan(b.x1);
    expect(layout.rows.get("qa-all")).toBe(layout.rows.get("dev-a"));
    expect(box(layout, "qa-all").x0).toBeGreaterThan(box(layout, "dev-c").x0);
  });

  it("puts a non-lead member's advisor on its left", () => {
    const spec = exampleSpec();
    spec.members.push(member("advisor", "adv-c", { parent_id: "dev-c" }));
    const l = layoutTeam(spec, size);
    expect(l.rows.get("adv-c")).toBe(l.rows.get("dev-c"));
    expect(box(l, "adv-c").x1).toBeLessThan(box(l, "dev-c").x0);
  });

  it("row heights follow the tallest card", () => {
    const tall = layoutTeam(exampleSpec(), (m) => ({ w: W, h: m.id === "dev-b" ? 160 : H }));
    expect(box(tall, "dev-b-1").y0).toBeGreaterThan(box(tall, "dev-b").y1);
    expect(box(tall, "dev-a-1").y0).toBe(box(tall, "dev-b-1").y0);
  });

  it("lays out broken references instead of dropping them", () => {
    const spec = normalizeSpec({ members: [member("lead", "lead"), member("worker", "stray", { parent_id: "missing" })] });
    const l = layoutTeam(spec, size);
    expect(l.positions.has("stray")).toBe(true);
    expect(box(l, "stray").x0).toBeGreaterThanOrEqual(box(l, "lead").x1);
  });

  it("navigates the chart by direction", () => {
    expect(neighborInDirection(layout, "lead", "up")).toBe("advisor");
    expect(neighborInDirection(layout, "dev-b", "down")).toMatch(/^dev-b-/);
    expect(neighborInDirection(layout, "dev-a", "right")).toBe("dev-b");
    expect(neighborInDirection(layout, "dev-a-1", "left")).toBeNull();
  });
});

describe("spec ⇄ graph", () => {
  it("derives every link with its kind and handles", () => {
    const edges = orgEdges(exampleSpec());
    const byKind = (k: string) => edges.filter((e) => e.kind === k).map((e) => e.id).sort();
    expect(byKind("delegate")).toHaveLength(9);
    expect(byKind("advise")).toEqual(["a:advisor>lead"]);
    expect(byKind("test")).toEqual(["t:dev-b>qa-b"]);
    expect(byKind("suite")).toEqual(["s:lead>qa-all"]);
    const adv = edges.find((e) => e.kind === "advise")!;
    expect([adv.sourceHandle, adv.targetHandle]).toEqual(["b", "t"]);
    const test = edges.find((e) => e.kind === "test")!;
    expect([test.source, test.target, test.sourceHandle, test.targetHandle]).toEqual(["dev-b", "qa-b", "r", "l"]);
  });

  it("writes layout positions back into the spec and keys structure only", () => {
    const spec = exampleSpec();
    const layout = layoutTeam(spec, size);
    const saved = withPositions(spec, layout);
    expect(saved.members.every((m) => m.position !== null)).toBe(true);
    expect(saved.members.find((m) => m.id === "lead")!.position).toEqual(layout.positions.get("lead"));
    const renamed = { ...spec, members: spec.members.map((m) => (m.id === "dev-a" ? { ...m, name: "Yeni ad", model: "x" } : m)) };
    expect(structureKey(renamed)).toBe(structureKey(spec));
    expect(structureKey({ ...spec, members: spec.members.slice(1) })).not.toBe(structureKey(spec));
  });
});
