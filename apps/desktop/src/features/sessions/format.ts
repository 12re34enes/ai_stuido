/** Small display helpers for sessions (titles and paths). */
import { uiStrings } from "@/ui/strings";

import type { SessionView } from "./api";

export function sessionTitle(s: Pick<SessionView, "label" | "title" | "provider" | "role">): string {
  return s.label || s.title || `${uiStrings.providers[s.provider]} · ${uiStrings.agentRole[s.role]}`;
}

/** "/Users/me/src/app/web" → "…/app/web". */
export function shortPath(p: string | null | undefined, keep = 2): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.length <= keep ? p : `…/${parts.slice(-keep).join("/")}`;
}
