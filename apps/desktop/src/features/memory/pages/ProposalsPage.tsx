import { CheckCheck, CircleSlash, Inbox } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { duration, ease, variants } from "@/motion/tokens";
import { CountBadge, EmptyState, SegmentedControl, Skeleton } from "@/ui";

import { LoadError } from "@/features/studios/components/Page";

import { useProposals } from "../api";
import { ProposalCard } from "../components/ProposalCard";
import { memoryStrings as s } from "../strings";
import type { ProposalStatus } from "../types";

const TABS: ProposalStatus[] = ["pending", "applied", "rejected"];

export function ProposalsPage({ ws }: { ws: string }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("status");
  const tab: ProposalStatus = raw === "applied" || raw === "rejected" ? raw : "pending";
  const { data, isPending, isError, error, refetch } = useProposals(ws);
  // Which way each decided card leaves: approved ones fly up toward "Uygulanan", rejected slide away.
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const out: Record<ProposalStatus, NonNullable<typeof data>> = { pending: [], applied: [], rejected: [] };
    for (const p of data ?? []) out[p.status]?.push(p);
    for (const k of TABS) out[k].sort((a, b) => (k === "pending" ? a.created_at.localeCompare(b.created_at) : (b.decided_at ?? b.created_at).localeCompare(a.decided_at ?? a.created_at)));
    return out;
  }, [data]);
  const list = groups[tab];

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-6 px-10 pt-8 pb-20">
      <header className="flex items-end justify-between gap-6">
        <div className="flex max-w-[560px] flex-col gap-1.5">
          <h2 className="text-2xl text-fg">{s.proposalsTitle}</h2>
          <p className="text-sm text-fg-muted">{s.proposalsSubtitle}</p>
        </div>
        <SegmentedControl
          aria-label={s.proposals}
          value={tab}
          onValueChange={(v) => setParams(v === "pending" ? {} : { status: v })}
          options={TABS.map((t) => ({
            value: t,
            label: (
              <span className="inline-flex items-center gap-1.5">
                {s.tabs[t]}
                <CountBadge count={groups[t].length} tone={t === "pending" ? "accent" : "neutral"} />
              </span>
            ),
          }))}
        />
      </header>

      {isError && !data ? (
        <LoadError title={s.loadError} error={error} onRetry={() => void refetch()} className="mt-8" />
      ) : isPending ? (
        <div className="flex flex-col gap-4" aria-busy>
          {[0, 1].map((i) => (
            <Skeleton key={i} height={168} className="rounded-xl" />
          ))}
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} {...variants.fade} className="flex flex-col gap-4">
            {list.length === 0 ? (
              <EmptyState
                icon={tab === "pending" ? <CheckCheck /> : tab === "applied" ? <Inbox /> : <CircleSlash />}
                title={tab === "pending" ? s.emptyPending : tab === "applied" ? s.emptyApplied : s.emptyRejected}
                description={tab === "pending" ? s.emptyPendingHint : undefined}
                className="mt-6"
              />
            ) : (
              <ul className="flex flex-col gap-4">
                <AnimatePresence initial={false} mode="popLayout">
                  {list.map((p, i) => (
                    <motion.li
                      key={p.id}
                      layout
                      className="list-none"
                      initial={{ opacity: 0, y: 10, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: duration.standard, ease: ease.out, delay: Math.min(i, 5) * 0.04 } }}
                      exit={
                        decisions[p.id] === false
                          ? { opacity: 0, x: -56, transition: { duration: duration.standard, ease: ease.in } }
                          : { opacity: 0, x: 72, y: -36, scale: 0.92, transition: { duration: duration.standard, ease: ease.in } }
                      }
                    >
                      <ProposalCard
                        proposal={p}
                        ws={ws}
                        defaultExpanded={tab === "pending" && i === 0}
                        onDecide={(id, approve) => setDecisions((d) => ({ ...d, [id]: approve }))}
                      />
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}
