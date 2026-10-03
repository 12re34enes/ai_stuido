/** xterm.js theme built from the design tokens (so the terminal follows light / dark). */
import type { ITheme } from "@xterm/xterm";

const ANSI: [keyof ITheme, string][] = [
  ["black", "--ansi-black"],
  ["red", "--ansi-red"],
  ["green", "--ansi-green"],
  ["yellow", "--ansi-yellow"],
  ["blue", "--ansi-blue"],
  ["magenta", "--ansi-magenta"],
  ["cyan", "--ansi-cyan"],
  ["white", "--ansi-white"],
  ["brightBlack", "--ansi-bright-black"],
  ["brightRed", "--ansi-bright-red"],
  ["brightGreen", "--ansi-bright-green"],
  ["brightYellow", "--ansi-bright-yellow"],
  ["brightBlue", "--ansi-bright-blue"],
  ["brightMagenta", "--ansi-bright-magenta"],
  ["brightCyan", "--ansi-bright-cyan"],
  ["brightWhite", "--ansi-bright-white"],
];

export function readXtermTheme(el: Element): ITheme {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const theme: ITheme = {
    background: v("--code-bg"),
    foreground: v("--fg"),
    cursor: v("--accent"),
    cursorAccent: v("--code-bg"),
    selectionBackground: v("--accent-soft"),
    selectionForeground: v("--fg"),
  };
  for (const [key, name] of ANSI) (theme as Record<string, string>)[key] = v(name);
  return theme;
}

export function readMonoFont(el: Element): string {
  return getComputedStyle(el).getPropertyValue("--font-mono").trim() || "ui-monospace, Menlo, monospace";
}

/** Call `cb` whenever the effective theme may have changed (forced theme or system scheme). */
export function onThemeChange(cb: () => void): () => void {
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const obs = new MutationObserver(cb);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  mql.addEventListener("change", cb);
  return () => {
    obs.disconnect();
    mql.removeEventListener("change", cb);
  };
}
