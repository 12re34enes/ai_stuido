/** Vertical rhythm of the conversation (shared by the top-level list and subagent bodies). */
import type { StreamItem } from "./model";

type Kind = StreamItem["kind"];
const DENSE: Kind[] = ["tool", "file", "thinking"];

/** Space above an item given the one before it (px, comfortable density). */
export function gapBefore(prev: StreamItem | undefined, cur: StreamItem): number {
  if (!prev) return 0;
  if (cur.kind === "user") return prev.kind === "turn" || prev.kind === "notice" ? 16 : 24;
  if (cur.kind === "turn" || cur.kind === "notice") return 16;
  if (prev.kind === "turn" || prev.kind === "notice") return 16;
  if (prev.kind === "user") return 16;
  if (cur.kind === "permission" || prev.kind === "permission") return 10;
  if (cur.kind === "subagent" || prev.kind === "subagent") return 8;
  if (DENSE.includes(cur.kind) && DENSE.includes(prev.kind)) return 2;
  if (cur.kind === "assistant" && prev.kind === "assistant") return 12;
  return 10;
}

/** Initial height guesses for the virtualizer (measured afterwards). */
export const ESTIMATE: Record<Kind, number> = {
  user: 52,
  assistant: 84,
  thinking: 30,
  tool: 34,
  file: 34,
  permission: 150,
  turn: 24,
  notice: 24,
  subagent: 64,
};
