/**
 * Provider glyphs — ORIGINAL, replaceable placeholder marks (not the providers' trademarks).
 * To use other artwork, replace these two components; keep the 24×24 viewBox and draw with
 * `currentColor` so ProviderMark can color them per theme.
 *
 * Claude: warm and organic — an open, round-capped "C" with a spark dot.
 * Codex: sharp and code-forward — a hard-edged hexagon around a prompt.
 */
import type { SVGProps } from "react";

export function ClaudeGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M17.36 7.5A7 7 0 1 0 17.36 16.5" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" />
      <circle cx={19.6} cy={12} r={1.8} fill="currentColor" />
    </svg>
  );
}

export function CodexGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path
        d="M12 2.6 20.2 7.3v9.4L12 21.4l-8.2-4.7V7.3Z"
        stroke="currentColor"
        strokeWidth={1.9}
        strokeLinejoin="miter"
      />
      <path d="M8.4 9.4 11 12l-2.6 2.6" stroke="currentColor" strokeWidth={1.9} strokeLinecap="square" />
      <path d="M12.6 14.8h3.2" stroke="currentColor" strokeWidth={1.9} strokeLinecap="square" />
    </svg>
  );
}
