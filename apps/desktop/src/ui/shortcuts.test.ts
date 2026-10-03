import { isTypingTarget, matchesShortcut, parseShortcut, shortcutKeys } from "./shortcuts";

function key(init: KeyboardEventInit & { key: string; code?: string }) {
  return new KeyboardEvent("keydown", init);
}

describe("parseShortcut", () => {
  it("parses mac glyphs", () => {
    expect(parseShortcut("⌘⇧K")).toEqual({ meta: true, ctrl: false, alt: false, shift: true, key: "k" });
    expect(parseShortcut("⌃⌘S")).toMatchObject({ meta: true, ctrl: true, key: "s" });
    expect(parseShortcut("⌘,")).toMatchObject({ meta: true, key: "," });
    expect(parseShortcut("Esc")).toMatchObject({ meta: false, key: "escape" });
  });

  it("parses plus spellings", () => {
    expect(parseShortcut("Mod+Shift+P")).toMatchObject({ meta: true, shift: true, key: "p" });
  });
});

describe("shortcutKeys", () => {
  it("splits into display keys in mac order", () => {
    expect(shortcutKeys("⌘K")).toEqual(["⌘", "K"]);
    expect(shortcutKeys("⌘⇧P")).toEqual(["⇧", "⌘", "P"]);
    expect(shortcutKeys("⌃⌘S")).toEqual(["⌃", "⌘", "S"]);
    expect(shortcutKeys("Esc")).toEqual(["Esc"]);
  });
});

describe("matchesShortcut", () => {
  it("matches ⌘K on mac only with meta", () => {
    expect(matchesShortcut(key({ key: "k", code: "KeyK", metaKey: true }), "⌘K", true)).toBe(true);
    expect(matchesShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), "⌘K", true)).toBe(false);
    expect(matchesShortcut(key({ key: "k", code: "KeyK" }), "⌘K", true)).toBe(false);
  });

  it("treats Ctrl as ⌘ off mac", () => {
    expect(matchesShortcut(key({ key: "k", code: "KeyK", ctrlKey: true }), "⌘K", false)).toBe(true);
  });

  it("matches digits by physical key and punctuation regardless of shift", () => {
    expect(matchesShortcut(key({ key: "1", code: "Digit1", metaKey: true }), "⌘1", true)).toBe(true);
    expect(matchesShortcut(key({ key: "!", code: "Digit1", metaKey: true, shiftKey: true }), "⌘1", true)).toBe(false);
    expect(matchesShortcut(key({ key: ",", code: "Comma", metaKey: true }), "⌘,", true)).toBe(true);
  });

  it("requires ctrl for ⌃⌘S", () => {
    expect(matchesShortcut(key({ key: "s", code: "KeyS", metaKey: true, ctrlKey: true }), "⌃⌘S", true)).toBe(true);
    expect(matchesShortcut(key({ key: "s", code: "KeyS", metaKey: true }), "⌃⌘S", true)).toBe(false);
  });

  it("keeps ⌃⌘S apart from Ctrl+S off mac", () => {
    expect(matchesShortcut(key({ key: "s", code: "KeyS", ctrlKey: true }), "⌃⌘S", false)).toBe(false);
    expect(matchesShortcut(key({ key: "s", code: "KeyS", ctrlKey: true, metaKey: true }), "⌃⌘S", false)).toBe(true);
    expect(matchesShortcut(key({ key: "s", code: "KeyS", ctrlKey: true }), "⌘S", false)).toBe(true);
  });

  it("matches ⌃-only shortcuts off mac", () => {
    expect(matchesShortcut(key({ key: "`", code: "Backquote", ctrlKey: true }), "⌃`", false)).toBe(true);
    expect(matchesShortcut(key({ key: "`", code: "Backquote", ctrlKey: true, metaKey: true }), "⌃`", false)).toBe(false);
  });

  it("rejects a held Ctrl for plain keys", () => {
    expect(matchesShortcut(key({ key: "j", code: "KeyJ", ctrlKey: true }), "J", false)).toBe(false);
    expect(matchesShortcut(key({ key: "j", code: "KeyJ" }), "J", false)).toBe(true);
  });
});

describe("isTypingTarget", () => {
  it("detects text fields", () => {
    expect(isTypingTarget(document.createElement("input"))).toBe(true);
    expect(isTypingTarget(document.createElement("textarea"))).toBe(true);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
