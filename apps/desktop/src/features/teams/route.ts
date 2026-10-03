/** /teams/* location parsing. */
export type TeamsRoute =
  | { page: "list" }
  | { page: "builder"; teamId: string | null; version: number | null; fromTeamId: string | null }
  | { page: "live"; runId: string; nodeId: string | null };

export function parseTeamsRoute(pathname: string, search: string): TeamsRoute {
  const rest = pathname.replace(/^\/teams\/?/, "").replace(/\/$/, "");
  const params = new URLSearchParams(search);
  if (!rest) return { page: "list" };
  if (rest === "new") return { page: "builder", teamId: null, version: null, fromTeamId: params.get("from") };
  const parts = rest.split("/").map((p) => decodeURIComponent(p));
  if (parts[0] === "live" && parts[1]) return { page: "live", runId: parts[1], nodeId: params.get("node") };
  const v = Number(params.get("version"));
  return { page: "builder", teamId: parts[0]!, version: Number.isInteger(v) && v > 0 ? v : null, fromTeamId: null };
}

export const teamsPaths = {
  list: "/teams",
  new: (from?: string) => (from ? `/teams/new?from=${encodeURIComponent(from)}` : "/teams/new"),
  edit: (id: string) => `/teams/${encodeURIComponent(id)}/edit`,
  live: (runId: string, nodeId?: string | null) => `/teams/live/${encodeURIComponent(runId)}${nodeId ? `?node=${encodeURIComponent(nodeId)}` : ""}`,
};
