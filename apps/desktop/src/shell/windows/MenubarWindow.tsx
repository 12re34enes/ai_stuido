/**
 * Menu bar popover window (#/menubar, 360×480, spec §19 "Menü çubuğu"): limit rings per provider
 * with reset countdowns, pending approvals (approve in place; production only opens the app),
 * active agents, quick "new task", open the app and pause notifications.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, Bell, BellOff, ChevronRight, Inbox, Plus, ShieldAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { ApprovalCard } from "@/features/approvals/ApprovalCard";
import { useConnection } from "@/lib/connection";
import { useShellLiveSync } from "@/lib/live";
import { useActiveSessions, useLimits, usePendingApprovals } from "@/lib/queries";
import type { Approval } from "@/lib/types";
import { stagger, variants } from "@/motion/tokens";
import { getShellStatus, onNotificationsPaused, onWindowShown, setNotificationsPaused, showMainWindow } from "@/native";
import { agentDotStatus, Button, cn, CountBadge, IconButton, ProviderMark, StatusDot, uiStrings } from "@/ui";
import { groupLimits } from "@/ui/limits";

import { shellStrings } from "../strings";
import { useAppearanceSync } from "../useAppearanceSync";
import { LimitRing } from "./LimitRing";
import { windowStrings } from "./strings";
import { WindowSurface } from "./WindowSurface";

const m = windowStrings.menubar;
const MAX_APPROVALS = 3;

function SectionTitle({ children, trailing }: { children: string; trailing?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
      <h2 className="font-sans text-2xs font-medium tracking-wide text-fg-faint uppercase">{children}</h2>
      {trailing}
    </div>
  );
}

/** Production approvals are never decided from the popover: they open in the main window. */
function ProductionApproval({ approval }: { approval: Approval }) {
  return (
    <motion.li variants={variants.listItem} layout="position" className="relative overflow-hidden rounded-lg border border-env-production/35 bg-env-production-soft/70 py-2.5 pr-2.5 pl-3.5">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-env-production" />
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-env-production" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="line-clamp-2 text-sm leading-[18px] text-fg">{approval.title}</span>
          <span className="text-2xs text-fg-muted">
            {shellStrings.approvals.kinds[approval.kind] ?? approval.kind} · {m.productionNote}
          </span>
        </div>
      </div>
      <div className="mt-2 flex justify-end">
        <Button size="sm" variant="danger" iconRight={<ChevronRight className="size-3.5" />} onClick={() => void showMainWindow(`/approvals/${encodeURIComponent(approval.id)}`)}>
          {m.openInApp}
        </Button>
      </div>
    </motion.li>
  );
}

function useNotificationsPaused(): [boolean, (paused: boolean) => void] {
  const status = useQuery({ queryKey: ["shell-status"], queryFn: getShellStatus, staleTime: 10_000, retry: false });
  const [local, setLocal] = useState<boolean | null>(null);
  useEffect(() => onNotificationsPaused((e) => setLocal(e.paused)), []);
  const paused = local ?? status.data?.notificationsPaused ?? false;
  const set = (next: boolean) => {
    setLocal(next);
    void setNotificationsPaused(next)
      .then((v) => setLocal(v))
      .catch(() => setLocal(!next));
  };
  return [paused, set];
}

export default function MenubarWindow() {
  useShellLiveSync();
  useAppearanceSync();
  const qc = useQueryClient();
  const limits = groupLimits(useLimits().data ?? []);
  const approvals = usePendingApprovals().data ?? [];
  const sessions = useActiveSessions().data ?? [];
  const status = useConnection((st) => st.status);
  const [paused, setPaused] = useNotificationsPaused();
  const [shown, setShown] = useState(0);

  // Each time the popover opens: fresh data and the entrance animation plays again.
  useEffect(
    () =>
      onWindowShown(() => {
        void qc.invalidateQueries();
        setShown((n) => n + 1);
      }),
    [qc],
  );

  const sorted = [...approvals].sort((a, b) => Number(b.production) - Number(a.production));
  const visible = sorted.slice(0, MAX_APPROVALS);

  return (
    <WindowSurface>
      <header data-tauri-drag-region className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line-subtle pr-2 pl-4">
        <span className="grid size-6 place-items-center rounded-[7px] bg-accent text-xs text-fg-on-accent" aria-hidden>
          ✦
        </span>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="font-serif text-[15px] text-fg">{shellStrings.appName}</span>
          <span className="flex items-center gap-1 text-[10px] text-fg-muted">
            <StatusDot status={status === "offline" ? "error" : status === "connecting" ? "running" : "success"} size={8} label="" />
            {status === "offline" ? m.offline : status === "connecting" ? m.connecting : m.online}
          </span>
        </div>
        <span className="flex-1" />
        <IconButton
          label={paused ? m.resume : m.pause}
          icon={paused ? <BellOff className="text-warning" /> : <Bell />}
          active={paused}
          onClick={() => setPaused(!paused)}
          tooltipSide="left"
        />
      </header>

      <AnimatePresence initial={false}>
        {paused && (
          <motion.div key="paused" {...variants.fadeUp} className="flex items-center gap-2 border-b border-warning/20 bg-warning-soft/70 px-4 py-1.5 text-2xs text-warning">
            <BellOff className="size-3" aria-hidden />
            {m.paused}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div key={shown} initial="initial" animate="animate" variants={stagger(0.04)} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">
        <motion.section variants={variants.fadeUp} aria-label={m.limits}>
          <SectionTitle>{m.limits}</SectionTitle>
          {limits.length === 0 ? (
            <p className="px-4 pb-1 text-xs text-fg-muted">{m.limitsEmpty}</p>
          ) : (
            <div className={cn("grid gap-2 px-3", limits.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
              {limits.map((g) => (
                <div key={g.provider} className="flex flex-col gap-2 rounded-lg border border-line-subtle bg-surface/70 px-2.5 pt-2 pb-2.5">
                  <span className="flex items-center gap-1.5">
                    <ProviderMark provider={g.provider} size={12} label="" />
                    <span className={cn("text-fg", g.provider === "claude" ? "font-serif text-xs" : "font-mono text-[11px] font-medium")}>{uiStrings.providers[g.provider]}</span>
                  </span>
                  <div className="flex justify-around gap-1">
                    {g.windows.slice(0, 2).map((w) => (
                      <LimitRing key={w.window} provider={g.provider} label={w.label} value={w.used_percent} status={w.status} resetsAt={w.resets_at} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </motion.section>

        <motion.section variants={variants.fadeUp} aria-label={m.approvals}>
          <SectionTitle trailing={<CountBadge count={approvals.length} tone={approvals.some((a) => a.production) ? "danger" : "accent"} />}>{m.approvals}</SectionTitle>
          {approvals.length === 0 ? (
            <p className="flex items-center gap-2 px-4 pb-1 text-xs text-fg-muted">
              <Inbox className="size-3.5 text-fg-faint" aria-hidden />
              {m.approvalsEmpty}
            </p>
          ) : (
            <motion.ul initial="initial" animate="animate" variants={stagger(0.04)} className="flex flex-col gap-2 px-3">
              <AnimatePresence initial={false}>
                {visible.map((a) =>
                  a.production ? (
                    <ProductionApproval key={a.id} approval={a} />
                  ) : (
                    <motion.li key={a.id} variants={variants.listItem} exit={variants.dismissRight.exit} layout="position">
                      <ApprovalCard approval={a} variant="compact" />
                    </motion.li>
                  ),
                )}
              </AnimatePresence>
              {approvals.length > MAX_APPROVALS && (
                <li>
                  <button
                    type="button"
                    onClick={() => void showMainWindow("/approvals")}
                    className="flex w-full items-center justify-center gap-1 rounded-md py-1.5 text-xs text-fg-muted outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
                  >
                    {m.viewAll(approvals.length)}
                    <ChevronRight className="size-3.5" aria-hidden />
                  </button>
                </li>
              )}
            </motion.ul>
          )}
        </motion.section>

        <motion.section variants={variants.fadeUp} aria-label={m.agents}>
          <SectionTitle>{m.agents}</SectionTitle>
          {sessions.length === 0 ? (
            <p className="px-4 text-xs text-fg-muted">{m.agentsEmpty}</p>
          ) : (
            <ul className="flex flex-col px-2">
              {sessions.slice(0, 5).map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => void showMainWindow(`/sessions/${encodeURIComponent(x.id)}`)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]"
                  >
                    <StatusDot status={agentDotStatus(x.state)} tone={x.provider} size={12} />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{x.label ?? x.title ?? uiStrings.providers[x.provider]}</span>
                    <span className="shrink-0 text-2xs text-fg-muted">{uiStrings.agentState[x.state]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </motion.section>
      </motion.div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-line-subtle px-3 py-2.5">
        <Button size="sm" variant="ghost" icon={<AppWindow />} onClick={() => void showMainWindow()}>
          {m.openApp}
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="primary" icon={<Plus />} onClick={() => void showMainWindow("/?new=1")}>
          {m.newTask}
        </Button>
      </footer>
    </WindowSurface>
  );
}
