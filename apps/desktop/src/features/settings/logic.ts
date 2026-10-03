/**
 * Pure helpers for the settings pages: quiet hours, the global-shortcut recorder, alert channel
 * field metadata + validation (mirrors backend `alerts/channels/__init__.py::validate_channel`),
 * budgets, backup schedules and live-event routing. Unit-tested in logic.test.ts.
 */
import type { StudioEvent } from "@/lib/events";
import type { Provider, Severity } from "@/lib/types";

import type { Budget, Channel, ChannelKind, ChannelKindSpec, QuietHours } from "./types";

export type FieldErrors<K extends string = string> = Partial<Record<K, string>>;

export function hasErrors(e: FieldErrors): boolean {
  return Object.values(e).some(Boolean);
}

// ----------------------------------------------------------------------------- quiet hours

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "23:30" → minutes after midnight; null when not HH:MM. */
export function parseTime(value: string): number | null {
  const m = HHMM.exec(value.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Length of a start→end window in minutes; crossing midnight wraps (23:00→08:00 = 540). */
export function windowMinutes(start: string, end: string): number | null {
  const a = parseTime(start);
  const b = parseTime(end);
  if (a === null || b === null) return null;
  const d = (b - a + 1440) % 1440;
  return d === 0 ? 1440 : d;
}

export const DAY_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"] as const;
const DAY_LONG = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"] as const;

/** "Her gün", "Hafta içi", "Hafta sonu" or a list ("Pzt, Çar, Cum"). */
export function formatDays(days: number[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return "Her gün";
  const set = [...new Set(days)].sort((a, b) => a - b);
  if (set.join() === "0,1,2,3,4") return "Hafta içi";
  if (set.join() === "5,6") return "Hafta sonu";
  if (set.length === 1) return `Her ${DAY_LONG[set[0] ?? 0]}`;
  return set.map((d) => DAY_SHORT[d]).join(", ");
}

function formatSpan(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} sa ${m} dk`;
  return h ? `${h} sa` : `${m} dk`;
}

/** "Hafta içi 23:00 – 08:00 (9 sa)" or "Kapalı". */
export function describeQuietHours(q: QuietHours): string {
  if (!q.enabled) return "Kapalı";
  const span = windowMinutes(q.start, q.end);
  return `${formatDays(q.days)} ${q.start} – ${q.end}${span !== null ? ` (${formatSpan(span)})` : ""}`;
}

export function validateQuietHours(q: QuietHours): FieldErrors<"start" | "end" | "days"> {
  const e: FieldErrors<"start" | "end" | "days"> = {};
  if (parseTime(q.start) === null) e.start = "SS:DD biçiminde girin (ör. 23:00).";
  if (parseTime(q.end) === null) e.end = "SS:DD biçiminde girin (ör. 08:00).";
  if (!e.start && !e.end && q.start === q.end) e.end = "Başlangıç ve bitiş aynı olamaz.";
  if (q.days && q.days.length === 0) e.days = "En az bir gün seçin.";
  return e;
}

/** Wall-clock weekday (0 = Monday) and minutes in `timeZone` (local when null). */
export function zonedClock(date: Date, timeZone: string | null): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? undefined, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { weekday: Math.max(0, weekday), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

/** Is `date` inside the quiet window? `days` are the days the window *starts* (backend semantics). */
export function isQuietAt(q: QuietHours, date: Date): boolean {
  if (!q.enabled) return false;
  const start = parseTime(q.start);
  const end = parseTime(q.end);
  if (start === null || end === null || start === end) return false;
  const { weekday, minutes } = zonedClock(date, q.timezone);
  const startsOn = (d: number) => !q.days || q.days.length === 0 || q.days.includes(d);
  if (start < end) return minutes >= start && minutes < end && startsOn(weekday);
  // Crosses midnight: evening part belongs to today, morning part to yesterday's window.
  if (minutes >= start) return startsOn(weekday);
  if (minutes < end) return startsOn((weekday + 6) % 7);
  return false;
}

// ----------------------------------------------------------------------------- shortcut recorder

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_CODES = new Set(["MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "CapsLock", "Fn", "OSLeft", "OSRight"]);

const NAMED_CODES: Record<string, { acc: string; label: string }> = {
  Space: { acc: "Space", label: "Space" },
  Enter: { acc: "Enter", label: "↵" },
  Tab: { acc: "Tab", label: "⇥" },
  Backspace: { acc: "Backspace", label: "⌫" },
  Delete: { acc: "Delete", label: "⌦" },
  ArrowUp: { acc: "Up", label: "↑" },
  ArrowDown: { acc: "Down", label: "↓" },
  ArrowLeft: { acc: "Left", label: "←" },
  ArrowRight: { acc: "Right", label: "→" },
  Home: { acc: "Home", label: "↖" },
  End: { acc: "End", label: "↘" },
  PageUp: { acc: "PageUp", label: "⇞" },
  PageDown: { acc: "PageDown", label: "⇟" },
  Comma: { acc: "Comma", label: "," },
  Period: { acc: "Period", label: "." },
  Slash: { acc: "Slash", label: "/" },
  Semicolon: { acc: "Semicolon", label: ";" },
  Quote: { acc: "Quote", label: "'" },
  BracketLeft: { acc: "BracketLeft", label: "[" },
  BracketRight: { acc: "BracketRight", label: "]" },
  Backslash: { acc: "Backslash", label: "\\" },
  Minus: { acc: "Minus", label: "-" },
  Equal: { acc: "Equal", label: "=" },
  Backquote: { acc: "Backquote", label: "`" },
};

function keyPart(code: string): { acc: string; label: string } | null {
  if (/^Key[A-Z]$/.test(code)) return { acc: code.slice(3), label: code.slice(3) };
  if (/^Digit\d$/.test(code)) return { acc: code.slice(5), label: code.slice(5) };
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return { acc: code, label: code };
  return NAMED_CODES[code] ?? null;
}

export type RecordResult = { kind: "pending" } | { kind: "cancel" } | { kind: "error"; message: string } | { kind: "ok"; accelerator: string; label: string };

/**
 * Turn a keydown into a Tauri accelerator ("Control+Alt+Space") and its macOS label ("⌃⌥Space").
 * Modifier-only presses are "pending"; Esc alone cancels; at least ⌘, ⌃ or ⌥ is required.
 */
export function recordShortcut(e: KeyLike): RecordResult {
  if (MODIFIER_CODES.has(e.code)) return { kind: "pending" };
  if (e.code === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return { kind: "cancel" };
  const key = keyPart(e.code);
  if (!key) return { kind: "error", message: "Bu tuş genel kısayol olarak kullanılamaz." };
  if (!e.metaKey && !e.ctrlKey && !e.altKey) return { kind: "error", message: "En az bir değiştirici tuş gerekli: ⌘, ⌃ veya ⌥." };
  const mods: { acc: string; label: string; on: boolean }[] = [
    { acc: "Control", label: "⌃", on: e.ctrlKey },
    { acc: "Alt", label: "⌥", on: e.altKey },
    { acc: "Shift", label: "⇧", on: e.shiftKey },
    { acc: "Command", label: "⌘", on: e.metaKey },
  ];
  const on = mods.filter((m) => m.on);
  return { kind: "ok", accelerator: [...on.map((m) => m.acc), key.acc].join("+"), label: `${on.map((m) => m.label).join("")}${key.label}` };
}

const ACC_MOD_LABEL: Record<string, string> = {
  control: "⌃",
  ctrl: "⌃",
  alt: "⌥",
  option: "⌥",
  shift: "⇧",
  command: "⌘",
  cmd: "⌘",
  super: "⌘",
  meta: "⌘",
  commandorcontrol: "⌘",
  cmdorctrl: "⌘",
};
const ACC_ORDER = ["⌃", "⌥", "⇧", "⌘"];

/** "Control+Alt+Space" → "⌃⌥Space" (modifiers in macOS order). */
export function acceleratorLabel(accelerator: string): string {
  const parts = accelerator.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const m = ACC_MOD_LABEL[p.toLowerCase()];
    if (m) mods.push(m);
    else key = p;
  }
  const named = Object.values(NAMED_CODES).find((n) => n.acc.toLowerCase() === key.toLowerCase());
  mods.sort((a, b) => ACC_ORDER.indexOf(a) - ACC_ORDER.indexOf(b));
  return `${mods.join("")}${named ? named.label : key.length === 1 ? key.toUpperCase() : key}`;
}

// ----------------------------------------------------------------------------- alert channels

export type ChannelFieldType = "text" | "number" | "select" | "list" | "secret";

export interface ChannelFieldMeta {
  label: string;
  type: ChannelFieldType;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  mono?: boolean;
}

/** Turkish labels and input types for known config / secret fields. Unknown fields get a generic text input. */
export const CHANNEL_FIELDS: Record<string, ChannelFieldMeta> = {
  mode: {
    label: "Mod",
    type: "select",
    options: [
      { value: "webhook", label: "Gelen webhook (tek yönlü)" },
      { value: "bot", label: "Bot + Socket Mode (butonlu)" },
    ],
  },
  channel: { label: "Kanal kimliği", type: "text", placeholder: "C0123ABCD", mono: true },
  allowed_user_ids: { label: "Onay verebilecek kullanıcılar", type: "list", placeholder: "U0123ABCD", hint: "Virgülle ayırın. Boşsa yalnız bağlanmış kullanıcı.", mono: true },
  chat_id: { label: "Sohbet kimliği", type: "text", placeholder: "Bağlantı koduyla otomatik dolar", hint: "Bağlantı kodu akışıyla doldurmanız önerilir.", mono: true },
  linked_user_id: { label: "Bağlı kullanıcı kimliği", type: "text", placeholder: "Bağlantı koduyla otomatik dolar", mono: true },
  username: { label: "Görünen ad", type: "text", placeholder: "AI Studio" },
  host: { label: "SMTP sunucusu", type: "text", placeholder: "smtp.ornek.com", mono: true },
  port: { label: "Port", type: "number", placeholder: "587" },
  security: {
    label: "Güvenlik",
    type: "select",
    options: [
      { value: "starttls", label: "STARTTLS" },
      { value: "tls", label: "TLS" },
      { value: "none", label: "Yok" },
    ],
  },
  from_addr: { label: "Gönderen", type: "text", placeholder: "ai-studio@ornek.com" },
  to_addrs: { label: "Alıcılar", type: "list", placeholder: "ben@ornek.com", hint: "Virgülle ayırın." },
  webhook_url: { label: "Webhook adresi", type: "secret", placeholder: "https://…", mono: true },
  bot_token: { label: "Bot belirteci", type: "secret", mono: true },
  app_token: { label: "Uygulama belirteci (Socket Mode)", type: "secret", mono: true },
  password: { label: "Parola", type: "secret" },
  topic_url: { label: "Konu adresi", type: "secret", placeholder: "https://ntfy.sh/gizli-konu", hint: "Konu adı tahmin edilemez olmalı; adres gizli bilgi olarak saklanır.", mono: true },
  token: { label: "Erişim belirteci (isteğe bağlı)", type: "secret", mono: true },
  url: { label: "Adres", type: "secret", placeholder: "https://…", mono: true },
  signing_secret: { label: "İmza anahtarı (HMAC, isteğe bağlı)", type: "secret", mono: true },
};

export function fieldMeta(kind: ChannelKind, field: string): ChannelFieldMeta {
  if (kind === "email" && field === "username") return { label: "SMTP kullanıcısı", type: "text", mono: true };
  return CHANNEL_FIELDS[field] ?? { label: field, type: "text" };
}

export type ChannelValues = Record<string, string>;

/** Which fields are shown for the current values (Slack's mode switches its field set). */
export function visibleFields(spec: Pick<ChannelKindSpec, "kind" | "config_fields" | "secret_fields">, values: ChannelValues): string[] {
  const all = [...spec.config_fields, ...spec.secret_fields];
  if (spec.kind !== "slack") return all;
  const mode = values.mode || "webhook";
  return all.filter((f) => (mode === "webhook" ? ["mode", "webhook_url"].includes(f) : f !== "webhook_url"));
}

function isHttps(v: string | undefined, allowHttp = false): boolean {
  return Boolean(v && (v.startsWith("https://") || (allowHttp && v.startsWith("http://"))) && v.length > 10);
}

/**
 * Validate a channel form. `stored` = secret fields that already have a value (editing), so a
 * required secret may be left empty to keep it.
 */
export function validateChannel(kind: ChannelKind, values: ChannelValues, stored: string[] = []): FieldErrors {
  const e: FieldErrors = {};
  const has = (f: string) => Boolean(values[f]?.trim()) || stored.includes(f);
  const v = (f: string) => values[f]?.trim() ?? "";
  if (kind === "slack") {
    const mode = v("mode") || "webhook";
    if (mode === "webhook") {
      if (v("webhook_url") ? !isHttps(v("webhook_url")) : !stored.includes("webhook_url")) e.webhook_url = "Slack webhook adresi https:// ile başlamalı.";
    } else {
      if (!has("bot_token")) e.bot_token = "Bot modu için bot belirteci gerekli.";
      if (!v("channel")) e.channel = "Bot modu için kanal kimliği gerekli (ör. C0123ABCD).";
    }
  } else if (kind === "telegram") {
    if (!has("bot_token")) e.bot_token = "Telegram için bot belirteci gerekli (BotFather'dan alınır).";
  } else if (kind === "discord" || kind === "teams") {
    if (v("webhook_url") ? !isHttps(v("webhook_url")) : !stored.includes("webhook_url")) e.webhook_url = "Webhook adresi https:// ile başlamalı.";
  } else if (kind === "email") {
    if (!v("host")) e.host = "SMTP sunucusu gerekli.";
    if (!v("from_addr")) e.from_addr = "Gönderen adresi gerekli.";
    const to = splitList(v("to_addrs"));
    if (to.length === 0 || to.some((t) => !t.includes("@"))) e.to_addrs = "En az bir geçerli alıcı e-posta adresi gerekli.";
    if (v("port") && !/^\d{1,5}$/.test(v("port"))) e.port = "Port bir sayı olmalı.";
  } else if (kind === "ntfy") {
    if (v("topic_url") ? !isHttps(v("topic_url"), true) : !stored.includes("topic_url")) e.topic_url = "ntfy konu adresi gerekli (ör. https://ntfy.sh/konu-adi).";
  } else if (kind === "webhook") {
    if (v("url") ? !isHttps(v("url"), true) : !stored.includes("url")) e.url = "Webhook adresi http:// veya https:// ile başlamalı.";
  }
  return e;
}

export function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Form values → API `config` and `secrets` (empty secrets are omitted: "keep"). */
export function channelPayload(spec: Pick<ChannelKindSpec, "kind" | "config_fields" | "secret_fields">, values: ChannelValues): { config: Record<string, unknown>; secrets: Record<string, string> } {
  const shown = new Set(visibleFields(spec, values));
  const config: Record<string, unknown> = {};
  for (const f of spec.config_fields) {
    if (!shown.has(f)) continue;
    const meta = fieldMeta(spec.kind, f);
    const raw = values[f]?.trim() ?? "";
    if (meta.type === "list") config[f] = splitList(raw);
    else if (meta.type === "number") config[f] = raw ? Number(raw) : null;
    else config[f] = raw || null;
  }
  if (spec.kind === "slack" && !config.mode) config.mode = "webhook";
  const secrets: Record<string, string> = {};
  for (const f of spec.secret_fields) {
    const raw = values[f]?.trim();
    if (shown.has(f) && raw) secrets[f] = raw;
  }
  return { config, secrets };
}

/** Initial form values from a stored channel (secrets are never known: empty = keep). */
export function channelValues(channel: Pick<Channel, "config"> | null): ChannelValues {
  const out: ChannelValues = {};
  for (const [k, v] of Object.entries(channel?.config ?? {})) {
    out[k] = Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v);
  }
  return out;
}

/** Whether the "link your account" code flow applies (two-way Telegram, Slack in bot mode). */
export function canLink(channel: Pick<Channel, "kind" | "config" | "two_way">): boolean {
  if (channel.kind === "telegram") return true;
  return channel.kind === "slack" && channel.config.mode === "bot";
}

// ----------------------------------------------------------------------------- alert rules

export const SEVERITY_LABEL: Record<Severity, string> = { info: "Bilgi", normal: "Normal", high: "Yüksek", critical: "Kritik" };
export const SEVERITY_TONE: Record<Severity, "neutral" | "info" | "warning" | "danger"> = { info: "neutral", normal: "info", high: "warning", critical: "danger" };

/** Event types users can route (backend alerts/catalog.py BUILDERS), grouped for the picker. */
export const EVENT_TYPE_GROUPS: { label: string; types: { value: string; label: string }[] }[] = [
  {
    label: "Onaylar",
    types: [{ value: "approval.requested", label: "Onay bekliyor" }],
  },
  {
    label: "Ajanlar",
    types: [
      { value: "agent.stalled", label: "Ajan takıldı" },
      { value: "agent.session.ended", label: "Ajan oturumu bitti / çöktü" },
      { value: "agent.handoff", label: "Ajan devretti" },
      { value: "boundary.violation", label: "Sınır ihlali" },
    ],
  },
  {
    label: "Görevler",
    types: [
      { value: "task.completed", label: "Görev tamamlandı" },
      { value: "task.failed", label: "Görev başarısız" },
      { value: "gate.loop_exhausted", label: "Kapı tur sınırını aştı" },
      { value: "schedule.*", label: "Zamanlanmış görevler" },
    ],
  },
  {
    label: "Limitler",
    types: [
      { value: "limit.warning", label: "Limit %80" },
      { value: "limit.exhausted", label: "Limit doldu" },
      { value: "limit.reset", label: "Limit sıfırlandı" },
    ],
  },
  {
    label: "Git ve deploy",
    types: [
      { value: "pr.*", label: "Tüm PR olayları" },
      { value: "pr.ci_failed", label: "CI kırıldı" },
      { value: "pr.review", label: "Yeni review" },
      { value: "deploy.failed", label: "Deploy başarısız" },
      { value: "deploy.succeeded", label: "Deploy başarılı" },
    ],
  },
  {
    label: "Hafıza",
    types: [{ value: "memory.proposed", label: "Hafıza önerisi" }],
  },
];

export function eventTypeLabel(value: string): string {
  for (const g of EVENT_TYPE_GROUPS) for (const t of g.types) if (t.value === value) return t.label;
  return value;
}

/** Same rule as the backend: "pr.review" or "pr.*". */
export function isValidEventType(value: string): boolean {
  const v = value.trim();
  return /^[a-z_]+(\.[a-z_]+)*(\.\*)?$/.test(v);
}

// ----------------------------------------------------------------------------- budgets & limits

export interface BudgetForm {
  fiveHour: string;
  weekly: string;
  duration: string;
  turns: string;
}

export function budgetForm(b: Partial<Budget> | null | undefined): BudgetForm {
  const s = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
  return { fiveHour: s(b?.max_five_hour_percent), weekly: s(b?.max_weekly_percent), duration: s(b?.max_duration_minutes), turns: s(b?.max_turns) };
}

export function validateBudget(f: BudgetForm): { budget: Budget; errors: FieldErrors<keyof BudgetForm> } {
  const errors: FieldErrors<keyof BudgetForm> = {};
  const num = (k: keyof BudgetForm, min: number, max: number, int: boolean, msg: string): number | null => {
    const t = f[k].trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
      errors[k] = msg;
      return null;
    }
    return n;
  };
  const budget: Budget = {
    max_five_hour_percent: num("fiveHour", 1, 100, false, "1 ile 100 arasında bir yüzde girin."),
    max_weekly_percent: num("weekly", 1, 100, false, "1 ile 100 arasında bir yüzde girin."),
    max_duration_minutes: num("duration", 1, 24 * 60, true, "1–1440 dakika arası bir tam sayı girin."),
    max_turns: num("turns", 1, 1000, true, "1–1000 arası bir tam sayı girin."),
  };
  return { budget, errors };
}

/** Claude: low..max; Codex reasoning effort. */
export const EFFORT_OPTIONS: Record<Provider, string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high"],
};

// ----------------------------------------------------------------------------- backup

export const BACKUP_INTERVALS = [0, 6, 12, 24, 48, 168] as const;

export function describeInterval(hours: number): string {
  if (!hours) return "Kapalı";
  if (hours === 24) return "Her gün";
  if (hours === 168) return "Haftada bir";
  if (hours % 24 === 0) return `${hours / 24} günde bir`;
  return `${hours} saatte bir`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(n: number): string {
  let v = n;
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat("tr-TR", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v)} ${BYTE_UNITS[i]}`;
}

// ----------------------------------------------------------------------------- live events

export const SETTINGS_EVENT_TYPES = ["alert.*", "agent.profile.*", "backup.*", "settings.changed"];

/** Query-key prefixes to refresh for a batch of live events. */
export function settingsInvalidations(batch: Pick<StudioEvent, "type">[]): string[][] {
  const out = new Map<string, string[]>();
  const add = (...k: string[]) => out.set(k.join("/"), k);
  for (const ev of batch) {
    const t = ev.type;
    if (t.startsWith("alert.channel")) add("settings", "alerts", "channels");
    if (t === "alert.sent" || t === "alert.failed" || t.startsWith("alert.channel_error")) add("settings", "alerts", "log");
    if (t.startsWith("agent.profile.")) add("settings", "profiles");
    if (t.startsWith("backup.")) add("settings", "backup");
  }
  return [...out.values()];
}
