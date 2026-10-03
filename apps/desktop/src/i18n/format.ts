/** Turkish formatting helpers. All user-visible numbers/dates go through these. */

const LOCALE = "tr-TR";

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto", style: "short" });
const numberFmt = new Intl.NumberFormat(LOCALE);
const compactFmt = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" });
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });

export function relativeTime(input: string | number | Date, now: Date = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return "az önce";
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), "day");
  return dateTimeFmt.format(d);
}

/** "2 sa 14 dk" style countdown / duration. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSec = Math.round(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${d} g ${h} sa`;
  if (h > 0) return `${h} sa ${m} dk`;
  if (m > 0) return `${m} dk${s && m < 10 ? ` ${s} sn` : ""}`;
  return `${s} sn`;
}

export function formatNumber(n: number): string {
  return numberFmt.format(n);
}

export function formatCompact(n: number): string {
  return compactFmt.format(n);
}

export function formatPercent(p: number, digits = 0): string {
  return `%${p.toFixed(digits).replace(".", ",")}`;
}

export function formatDateTime(input: string | number | Date): string {
  return dateTimeFmt.format(input instanceof Date ? input : new Date(input));
}

export function formatTime(input: string | number | Date): string {
  return timeFmt.format(input instanceof Date ? input : new Date(input));
}
