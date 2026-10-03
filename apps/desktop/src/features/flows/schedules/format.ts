/** Run-time formatting in a schedule's own timezone (Turkish). */
const dayFmt = new Map<string, Intl.DateTimeFormat>();
const timeFmt = new Map<string, Intl.DateTimeFormat>();

function fmt(cache: Map<string, Intl.DateTimeFormat>, tz: string, opts: Intl.DateTimeFormatOptions) {
  let f = cache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("tr-TR", { ...opts, timeZone: tz });
    } catch {
      f = new Intl.DateTimeFormat("tr-TR", opts);
    }
    cache.set(tz, f);
  }
  return f;
}

export function formatRunDay(d: Date, tz: string) {
  return fmt(dayFmt, tz, { weekday: "short", day: "numeric", month: "short" }).format(d);
}

const rtf = new Intl.RelativeTimeFormat("tr-TR", { numeric: "auto" });

/** "1 saat sonra", "yarın", "12 gün sonra" — always relative (never a repeated date). */
export function relativeRun(d: Date, now: Date): string {
  const ms = d.getTime() - now.getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return rtf.format(Math.max(1, minutes), "minute");
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return rtf.format(hours, "hour");
  const days = Math.round(ms / 86_400_000);
  if (days < 60) return rtf.format(days, "day");
  return rtf.format(Math.round(days / 30), "month");
}

export function formatRunTime(d: Date, tz: string) {
  return fmt(timeFmt, tz, { hour: "2-digit", minute: "2-digit" }).format(d);
}
