/** Small building blocks shared by the per-kind approval details. */
import type { ReactNode } from "react";

import { cn } from "@/ui";

import type { ApprovalRecord } from "../api";
import type { Draft } from "../draft";

export interface DetailProps {
  approval: ApprovalRecord;
  variant: "compact" | "full";
  draft: Draft;
  setDraft: (patch: Draft) => void;
  /** Editing is allowed (pending and not deciding). */
  editable: boolean;
}

export function Section({ title, trailing, children, className }: { title?: ReactNode; trailing?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {(title || trailing) && (
        <div className="flex min-h-5 items-center justify-between gap-3">
          {title && <h4 className="font-sans text-2xs font-medium tracking-[0.05em] text-fg-faint uppercase">{title}</h4>}
          {trailing}
        </div>
      )}
      {children}
    </section>
  );
}

/** Label / value grid ("Host  api-prod-1"). */
export function Facts({ rows, className }: { rows: [ReactNode, ReactNode | null | undefined][]; className?: string }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!shown.length) return null;
  return (
    <dl className={cn("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-1.5 text-xs", className)}>
      {shown.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-muted">{k}</dt>
          <dd className="min-w-0 text-fg [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Stats({ additions, deletions, className }: { additions: number; deletions: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-2xs tabular", className)}>
      <span className="text-success">+{additions}</span>
      <span className="text-danger">−{deletions}</span>
    </span>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("rounded-[4px] bg-surface-sunken px-1.5 py-px font-mono text-[0.92em] text-fg", className)}>{children}</code>;
}
