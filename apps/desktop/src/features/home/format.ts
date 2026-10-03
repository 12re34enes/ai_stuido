/** Small formatting helpers for the home screen. */
import { formatDuration } from "@/i18n/format";

/** Minutes-precision elapsed label ("3 dk", "1 sa 12 dk"). */
export function elapsedLabel(ms: number): string {
  return formatDuration(Math.max(60_000, Math.floor(ms / 60_000) * 60_000));
}
