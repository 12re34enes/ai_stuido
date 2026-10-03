import { describe, expect, it } from "vitest";

import type { Assignment } from "../../types";
import { layoutTimeline, tickStep } from "../timeline";
import { indexIssues, parseReport, validateTeamLocal, worstLevel } from "../validate";
import { assignmentRow, exampleSpec, member } from "./fixtures";

describe("local validation", () => {
  it("accepts the example team", () => {
    const r = validateTeamLocal(exampleSpec());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("flags structure problems on the member they concern", () => {
    const spec = exampleSpec();
    spec.members.push(member("lead", "lead-2"), member("tester", "qa-x", { tests_member_id: "nobody", parent_id: null }), member("worker", "orphan", { parent_id: "qa-b" }));
    spec.members[2] = { ...spec.members[2]!, name: " " };
    const r = validateTeamLocal(spec);
    const codes = r.errors.map((e) => [e.code, e.member_id]);
    expect(codes).toContainEqual(["many_leads", "lead-2"]);
    expect(codes).toContainEqual(["tester_target", "qa-x"]);
    expect(codes).toContainEqual(["parent_invalid", "orphan"]);
    expect(codes).toContainEqual(["name_missing", "dev-a"]);
    expect(r.ok).toBe(false);
  });

  it("warns about a lonely lead and missing advisor", () => {
    const r = validateTeamLocal({ ...exampleSpec(), members: [member("lead", "lead")] });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code).sort()).toEqual(["lead_alone", "no_advisor"]);
  });

  it("enforces max depth", () => {
    const spec = { ...exampleSpec(), settings: { ...exampleSpec().settings, max_depth: 1 } };
    expect(validateTeamLocal(spec).errors.filter((e) => e.code === "too_deep").map((e) => e.member_id).sort()).toEqual(["dev-a-1", "dev-a-2", "dev-b-1", "dev-b-2", "dev-c-1", "dev-c-2"]);
  });

  it("parses server reports with member_id or node_id and indexes them", () => {
    const report = parseReport({ ok: false, errors: [{ code: "x", message: "Sorun", node_id: "dev-a" }], warnings: [{ code: "y", message: "Uyarı", member_id: "ghost" }, { nope: 1 }] })!;
    expect(report.errors[0]!.member_id).toBe("dev-a");
    expect(report.warnings).toHaveLength(1);
    const idx = indexIssues(report, new Set(["dev-a"]));
    expect(worstLevel(idx.byMember["dev-a"])).toBe("error");
    expect(idx.global.map((i) => i.code)).toEqual(["y"]);
    expect(parseReport("nope")).toBeNull();
  });
});

const assignment = (id: string, to: string, over: Partial<Assignment>): Assignment => assignmentRow(id, to, over);

describe("timeline layout", () => {
  const t = (m: number) => new Date(Date.parse("2026-10-03T08:00:00Z") + m * 60_000).toISOString();
  const now = Date.parse(t(20));

  it("builds lanes in tree order, live bars grow to now, dependencies link bars", () => {
    const list = [
      assignment("a1", "dev-a", { started_at: t(1), finished_at: t(6) }),
      assignment("a2", "dev-b", { started_at: t(2), status: "running" }),
      assignment("a3", "dev-a", { created_at: t(7), status: "pending", depends_on: ["a1", "missing"] }),
      assignment("a4", "dev-c", { status: "cancelled" }),
    ];
    const l = layoutTimeline(list, ["lead", "dev-b", "dev-a", "dev-c"], now);
    expect(l.lanes.map((x) => x.memberId)).toEqual(["dev-b", "dev-a"]);
    const a2 = l.bars.find((b) => b.id === "a2")!;
    expect(a2).toMatchObject({ lane: 0, live: true, end: now });
    const a3 = l.bars.find((b) => b.id === "a3")!;
    expect(a3).toMatchObject({ waiting: true, live: true, start: Date.parse(t(7)) });
    expect(l.links).toEqual([{ id: "a1>a3", from: "a1", to: "a3" }]);
    expect(l.start).toBeLessThan(Date.parse(t(1)));
    expect(l.end).toBeGreaterThanOrEqual(now);
    expect(l.ticks.length).toBeGreaterThan(1);
    expect(l.ticks.length).toBeLessThanOrEqual(7);
  });

  it("stacks overlapping bars of one member into sub-rows", () => {
    const list = [assignment("a1", "dev-a", { started_at: t(1), finished_at: t(10) }), assignment("a2", "dev-a", { started_at: t(4), finished_at: t(8) }), assignment("a3", "dev-a", { started_at: t(11), finished_at: t(12) })];
    const l = layoutTimeline(list, ["dev-a"], now);
    expect(l.bars.map((b) => [b.id, b.row])).toEqual([
      ["a1", 0],
      ["a2", 1],
      ["a3", 0],
    ]);
    expect(l.lanes[0]!.rows).toBe(2);
  });

  it("picks readable tick steps and handles an empty run", () => {
    expect(tickStep(5 * 60_000)).toBe(60_000);
    expect(tickStep(2 * 3_600_000)).toBe(1_800_000);
    const empty = layoutTimeline([], ["lead"], now);
    expect(empty.bars).toEqual([]);
    expect(empty.end - empty.start).toBeGreaterThanOrEqual(60_000);
  });
});
