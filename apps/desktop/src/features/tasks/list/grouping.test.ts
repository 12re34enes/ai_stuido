import { describe, expect, it } from "vitest";

import { dayKey, dayLabel, groupByDay } from "./grouping";
import type { Task } from "./types";

// Local times, so the test is independent of the machine's time zone.
const now = new Date(2026, 9, 3, 11, 0); // Saturday 3 October 2026

function task(id: string, created: Date): Task {
  return {
    id,
    workspace_id: "ws",
    title: id,
    prompt: id,
    mode: "duo",
    flow_id: null,
    studio_id: null,
    repo_ids: null,
    base_ref: null,
    inputs: {},
    budget: null,
    priority: 0,
    status: "completed",
    scheduled_at: null,
    source: "user",
    source_ref: null,
    current_run_id: null,
    quality_score: null,
    created_at: created.toISOString(),
    updated_at: created.toISOString(),
  };
}

describe("dayLabel", () => {
  it("names recent days in Turkish", () => {
    expect(dayLabel(dayKey(now), now)).toBe("Bugün");
    expect(dayLabel(dayKey(new Date(2026, 9, 2, 23, 59)), now)).toBe("Dün");
    expect(dayLabel(dayKey(new Date(2026, 9, 1, 9, 0)), now)).toBe("Perşembe");
    expect(dayLabel(dayKey(new Date(2026, 8, 27, 9, 0)), now)).toBe("Pazar");
  });

  it("uses day and month (and the year only when it differs)", () => {
    expect(dayLabel(dayKey(new Date(2026, 8, 20)), now)).toBe("20 Eylül Pazar");
    expect(dayLabel(dayKey(new Date(2025, 11, 31)), now)).toBe("31 Aralık 2025");
  });
});

describe("groupByDay", () => {
  it("emits a header per local day with its count", () => {
    const items = groupByDay(
      [task("a", new Date(2026, 9, 3, 10)), task("b", new Date(2026, 9, 3, 0, 5)), task("c", new Date(2026, 9, 2, 23, 50)), task("d", new Date(2026, 8, 30, 12))],
      now,
    );
    expect(items.map((i) => (i.type === "day" ? `# ${i.label} (${i.count})` : i.task.id))).toEqual(["# Bugün (2)", "a", "b", "# Dün (1)", "c", "# Çarşamba (1)", "d"]);
  });

  it("is empty for no tasks", () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});
