/** Pure list logic for the sessions page: filtering, ordering and discovery grouping. */
import type { AgentState, Provider } from "@/lib/types";
import { isAgentBusy } from "@/ui/agentStatus";

import type { DiscoveredSession, SessionView } from "./api";

export type StateFilter = "all" | "active" | "finished";
export type ProviderFilter = "all" | Provider;

export interface SessionFilters {
  q: string;
  state: StateFilter;
  provider: ProviderFilter;
  workspaceId: string | null;
}

export const DEFAULT_FILTERS: SessionFilters = { q: "", state: "all", provider: "all", workspaceId: null };

const FINISHED: AgentState[] = ["done", "error", "interrupted"];

/** Live process or working state counts as active. */
export function isActiveSession(s: Pick<SessionView, "state" | "live">): boolean {
  return Boolean(s.live) || isAgentBusy(s.state) || s.state === "starting";
}

function fold(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
}

export function filterSessions(list: readonly SessionView[], f: SessionFilters): SessionView[] {
  const q = fold(f.q.trim());
  return list.filter((s) => {
    if (f.provider !== "all" && s.provider !== f.provider) return false;
    if (f.workspaceId && s.workspace_id !== f.workspaceId) return false;
    if (f.state === "active" && !isActiveSession(s)) return false;
    if (f.state === "finished" && (isActiveSession(s) || !FINISHED.includes(s.state))) return false;
    if (q) {
      const hay = fold([s.label, s.title, s.cwd, s.model, s.id, s.native_id].filter(Boolean).join(" "));
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Active first, then most recently updated. */
export function sortSessions(list: readonly SessionView[]): SessionView[] {
  return [...list].sort((a, b) => {
    const act = Number(isActiveSession(b)) - Number(isActiveSession(a));
    if (act !== 0) return act;
    return Date.parse(b.updated_at) - Date.parse(a.updated_at);
  });
}

export function splitActive(list: readonly SessionView[]): { active: SessionView[]; recent: SessionView[] } {
  const sorted = sortSessions(list);
  return { active: sorted.filter(isActiveSession), recent: sorted.filter((s) => !isActiveSession(s)) };
}

export function hasActiveFilters(f: SessionFilters): boolean {
  return f.q.trim() !== "" || f.state !== "all" || f.provider !== "all" || f.workspaceId !== null;
}

// --------------------------------------------------------------------------- discovery

export interface ProjectGroup {
  cwd: string;
  /** Last path segment ("web"). */
  name: string;
  /** Parent path ("~/src/odeme-servisi/apps"). */
  parent: string;
  items: DiscoveredSession[];
  latest: number;
}

const ts = (d: DiscoveredSession) => Date.parse(d.updated_at ?? d.created_at ?? "") || 0;

export function groupByProject(list: readonly DiscoveredSession[], home?: string | null): ProjectGroup[] {
  const groups = new Map<string, DiscoveredSession[]>();
  for (const s of list) {
    const key = s.cwd ?? "";
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  const out: ProjectGroup[] = [];
  for (const [cwd, items] of groups) {
    const sorted = [...items].sort((a, b) => ts(b) - ts(a));
    const parts = cwd.split("/").filter(Boolean);
    let parent = parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : cwd ? "/" : "";
    if (home && parent.startsWith(home)) parent = `~${parent.slice(home.length)}`;
    out.push({ cwd, name: parts[parts.length - 1] ?? "", parent, items: sorted, latest: sorted[0] ? ts(sorted[0]) : 0 });
  }
  return out.sort((a, b) => b.latest - a.latest);
}

/** Best-effort home directory from the discovered paths ("/Users/x" or "/home/x"). */
export function guessHome(list: readonly DiscoveredSession[]): string | null {
  for (const s of list) {
    const m = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(s.cwd ?? "");
    if (m?.[1]) return m[1];
  }
  return null;
}
