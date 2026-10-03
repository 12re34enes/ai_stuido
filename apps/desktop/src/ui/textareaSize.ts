export interface TextareaMetrics {
  /** element.scrollHeight measured with height:auto (includes padding, excludes border). */
  scrollHeight: number;
  lineHeight: number;
  paddingY: number;
  borderY: number;
  minRows: number;
  maxRows?: number;
}

/** Height for an auto-growing textarea, clamped between min and max rows. */
export function textareaHeight(m: TextareaMetrics): { height: number; overflow: boolean } {
  const chrome = m.paddingY + m.borderY;
  const min = m.minRows * m.lineHeight + chrome;
  const max = m.maxRows ? m.maxRows * m.lineHeight + chrome : Number.POSITIVE_INFINITY;
  const content = m.scrollHeight + m.borderY;
  return { height: Math.min(max, Math.max(min, content)), overflow: content > max };
}
