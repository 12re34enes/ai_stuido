/**
 * CLI-native subagents of a session (Claude Task/Agent tool, Codex sub-agent threads), built from
 * `agent.subagent.started/completed` events and payloads carrying `subagent_id`.
 * STUB — implemented by the native-subagents workstream (round 3). Keep the exported contract.
 */
export interface SubagentNode {
  id: string;
  parentId: string | null; // parent subagent id (nested), null = directly under the session
  name: string | null; // agent type ("general-purpose", "explorer"...)
  description: string | null;
  status: "running" | "success" | "error" | "interrupted";
  model: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastText: string | null;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

/** Live subagents for a session (empty until implemented). */
export function useSubagents(_sessionId: string | null | undefined): SubagentNode[] {
  return [];
}
