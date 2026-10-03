import { describe, expect, it } from "vitest";

import {
  acceleratorLabel,
  canLink,
  channelPayload,
  channelValues,
  describeInterval,
  describeQuietHours,
  formatBytes,
  formatDays,
  isQuietAt,
  isValidEventType,
  parseTime,
  recordShortcut,
  settingsInvalidations,
  validateBudget,
  validateChannel,
  validateQuietHours,
  visibleFields,
  windowMinutes,
  type KeyLike,
} from "./logic";
import type { QuietHours } from "./types";

const key = (code: string, mods: Partial<KeyLike> = {}): KeyLike => ({ key: "", code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("quiet hours", () => {
  const q: QuietHours = { enabled: true, start: "23:00", end: "08:00", timezone: "UTC", days: null };

  it("parses times and window lengths across midnight", () => {
    expect(parseTime("08:30")).toBe(510);
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("8:30")).toBeNull();
    expect(windowMinutes("23:00", "08:00")).toBe(540);
    expect(windowMinutes("13:00", "14:30")).toBe(90);
  });

  it("describes the window in Turkish", () => {
    expect(describeQuietHours(q)).toBe("Her gün 23:00 – 08:00 (9 sa)");
    expect(describeQuietHours({ ...q, days: [0, 1, 2, 3, 4], start: "22:30" })).toBe("Hafta içi 22:30 – 08:00 (9 sa 30 dk)");
    expect(describeQuietHours({ ...q, enabled: false })).toBe("Kapalı");
    expect(formatDays([5, 6])).toBe("Hafta sonu");
    expect(formatDays([2])).toBe("Her Çarşamba");
    expect(formatDays([0, 2, 4])).toBe("Pzt, Çar, Cum");
  });

  it("validates like the backend", () => {
    expect(validateQuietHours({ ...q, start: "25:00" }).start).toBeTruthy();
    expect(validateQuietHours({ ...q, end: "23:00" }).end).toBe("Başlangıç ve bitiş aynı olamaz.");
    expect(validateQuietHours({ ...q, days: [] }).days).toBeTruthy();
    expect(validateQuietHours(q)).toEqual({});
  });

  it("knows whether a moment is quiet (start-day semantics across midnight)", () => {
    // 2026-10-02 is a Friday (weekday 4).
    expect(isQuietAt(q, new Date("2026-10-02T23:30:00Z"))).toBe(true);
    expect(isQuietAt(q, new Date("2026-10-03T07:59:00Z"))).toBe(true);
    expect(isQuietAt(q, new Date("2026-10-03T08:00:00Z"))).toBe(false);
    const weekdays = { ...q, days: [0, 1, 2, 3, 4] };
    expect(isQuietAt(weekdays, new Date("2026-10-03T02:00:00Z"))).toBe(true); // Saturday morning ← Friday night window
    expect(isQuietAt(weekdays, new Date("2026-10-04T02:00:00Z"))).toBe(false); // Sunday morning ← Saturday (not selected)
    expect(isQuietAt({ ...q, timezone: "Europe/Istanbul" }, new Date("2026-10-02T20:30:00Z"))).toBe(true); // 23:30 in İstanbul
  });
});

describe("global shortcut recorder", () => {
  it("builds a Tauri accelerator and a macOS label", () => {
    expect(recordShortcut(key("Space", { ctrlKey: true, altKey: true }))).toEqual({ kind: "ok", accelerator: "Control+Alt+Space", label: "⌃⌥Space" });
    expect(recordShortcut(key("KeyK", { metaKey: true, shiftKey: true }))).toEqual({ kind: "ok", accelerator: "Shift+Command+K", label: "⇧⌘K" });
    expect(recordShortcut(key("ArrowUp", { altKey: true }))).toMatchObject({ accelerator: "Alt+Up", label: "⌥↑" });
  });

  it("waits on modifiers, cancels on Esc and rejects unsafe combos", () => {
    expect(recordShortcut(key("MetaLeft", { metaKey: true }))).toEqual({ kind: "pending" });
    expect(recordShortcut(key("Escape"))).toEqual({ kind: "cancel" });
    expect(recordShortcut(key("KeyA", { shiftKey: true }))).toMatchObject({ kind: "error" });
    expect(recordShortcut(key("IntlBackslash", { metaKey: true }))).toMatchObject({ kind: "error" });
  });

  it("labels stored accelerators", () => {
    expect(acceleratorLabel("Control+Alt+Space")).toBe("⌃⌥Space");
    expect(acceleratorLabel("CommandOrControl+Shift+p")).toBe("⇧⌘P");
  });
});

describe("alert channels", () => {
  const slack = { kind: "slack" as const, config_fields: ["mode", "channel", "allowed_user_ids"], secret_fields: ["webhook_url", "bot_token", "app_token"] };

  it("switches Slack fields with the mode", () => {
    expect(visibleFields(slack, { mode: "webhook" })).toEqual(["mode", "webhook_url"]);
    expect(visibleFields(slack, { mode: "bot" })).toEqual(["mode", "channel", "allowed_user_ids", "bot_token", "app_token"]);
  });

  it("validates kind-specific requirements, honouring stored secrets", () => {
    expect(validateChannel("slack", { mode: "bot" })).toMatchObject({ bot_token: expect.any(String), channel: expect.any(String) });
    expect(validateChannel("slack", { mode: "bot", channel: "C1" }, ["bot_token"])).toEqual({});
    expect(validateChannel("telegram", {}).bot_token).toBeTruthy();
    expect(validateChannel("email", { host: "smtp", from_addr: "a@b.c", to_addrs: "x" }).to_addrs).toBeTruthy();
    expect(validateChannel("ntfy", { topic_url: "https://ntfy.sh/gizli" })).toEqual({});
    expect(validateChannel("webhook", {}, ["url"])).toEqual({});
    expect(validateChannel("discord", { webhook_url: "http://x.com/hook" }).webhook_url).toBeTruthy();
  });

  it("builds config and secrets (empty secret = keep)", () => {
    expect(channelPayload(slack, { mode: "bot", channel: "C1", allowed_user_ids: "U1, U2", bot_token: "", app_token: "s" })).toEqual({
      config: { mode: "bot", channel: "C1", allowed_user_ids: ["U1", "U2"] },
      secrets: { app_token: "s" },
    });
    const email = { kind: "email" as const, config_fields: ["host", "port", "security", "username", "from_addr", "to_addrs"], secret_fields: ["password"] };
    expect(channelPayload(email, { host: "smtp", port: "587", to_addrs: "a@b.c", from_addr: "x@y.z" }).config).toMatchObject({ port: 587, to_addrs: ["a@b.c"], security: null });
    expect(channelValues({ config: { to_addrs: ["a@b.c", "d@e.f"], port: 465 } })).toEqual({ to_addrs: "a@b.c, d@e.f", port: "465" });
  });

  it("offers linking only for two-way channels", () => {
    expect(canLink({ kind: "telegram", config: {}, two_way: true })).toBe(true);
    expect(canLink({ kind: "slack", config: { mode: "webhook" }, two_way: true })).toBe(false);
    expect(canLink({ kind: "slack", config: { mode: "bot" }, two_way: true })).toBe(true);
    expect(canLink({ kind: "email", config: {}, two_way: false })).toBe(false);
  });

  it("accepts event type patterns like the backend", () => {
    expect(isValidEventType("pr.review")).toBe(true);
    expect(isValidEventType("pr.*")).toBe(true);
    expect(isValidEventType("pr*")).toBe(false);
    expect(isValidEventType("pr review")).toBe(false);
  });
});

describe("budgets, backups and live events", () => {
  it("validates a default budget (blank = no limit)", () => {
    expect(validateBudget({ fiveHour: "25", weekly: "", duration: "90", turns: "" })).toEqual({
      budget: { max_five_hour_percent: 25, max_weekly_percent: null, max_duration_minutes: 90, max_turns: null },
      errors: {},
    });
    expect(validateBudget({ fiveHour: "120", weekly: "x", duration: "1.5", turns: "0" }).errors).toEqual({
      fiveHour: expect.any(String),
      weekly: expect.any(String),
      duration: expect.any(String),
      turns: expect.any(String),
    });
  });

  it("describes backup schedules and sizes in Turkish", () => {
    expect(describeInterval(0)).toBe("Kapalı");
    expect(describeInterval(24)).toBe("Her gün");
    expect(describeInterval(168)).toBe("Haftada bir");
    expect(describeInterval(6)).toBe("6 saatte bir");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(512)).toBe("512 B");
  });

  it("routes settings events to caches", () => {
    expect(settingsInvalidations([{ type: "alert.channel_linked" }, { type: "alert.sent" }, { type: "agent.profile.updated" }, { type: "backup.created" }])).toEqual([
      ["settings", "alerts", "channels"],
      ["settings", "alerts", "log"],
      ["settings", "profiles"],
      ["settings", "backup"],
    ]);
  });
});
