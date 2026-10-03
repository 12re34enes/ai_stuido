/** Provider looks of member cards (spec §20): Claude warm + soft radius + serif, Codex mono + sharp. */
import type { Provider } from "../types";

export function providerSurface(provider: Provider): string {
  return provider === "codex" ? "rounded-[7px] border-codex-line bg-codex-surface" : "rounded-xl border-claude-line bg-claude-surface";
}

export function providerRadius(provider: Provider): string {
  return provider === "codex" ? "rounded-[7px]" : "rounded-xl";
}

/** Outer ring radius matching `providerRadius` with a 3px gap. */
export function providerRing(provider: Provider): string {
  return provider === "codex" ? "rounded-[10px]" : "rounded-[15px]";
}

export function nameFont(provider: Provider): string {
  return provider === "codex" ? "font-mono text-xs font-medium" : "font-serif text-sm";
}
