import { formatDuration } from "@/i18n/format";
import type { LimitWindow, Provider } from "@/lib/types";

/** Limit bars change color at 70% and 90% (spec §17). */
export const LIMIT_WARN_AT = 70;
export const LIMIT_CRITICAL_AT = 90;

export type LimitTone = "ok" | "warning" | "critical";

export function clampPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.min(100, Math.max(0, p));
}

export function limitTone(percent: number, status?: "ok" | "warning" | "exhausted"): LimitTone {
  const p = clampPercent(percent);
  if (status === "exhausted" || p >= LIMIT_CRITICAL_AT) return "critical";
  if (status === "warning" || p >= LIMIT_WARN_AT) return "warning";
  return "ok";
}

/** "2 sa 14 dk" until reset, "az sonra" when due, null when unknown. */
export function resetCountdown(resetsAt: string | null | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const t = new Date(resetsAt).getTime();
  if (Number.isNaN(t)) return null;
  const diff = t - now;
  if (diff <= 0) return "az sonra";
  return formatDuration(diff);
}

/** Ordering for windows of one provider: 5h first, weekly next, the rest by label. */
export function windowRank(window: string): number {
  if (window === "five_hour" || window === "primary") return 0;
  if (window === "seven_day" || window === "secondary") return 1;
  return 2;
}

const PROVIDER_ORDER: Provider[] = ["claude", "codex"];

/** Group windows per provider (Claude first), each sorted 5h → weekly → others. */
export function groupLimits(windows: LimitWindow[]): { provider: Provider; windows: LimitWindow[] }[] {
  return PROVIDER_ORDER.map((provider) => ({
    provider,
    windows: windows
      .filter((w) => w.provider === provider)
      .sort((a, b) => windowRank(a.window) - windowRank(b.window) || a.label.localeCompare(b.label, "tr")),
  })).filter((g) => g.windows.length > 0);
}
