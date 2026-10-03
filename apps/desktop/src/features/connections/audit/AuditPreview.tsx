import { motion } from "motion/react";
import { useState, type ReactNode } from "react";

import { stagger } from "@/motion/tokens";
import { Skeleton } from "@/ui";

import { useAudit } from "../api";
import { ErrorState } from "../kit";
import type { AuditQuery } from "../types";
import { AuditRow } from "./AuditRow";

/** The latest audit records for one target (host / database detail pages). Live via events. */
export function AuditPreview({ query, empty }: { query: AuditQuery; empty: ReactNode }) {
  const audit = useAudit(query);
  const [open, setOpen] = useState<number | null>(null);
  if (audit.isPending)
    return (
      <div className="flex flex-col gap-2.5 px-4 py-3.5">
        <Skeleton height={12} width="70%" />
        <Skeleton height={12} width="55%" />
      </div>
    );
  if (audit.isError) return <ErrorState size="sm" error={audit.error} onRetry={() => void audit.refetch()} />;
  const entries = audit.data?.entries ?? [];
  if (entries.length === 0) return <>{empty}</>;
  return (
    <motion.ul initial="initial" animate="animate" variants={stagger(0.03)} className="divide-y divide-line-subtle">
      {entries.map((e) => (
        <AuditRow key={e.event_id} entry={e} compact expanded={open === e.event_id} onToggle={() => setOpen((o) => (o === e.event_id ? null : e.event_id))} />
      ))}
    </motion.ul>
  );
}
