/**
 * Live view of one agent session (messages, thinking, tool calls, file changes, permission
 * prompts, input box for send/steer/interrupt). Shared: the tasks feature embeds it in the drawer.
 * STUB — implemented by the sessions workstream. Keep the props contract stable.
 */
export interface SessionStreamProps {
  sessionId: string;
  /** Compact = drawer/inline variant (no header chrome, smaller type). */
  compact?: boolean;
  /** Show the input box (send / steer / interrupt). Default true. */
  interactive?: boolean;
}

export function SessionStream({ sessionId }: SessionStreamProps) {
  return <div className="p-4 text-fg-muted">Oturum akışı: {sessionId}</div>;
}
