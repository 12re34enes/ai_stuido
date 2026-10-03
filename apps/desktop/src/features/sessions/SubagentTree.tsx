/**
 * Animated tree of a session's CLI-native subagents (nested), with status, task and tokens.
 * Embedded by the sessions stream, agent cards, task detail and the live team view.
 * STUB — implemented by the native-subagents workstream (round 3). Keep the props contract.
 */
export interface SubagentTreeProps {
  sessionId: string;
  /** Compact = small inline variant for cards and team nodes. */
  compact?: boolean;
  /** Called when a subagent is clicked (e.g. scroll the stream to it). */
  onSelect?: (subagentId: string) => void;
}

export function SubagentTree(_props: SubagentTreeProps) {
  return null;
}
