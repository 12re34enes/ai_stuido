/**
 * Cron helpers for the schedules page: a 5-field parser with croniter semantics (day-of-month and
 * day-of-week are OR-ed when both are restricted), human-readable Turkish descriptions
 * ("Hafta içi her gün 08:45"), timezone-aware next run times, and the friendly builder presets.
 */

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  /** Field was "*" (or an unrestricted step), which matters for the dom/dow OR rule. */
  dayStar: boolean;
  weekdayStar: boolean;
  /** Original fields after alias expansion. */
  fields: [string, string, string, string, string];
}

export type CronResult = { ok: true; cron: ParsedCron } | { ok: false; error: string };

const ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  /** Index offset of names[0] (months start at 1). */
  nameBase?: number;
  label: string;
}

const SPECS: FieldSpec[] = [
  { min: 0, max: 59, label: "dakika" },
  { min: 0, max: 23, label: "saat" },
  { min: 1, max: 31, label: "ayın günü" },
  { min: 1, max: 12, names: MONTH_NAMES, nameBase: 1, label: "ay" },
  { min: 0, max: 7, names: DAY_NAMES, nameBase: 0, label: "haftanın günü" },
];

function parseValue(raw: string, spec: FieldSpec): number | null {
  const lower = raw.toLowerCase();
  if (spec.names) {
    const i = spec.names.indexOf(lower);
    if (i >= 0) return i + (spec.nameBase ?? 0);
  }
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= spec.min && n <= spec.max ? n : null;
}

function parseField(field: string, spec: FieldSpec): { values: number[]; star: boolean } | string {
  const out = new Set<number>();
  let star = false;
  for (const part of field.split(",")) {
    if (!part) return `${spec.label} alanında boş değer var`;
    const [range, stepRaw, extra] = part.split("/");
    if (extra !== undefined) return `${spec.label} alanı çözülemedi: ${part}`;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw) || Number(stepRaw) < 1) return `${spec.label} alanında adım geçersiz: ${part}`;
      step = Number(stepRaw);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = spec.min;
      hi = spec.max;
      if (step === 1) star = true;
    } else if (range!.includes("-")) {
      const [a, b] = range!.split("-");
      const va = parseValue(a ?? "", spec);
      const vb = parseValue(b ?? "", spec);
      if (va === null || vb === null || va > vb) return `${spec.label} aralığı geçersiz: ${part}`;
      lo = va;
      hi = vb;
    } else {
      const v = parseValue(range ?? "", spec);
      if (v === null) return `${spec.label} değeri geçersiz: ${part}`;
      lo = v;
      hi = stepRaw !== undefined ? spec.max : v; // "5/15" = from 5 to max every 15
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return { values: [...out].sort((a, b) => a - b), star };
}

export function parseCron(expr: string): CronResult {
  const text = (ALIASES[expr.trim().toLowerCase()] ?? expr).trim().replace(/\s+/g, " ");
  if (!text) return { ok: false, error: "Cron ifadesi boş." };
  const fields = text.split(" ");
  if (fields.length !== 5) return { ok: false, error: "Beş alan bekleniyor: dakika saat gün ay haftanın-günü." };
  const parsed: { values: number[]; star: boolean }[] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(fields[i]!, SPECS[i]!);
    if (typeof r === "string") return { ok: false, error: r.charAt(0).toLocaleUpperCase("tr-TR") + r.slice(1) + "." };
    parsed.push(r);
  }
  const weekdays = [...new Set(parsed[4]!.values.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    ok: true,
    cron: {
      minutes: parsed[0]!.values,
      hours: parsed[1]!.values,
      days: parsed[2]!.values,
      months: parsed[3]!.values,
      weekdays,
      dayStar: parsed[2]!.star,
      weekdayStar: parsed[4]!.star,
      fields: fields as ParsedCron["fields"],
    },
  };
}

// ----------------------------------------------------------------------------- timezones

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    partFormatters.set(tz, f);
  }
  return f;
}

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function wallTime(ts: number, tz: string): WallTime {
  const parts = partsFormatter(tz).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

function offsetMs(ts: number, tz: string): number {
  const w = wallTime(ts, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(ts / 60_000) * 60_000;
}

/** The instant a wall-clock time happens in `tz`; null when it doesn't exist (DST gap). */
export function zonedToInstant(w: WallTime, tz: string): number | null {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  let t = guess - offsetMs(guess, tz);
  const second = offsetMs(t, tz);
  if (guess - second !== t) t = guess - second;
  const check = wallTime(t, tz);
  if (check.year !== w.year || check.month !== w.month || check.day !== w.day || check.hour !== w.hour || check.minute !== w.minute) return null;
  return t;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    partsFormatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ----------------------------------------------------------------------------- next runs

function dayMatches(c: ParsedCron, day: number, weekday: number): boolean {
  const dom = c.days.includes(day);
  const dow = c.weekdays.includes(weekday);
  if (c.dayStar && c.weekdayStar) return true;
  if (c.dayStar) return dow;
  if (c.weekdayStar) return dom;
  return dom || dow;
}

/** The next `count` fire times strictly after `after`, evaluated in `tz` (like croniter). */
export function nextRuns(expr: string | ParsedCron, tz: string, after: Date, count = 5): Date[] {
  const parsed = typeof expr === "string" ? parseCron(expr) : ({ ok: true, cron: expr } as const);
  if (!parsed.ok || !isValidTimeZone(tz)) return [];
  const c = parsed.cron;
  const afterTs = after.getTime();
  const start = wallTime(afterTs, tz);
  const out: Date[] = [];
  let cursor = Date.UTC(start.year, start.month - 1, start.day);
  // Search up to ~5 years ahead (covers "29 Feb" style schedules).
  for (let i = 0; i < 366 * 5 && out.length < count; i++, cursor += 86_400_000) {
    const d = new Date(cursor);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    if (!c.months.includes(month) || !dayMatches(c, day, d.getUTCDay())) continue;
    for (const hour of c.hours) {
      for (const minute of c.minutes) {
        const t = zonedToInstant({ year, month, day, hour, minute }, tz);
        if (t === null || t <= afterTs) continue;
        out.push(new Date(t));
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------------------- description

const TR_DAYS = ["pazar", "pazartesi", "salı", "çarşamba", "perşembe", "cuma", "cumartesi"];
const TR_MONTHS = ["ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık"];

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

function capitalize(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase("tr-TR") + text.slice(1) : text;
}

/** "a, b ve c" */
export function joinTr(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} ve ${items[items.length - 1]}`;
}

function arithmeticStep(values: number[], min: number, max: number): number | null {
  if (values.length < 2 || values[0] !== min) return null;
  const step = values[1]! - values[0]!;
  for (let i = 1; i < values.length; i++) if (values[i]! - values[i - 1]! !== step) return null;
  return values[values.length - 1]! + step > max ? step : null;
}

function isRange(values: number[]): boolean {
  return values.length > 2 && values.every((v, i) => i === 0 || v === values[i - 1]! + 1);
}

function dayPart(c: ParsedCron): string {
  const wd = c.weekdays;
  let base: string;
  if (c.dayStar && c.weekdayStar) base = "her gün";
  else if (c.dayStar) {
    if (wd.join() === "1,2,3,4,5") base = "hafta içi her gün";
    else if (wd.join() === "0,6") base = "hafta sonu her gün";
    else if (wd.length === 1) base = `her ${TR_DAYS[wd[0]!]}`;
    else base = joinTr(wd.map((d) => TR_DAYS[d]!));
  } else if (c.weekdayStar) {
    base = c.days.length === 1 ? `her ayın ${c.days[0]}. günü` : `her ayın ${joinTr(c.days.map(String))}. günleri`;
  } else {
    base = `her ayın ${joinTr(c.days.map(String))}. günü ya da ${joinTr(c.weekdays.map((d) => TR_DAYS[d]!))}`;
  }
  if (c.months.length === 1 && c.weekdayStar && c.days.length === 1 && !c.dayStar) {
    return `her yıl ${c.days[0]} ${capitalize(TR_MONTHS[c.months[0]! - 1]!)}`;
  }
  if (c.months.length < 12) {
    const months = joinTr(c.months.map((m) => TR_MONTHS[m - 1]!));
    base = `${months} aylarında ${base}`;
  }
  return base;
}

function timePart(c: ParsedCron): string {
  const { minutes, hours } = c;
  const allHours = hours.length === 24;
  const minuteStep = arithmeticStep(minutes, 0, 59);
  if (minutes.length === 60 && allHours) return "her dakika";
  if (minuteStep && allHours) return `her ${minuteStep} dakikada bir`;
  if (minutes.length === 1 && allHours) return minutes[0] === 0 ? "her saat başı" : `her saatin ${minutes[0]}. dakikasında`;
  const hourStep = arithmeticStep(hours, 0, 23);
  if (minutes.length === 1 && hourStep) return `${hourStep} saatte bir, dakika ${pad(minutes[0]!)}`;
  if (minutes.length === 1 && hours.length <= 6) return joinTr(hours.map((h) => hm(h, minutes[0]!)));
  if (minuteStep && isRange(hours)) return `${hm(hours[0]!, 0)}–${hm(hours[hours.length - 1]!, 59)} arası her ${minuteStep} dakikada bir`;
  if (minutes.length === 1 && isRange(hours)) return `${hm(hours[0]!, minutes[0]!)}–${hm(hours[hours.length - 1]!, minutes[0]!)} arası saatte bir`;
  if (minutes.length * hours.length <= 4) return joinTr(hours.flatMap((h) => minutes.map((m) => hm(h, m))));
  return `belirli saatlerde (${c.fields[0]} ${c.fields[1]})`;
}

/** Human-readable Turkish description, e.g. "Hafta içi her gün 08:45". */
export function describeCron(expr: string): string | null {
  const parsed = parseCron(expr);
  if (!parsed.ok) return null;
  const c = parsed.cron;
  const days = dayPart(c);
  const time = timePart(c);
  if (days === "her gün" && time.startsWith("her ")) return capitalize(time);
  return capitalize(`${days} ${time}`);
}

// ----------------------------------------------------------------------------- builder presets

export type CronBuilder =
  | { kind: "hourly"; every: 60 | 30 | 15 | 5; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; days: number[]; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "custom"; expr: string };

export type CronBuilderKind = CronBuilder["kind"];

export function builderToCron(b: CronBuilder): string {
  switch (b.kind) {
    case "hourly":
      return b.every === 60 ? `${b.minute} * * * *` : `*/${b.every} * * * *`;
    case "daily":
      return `${b.minute} ${b.hour} * * *`;
    case "weekdays":
      return `${b.minute} ${b.hour} * * 1-5`;
    case "weekly":
      return `${b.minute} ${b.hour} * * ${[...b.days].sort((x, y) => x - y).join(",") || "1"}`;
    case "monthly":
      return `${b.minute} ${b.hour} ${b.day} * *`;
    case "custom":
      return b.expr.trim();
  }
}

/** Recognise a cron string as one of the friendly presets (otherwise "custom"). */
export function cronToBuilder(expr: string): CronBuilder {
  const t = expr.trim().replace(/\s+/g, " ");
  let m: RegExpExecArray | null;
  const num = (s: string | undefined) => Number(s);
  if ((m = /^(\d{1,2}) \* \* \* \*$/.exec(t)) && num(m[1]) < 60) return { kind: "hourly", every: 60, minute: num(m[1]) };
  if ((m = /^\*\/(5|15|30) \* \* \* \*$/.exec(t))) return { kind: "hourly", every: num(m[1]) as 5 | 15 | 30, minute: 0 };
  const time = (mm: string | undefined, hh: string | undefined) => num(mm) < 60 && num(hh) < 24;
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(t)) && time(m[1], m[2])) return { kind: "daily", hour: num(m[2]), minute: num(m[1]) };
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* (?:1-5|mon-fri)$/i.exec(t)) && time(m[1], m[2])) return { kind: "weekdays", hour: num(m[2]), minute: num(m[1]) };
  if ((m = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](?:,[0-7])*)$/.exec(t)) && time(m[1], m[2])) {
    const days = [...new Set(m[3]!.split(",").map((d) => (Number(d) === 7 ? 0 : Number(d))))].sort((a, b) => a - b);
    return { kind: "weekly", days, hour: num(m[2]), minute: num(m[1]) };
  }
  if ((m = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(t)) && time(m[1], m[2]) && num(m[3]) >= 1 && num(m[3]) <= 31) {
    return { kind: "monthly", day: num(m[3]), hour: num(m[2]), minute: num(m[1]) };
  }
  return { kind: "custom", expr: t };
}

/** Switch preset while keeping the chosen time where it makes sense. */
export function switchBuilder(current: CronBuilder, kind: CronBuilderKind): CronBuilder {
  const hour = "hour" in current ? current.hour : 9;
  const minute = "minute" in current && current.kind !== "hourly" ? current.minute : 0;
  switch (kind) {
    case "hourly":
      return { kind, every: 60, minute: 0 };
    case "daily":
      return { kind, hour, minute };
    case "weekdays":
      return { kind, hour, minute };
    case "weekly":
      return { kind, days: current.kind === "weekly" ? current.days : [1], hour, minute };
    case "monthly":
      return { kind, day: current.kind === "monthly" ? current.day : 1, hour, minute };
    case "custom":
      return { kind, expr: builderToCron(current) };
  }
}

export const WEEKDAY_SHORT = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
export const WEEKDAY_LONG = TR_DAYS.map(capitalize);
/** Monday-first order for the weekday picker. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Curated timezone list for the picker (plus the current/local one when missing). */
export const COMMON_TIMEZONES = [
  "Europe/Istanbul",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Asia/Dubai",
  "Asia/Tokyo",
  "Australia/Sydney",
];
