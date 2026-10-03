/** Replay transport constants and time labels. */
export const SPEEDS = [1, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number];

/** "m:ss" / "h:mm:ss" of a real elapsed duration. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Default speed so a replay takes about a minute and a half at most. */
export function defaultSpeed(duration: number): Speed {
  return SPEEDS.find((x) => duration / x <= 90_000) ?? 8;
}
