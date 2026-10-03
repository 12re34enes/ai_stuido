import { describe, expect, it } from "vitest";

import { builderToCron, cronToBuilder, describeCron, joinTr, nextRuns, parseCron, switchBuilder, zonedToInstant } from "./cron";

describe("parseCron", () => {
  it("parses lists, ranges, steps and names", () => {
    const r = parseCron("*/15 9-17 * jan-mar mon-fri");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.cron.minutes).toEqual([0, 15, 30, 45]);
    expect(r.cron.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(r.cron.months).toEqual([1, 2, 3]);
    expect(r.cron.weekdays).toEqual([1, 2, 3, 4, 5]);
    expect(r.cron.dayStar).toBe(true);
    expect(r.cron.weekdayStar).toBe(false);
  });

  it("treats 7 as Sunday and expands aliases", () => {
    const r = parseCron("0 0 * * 7");
    expect(r.ok && r.cron.weekdays).toEqual([0]);
    const daily = parseCron("@daily");
    expect(daily.ok && daily.cron.fields).toEqual(["0", "0", "*", "*", "*"]);
  });

  it("rejects bad input with Turkish messages", () => {
    expect(parseCron("")).toEqual({ ok: false, error: "Cron ifadesi boş." });
    const six = parseCron("0 0 * * * *");
    expect(six.ok).toBe(false);
    const bad = parseCron("61 * * * *");
    expect(!bad.ok && bad.error).toMatch(/dakika/i);
    const range = parseCron("0 0 * * 5-1");
    expect(!range.ok && range.error).toMatch(/aralığı/);
  });
});

describe("describeCron (Turkish)", () => {
  it.each([
    ["45 8 * * 1-5", "Hafta içi her gün 08:45"],
    ["0 9 * * *", "Her gün 09:00"],
    ["0 * * * *", "Her saat başı"],
    ["15 * * * *", "Her saatin 15. dakikasında"],
    ["*/15 * * * *", "Her 15 dakikada bir"],
    ["0 10 * * 1", "Her pazartesi 10:00"],
    ["30 9 * * 1,3,5", "Pazartesi, çarşamba ve cuma 09:30"],
    ["0 10 * * 0,6", "Hafta sonu her gün 10:00"],
    ["0 9 1 * *", "Her ayın 1. günü 09:00"],
    ["0 9,13,17 * * 1-5", "Hafta içi her gün 09:00, 13:00 ve 17:00"],
    ["*/30 9-17 * * 1-5", "Hafta içi her gün 09:00–17:59 arası her 30 dakikada bir"],
    ["0 0 1 1 *", "Her yıl 1 Ocak 00:00"],
    ["0 9 * 6-8 1-5", "Haziran, temmuz ve ağustos aylarında hafta içi her gün 09:00"],
    ["@hourly", "Her saat başı"],
  ])("%s → %s", (expr, text) => {
    expect(describeCron(expr)).toBe(text);
  });

  it("returns null for invalid expressions", () => {
    expect(describeCron("nope")).toBeNull();
  });

  it("joins lists the Turkish way", () => {
    expect(joinTr(["a"])).toBe("a");
    expect(joinTr(["a", "b"])).toBe("a ve b");
    expect(joinTr(["a", "b", "c"])).toBe("a, b ve c");
  });
});

describe("nextRuns", () => {
  // Saturday 3 Oct 2026, 11:00 in Istanbul (UTC+3, no DST).
  const now = new Date("2026-10-03T08:00:00Z");

  it("lists weekday runs in the schedule's timezone", () => {
    const runs = nextRuns("45 8 * * 1-5", "Europe/Istanbul", now, 5).map((d) => d.toISOString());
    expect(runs).toEqual(["2026-10-05T05:45:00.000Z", "2026-10-06T05:45:00.000Z", "2026-10-07T05:45:00.000Z", "2026-10-08T05:45:00.000Z", "2026-10-09T05:45:00.000Z"]);
  });

  it("is strictly after the reference time", () => {
    const at = new Date("2026-10-03T08:00:00Z"); // exactly 11:00 Istanbul
    expect(nextRuns("0 11 * * *", "Europe/Istanbul", at, 1)[0]!.toISOString()).toBe("2026-10-04T08:00:00.000Z");
  });

  it("ORs day-of-month and day-of-week when both are restricted (croniter)", () => {
    const runs = nextRuns("0 12 15 * 1", "UTC", now, 3).map((d) => d.toISOString().slice(0, 10));
    expect(runs).toEqual(["2026-10-05", "2026-10-12", "2026-10-15"]);
  });

  it("skips times that don't exist in a DST gap", () => {
    // 8 Mar 2026: New York jumps from 02:00 to 03:00.
    const runs = nextRuns("30 2 * * *", "America/New_York", new Date("2026-03-07T12:00:00Z"), 2).map((d) => d.toISOString());
    expect(runs).toEqual(["2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
    expect(zonedToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, "America/New_York")).toBeNull();
  });

  it("finds rare dates (29 Feb)", () => {
    expect(nextRuns("0 0 29 2 *", "UTC", now, 1)[0]!.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  it("returns nothing for invalid input", () => {
    expect(nextRuns("bad", "UTC", now)).toEqual([]);
    expect(nextRuns("* * * * *", "Not/AZone", now)).toEqual([]);
  });
});

describe("cron builder", () => {
  it("round-trips presets", () => {
    for (const expr of ["45 8 * * 1-5", "0 9 * * *", "15 * * * *", "*/15 * * * *", "0 16 * * 5", "30 9 * * 1,3,5", "0 9 1 * *"]) {
      expect(builderToCron(cronToBuilder(expr))).toBe(expr);
    }
  });

  it("recognises presets and falls back to custom", () => {
    expect(cronToBuilder("45 8 * * 1-5")).toEqual({ kind: "weekdays", hour: 8, minute: 45 });
    expect(cronToBuilder("0 16 * * 5,7")).toEqual({ kind: "weekly", days: [0, 5], hour: 16, minute: 0 });
    expect(cronToBuilder("*/10 * * * *")).toEqual({ kind: "custom", expr: "*/10 * * * *" });
  });

  it("keeps the time when switching presets", () => {
    const daily = { kind: "daily" as const, hour: 7, minute: 30 };
    expect(switchBuilder(daily, "weekly")).toEqual({ kind: "weekly", days: [1], hour: 7, minute: 30 });
    expect(switchBuilder(daily, "custom")).toEqual({ kind: "custom", expr: "30 7 * * *" });
    expect(switchBuilder(daily, "hourly")).toEqual({ kind: "hourly", every: 60, minute: 0 });
  });
});
