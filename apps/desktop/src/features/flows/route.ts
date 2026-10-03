/** /flows/* location parsing. */
import type { FlowMode } from "./types";

const MODES: FlowMode[] = ["single", "duo", "race", "pipeline", "council", "custom"];

export type FlowsRoute =
  | { page: "list" }
  | { page: "schedules" }
  | { page: "editor"; flowId: string | null; mode: FlowMode | null; studio: string | null; blank: boolean };

/** Parse a /flows/* location (exported for tests). */
export function parseFlowsRoute(pathname: string, search: string): FlowsRoute {
  const rest = pathname.replace(/^\/flows\/?/, "").replace(/\/$/, "");
  if (!rest) return { page: "list" };
  if (rest === "schedules") return { page: "schedules" };
  const params = new URLSearchParams(search);
  if (rest === "new") {
    const mode = params.get("mode");
    return {
      page: "editor",
      flowId: null,
      mode: MODES.includes(mode as FlowMode) ? (mode as FlowMode) : null,
      studio: params.get("studio"),
      blank: params.get("blank") === "1",
    };
  }
  return { page: "editor", flowId: decodeURIComponent(rest.split("/")[0]!), mode: null, studio: null, blank: false };
}
