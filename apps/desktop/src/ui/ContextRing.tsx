/**
 * Context-window fill ring for a session / agent (used tokens vs window).
 * STUB — implemented by the native-subagents workstream (round 3). Keep the props contract.
 */
export interface ContextRingProps {
  /** Tokens currently in context. */
  used: number | null | undefined;
  /** Model context window in tokens. */
  window: number | null | undefined;
  /** Diameter in px (default 20). */
  size?: number;
  /** Show the percentage next to the ring. */
  showLabel?: boolean;
  className?: string;
}

export function ContextRing({ used, window, showLabel }: ContextRingProps) {
  const pct = used && window ? Math.round((used / window) * 100) : null;
  return showLabel && pct !== null ? <span className="text-xs text-fg-muted">%{pct}</span> : null;
}
