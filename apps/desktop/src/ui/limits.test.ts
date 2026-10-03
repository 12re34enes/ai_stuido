import type { LimitWindow } from "@/lib/types";

import { clampPercent, groupLimits, limitTone, resetCountdown } from "./limits";

describe("limitTone", () => {
  it("changes at 70% and 90%", () => {
    expect(limitTone(0)).toBe("ok");
    expect(limitTone(69.9)).toBe("ok");
    expect(limitTone(70)).toBe("warning");
    expect(limitTone(89.9)).toBe("warning");
    expect(limitTone(90)).toBe("critical");
    expect(limitTone(100)).toBe("critical");
  });

  it("respects backend status", () => {
    expect(limitTone(10, "exhausted")).toBe("critical");
    expect(limitTone(10, "warning")).toBe("warning");
    expect(limitTone(95, "ok")).toBe("critical");
  });
});

describe("clampPercent", () => {
  it("clamps and sanitizes", () => {
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});

describe("resetCountdown", () => {
  const now = new Date("2026-10-03T08:00:00Z").getTime();
  it("formats the remaining time in Turkish", () => {
    expect(resetCountdown("2026-10-03T10:14:00Z", now)).toBe("2 sa 14 dk");
    expect(resetCountdown("2026-10-05T12:00:00Z", now)).toBe("2 g 4 sa");
  });
  it("handles due and unknown resets", () => {
    expect(resetCountdown("2026-10-03T07:00:00Z", now)).toBe("az sonra");
    expect(resetCountdown(null, now)).toBeNull();
    expect(resetCountdown("not a date", now)).toBeNull();
  });
});

describe("groupLimits", () => {
  const w = (provider: "claude" | "codex", window: string, label: string): LimitWindow => ({
    provider,
    window,
    label,
    used_percent: 10,
    resets_at: null,
    status: "ok",
    source: "event",
    observed_at: "2026-10-03T08:00:00Z",
  });
  it("puts Claude first and orders 5h → weekly → others", () => {
    const groups = groupLimits([
      w("codex", "secondary", "Haftalık"),
      w("claude", "seven_day_opus", "Haftalık (Opus)"),
      w("claude", "seven_day", "Haftalık"),
      w("codex", "primary", "5 saat"),
      w("claude", "five_hour", "5 saat"),
    ]);
    expect(groups.map((g) => g.provider)).toEqual(["claude", "codex"]);
    expect(groups[0]!.windows.map((x) => x.window)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
    expect(groups[1]!.windows.map((x) => x.window)).toEqual(["primary", "secondary"]);
  });
  it("drops providers without windows", () => {
    expect(groupLimits([w("codex", "primary", "5 saat")]).map((g) => g.provider)).toEqual(["codex"]);
  });
});
