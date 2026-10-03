/** Subagent nodes as the folded stream sees them (exact counts, delta-level live lines). */
import type { SubagentNode } from "../subagent/model";
import { firstLine, subagentItems, type StreamState, type SubagentItem } from "./model";
import { sessionStrings } from "../strings";
import { describeToolText } from "./tools";

function liveLine(state: Pick<StreamState, "lanes">, it: SubagentItem, cwd: string | null): string | null {
  if (it.status !== "running") return firstLine(it.resultText ?? "") ?? it.lastText;
  if (it.pendingPermission) return sessionStrings.subagents.asking(it.pendingPermission.summary);
  if (it.lastActivity === "tool" && it.lastToolKey) {
    const tool = state.lanes[it.subagentId]?.items.find((i) => i.key === it.lastToolKey);
    if (tool?.kind === "tool") return describeToolText(tool, cwd);
  }
  return it.lastText;
}

export function subagentNodesFromStream(state: Pick<StreamState, "items" | "lanes"> | null | undefined, cwd: string | null = null): SubagentNode[] {
  if (!state) return [];
  return subagentItems(state).map((it) => ({
    id: it.subagentId,
    parentId: it.parentSubagentId,
    name: it.name,
    description: it.description,
    status: it.status,
    model: it.model,
    startedAt: it.ts,
    finishedAt: it.finishedTs,
    lastText: liveLine(state, it, cwd),
    inputTokens: it.usage?.input_tokens ?? 0,
    outputTokens: it.usage?.output_tokens ?? 0,
    toolCalls: it.toolCalls,
    contextUsed: it.usage?.context_used ?? null,
    contextWindow: it.usage?.context_window ?? null,
    prompt: it.prompt,
    parentCallId: it.callId,
    waiting: it.pendingPermission !== null,
  }));
}
