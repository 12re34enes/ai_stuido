/** Day grouping for the task list ("Bugün", "Dün", "Pazartesi", "2 Ekim Perşembe"…), local time. */
import { taskStrings as s } from "./strings";
import type { Task } from "./types";

export type ListItem =
  | { type: "day"; key: string; label: string; count: number }
  | { type: "task"; key: string; task: Task };

const weekdayFmt = new Intl.DateTimeFormat("tr-TR", { weekday: "long" });
const dayMonthFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long" });
const fullFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" });

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of a timestamp in local time. */
export function dayKey(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Human label for a local day key relative to `now`. */
export function dayLabel(key: string, now: Date = new Date()): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const diffDays = Math.round((startOfDay(now) - date.getTime()) / 86_400_000);
  if (diffDays === 0) return s.days.today;
  if (diffDays === 1) return s.days.yesterday;
  if (diffDays > 1 && diffDays < 7) return capitalize(weekdayFmt.format(date));
  if (date.getFullYear() === now.getFullYear()) return `${dayMonthFmt.format(date)} ${capitalize(weekdayFmt.format(date))}`;
  return fullFmt.format(date);
}

function capitalize(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase("tr-TR") + text.slice(1) : text;
}

/** Flatten tasks (already sorted newest first) into day headers and rows. */
export function groupByDay(tasks: Task[], now: Date = new Date()): ListItem[] {
  const items: ListItem[] = [];
  let header: Extract<ListItem, { type: "day" }> | null = null;
  for (const task of tasks) {
    const key = dayKey(task.created_at);
    if (!header || header.key !== key) {
      header = { type: "day", key, label: dayLabel(key, now), count: 0 };
      items.push(header);
    }
    header.count += 1;
    items.push({ type: "task", key: task.id, task });
  }
  return items;
}
