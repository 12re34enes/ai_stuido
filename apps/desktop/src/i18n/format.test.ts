import { formatDuration, formatPercent, relativeTime } from "./format";

describe("format", () => {
  it("formats durations in Turkish", () => {
    expect(formatDuration(45_000)).toBe("45 sn");
    expect(formatDuration(3 * 60_000 + 5_000)).toBe("3 dk 5 sn");
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe("2 sa 14 dk");
  });

  it("formats percents with Turkish prefix and comma", () => {
    expect(formatPercent(42)).toBe("%42");
    expect(formatPercent(12.5, 1)).toBe("%12,5");
  });

  it("formats relative time", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(relativeTime(new Date("2026-10-03T11:59:50Z"), now)).toBe("az önce");
    expect(relativeTime(new Date("2026-10-03T11:48:00Z"), now)).toMatch(/12 dk/);
  });
});
