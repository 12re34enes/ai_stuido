/** Monochrome GitHub / GitLab marks (internal use, replaceable assets — spec §20). */
import type { SVGProps } from "react";

import type { HostingKind } from "../types";

export function GitHubGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function GitLabGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="m23.6 9.6-.03-.09-3.27-8.53a.85.85 0 0 0-.84-.54.87.87 0 0 0-.5.19.87.87 0 0 0-.29.44l-2.2 6.75H7.53L5.33 1.07a.86.86 0 0 0-.29-.44.87.87 0 0 0-1-.05.86.86 0 0 0-.34.4L.43 9.5l-.03.09a6.07 6.07 0 0 0 2.01 7.01l.01.01.03.02 4.98 3.73 2.46 1.86 1.5 1.13a1.01 1.01 0 0 0 1.22 0l1.5-1.13 2.46-1.86 5.01-3.75.01-.01a6.07 6.07 0 0 0 2.01-7Z" />
    </svg>
  );
}

export function HostingMark({ kind, size = 16, className }: { kind: HostingKind; size?: number; className?: string }) {
  const Glyph = kind === "github" ? GitHubGlyph : GitLabGlyph;
  return <Glyph width={size} height={size} className={className} />;
}
