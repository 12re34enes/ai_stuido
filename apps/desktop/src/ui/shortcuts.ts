/**
 * Keyboard shortcut helpers. Shortcuts are written the macOS way ("⌘K", "⌘⇧P", "⌥⌘1", "⌘,").
 * On non-mac hosts (CI, browser dev on Linux) ⌘ also matches Ctrl.
 */

export interface ParsedShortcut {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** Lowercase key ("k", "1", ",", "escape", "enter", "arrowup", "\\"). */
  key: string;
}

const MODS: Record<string, keyof Omit<ParsedShortcut, "key">> = {
  "⌘": "meta",
  "⌃": "ctrl",
  "⌥": "alt",
  "⇧": "shift",
};

const NAMED: Record<string, string> = {
  "↵": "enter",
  "⏎": "enter",
  "⎋": "escape",
  esc: "escape",
  "↑": "arrowup",
  "↓": "arrowdown",
  "←": "arrowleft",
  "→": "arrowright",
  "⌫": "backspace",
  "⇥": "tab",
  space: " ",
};

const DISPLAY: Record<string, string> = {
  enter: "↵",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  tab: "⇥",
  " ": "Space",
};

export function parseShortcut(shortcut: string): ParsedShortcut {
  const out: ParsedShortcut = { meta: false, ctrl: false, alt: false, shift: false, key: "" };
  let rest = shortcut.trim();
  // Accept "Mod+K" / "Ctrl+Shift+P" spellings too.
  if (rest.includes("+") && rest.length > 1) {
    const parts = rest.split("+");
    const key = parts.pop() ?? "";
    for (const p of parts) {
      const m = p.toLowerCase();
      if (m === "mod" || m === "cmd" || m === "meta") out.meta = true;
      else if (m === "ctrl" || m === "control") out.ctrl = true;
      else if (m === "alt" || m === "option") out.alt = true;
      else if (m === "shift") out.shift = true;
    }
    rest = key;
  } else {
    while (rest.length > 1 && MODS[rest[0] ?? ""]) {
      out[MODS[rest[0] ?? ""]!] = true;
      rest = rest.slice(1);
    }
  }
  const lower = rest.toLowerCase();
  out.key = NAMED[lower] ?? NAMED[rest] ?? lower;
  return out;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return true;
  return /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);
}

/** Does the keyboard event match the shortcut? */
export function matchesShortcut(event: KeyboardEvent, shortcut: string | ParsedShortcut, mac = isMacPlatform()): boolean {
  const s = typeof shortcut === "string" ? parseShortcut(shortcut) : shortcut;
  const key = event.key.toLowerCase();
  // Digits and punctuation: compare the physical key too, so ⌥/⇧ variants still match.
  const code = event.code.toLowerCase();
  const keyOk =
    key === s.key ||
    (s.key.length === 1 && /[0-9]/.test(s.key) && code === `digit${s.key}`) ||
    (s.key.length === 1 && /[a-z]/.test(s.key) && code === `key${s.key}`);
  if (!keyOk) return false;
  const shiftOk = s.key.length === 1 && !/[a-z0-9]/.test(s.key) ? true : event.shiftKey === s.shift;
  return modifiersOk(event, s, mac) && event.altKey === s.alt && shiftOk;
}

/**
 * ⌘/⌃ matching. On mac both are exact. Elsewhere ⌘ means Ctrl, so "⌘S" accepts Ctrl+S (or the
 * Super key), "⌃S" wants Ctrl without Super, and "⌃⌘S" needs both — it must not fire on Ctrl+S.
 */
function modifiersOk(event: KeyboardEvent, s: ParsedShortcut, mac: boolean): boolean {
  if (mac) return event.metaKey === s.meta && event.ctrlKey === s.ctrl;
  if (s.meta && s.ctrl) return event.ctrlKey && event.metaKey;
  if (s.meta) return event.ctrlKey || event.metaKey;
  if (s.ctrl) return event.ctrlKey && !event.metaKey;
  return !event.ctrlKey && !event.metaKey;
}

/** Split a shortcut into display keys for <Kbd>: "⌘⇧K" → ["⌘", "⇧", "K"]. */
export function shortcutKeys(shortcut: string): string[] {
  const s = parseShortcut(shortcut);
  const keys: string[] = [];
  if (s.ctrl) keys.push("⌃");
  if (s.alt) keys.push("⌥");
  if (s.shift) keys.push("⇧");
  if (s.meta) keys.push("⌘");
  keys.push(DISPLAY[s.key] ?? s.key.toUpperCase());
  return keys;
}

/** Whether focus is in a text field (plain-key shortcuts should not fire there). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}
