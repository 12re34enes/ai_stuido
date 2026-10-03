/** Theme application: "system" follows macOS; "light"/"dark" force via html[data-theme]. */
export type ThemePref = "system" | "light" | "dark";

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}
