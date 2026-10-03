import { Ban, CircleCheck, FilePen, Lock, OctagonX, Server, ShieldHalf, TriangleAlert, Wifi, WifiOff, type LucideIcon } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { createElement, type ReactNode } from "react";
import { Link } from "react-router";

import { spring, stagger, variants } from "@/motion/tokens";
import { cn, Skeleton } from "@/ui";

import { LoadError } from "@/features/studios/components/Page";

import { useBoundaries, useBoundaryWarnings } from "../api";
import { docHref } from "../links";
import { memoryStrings as s } from "../strings";
import type { Boundaries } from "../types";

type Tone = "danger" | "warning" | "success";

const chipTone: Record<Tone, string> = {
  danger: "border-danger/25 bg-danger-soft/60 text-danger",
  warning: "border-warning/30 bg-warning-soft/60 text-warning",
  success: "border-success/25 bg-success-soft/60 text-success",
};

const tileTone: Record<Tone, string> = {
  danger: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  success: "bg-success-soft text-success",
};

function Panel({ title, hint, icon, tone, children, className }: { title: string; hint: string; icon: LucideIcon; tone: Tone | "neutral"; children: ReactNode; className?: string }) {
  return (
    <motion.section variants={variants.fadeUp} aria-label={title} className={cn("flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-1", className)}>
      <header className="flex items-start gap-3">
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg [&_svg]:size-4", tone === "neutral" ? "bg-surface-sunken text-fg-muted" : tileTone[tone])}>
          {createElement(icon)}
        </span>
        <div className="flex flex-col gap-0.5">
          <h3 className="text-md leading-6 text-fg">{title}</h3>
          <p className="text-xs text-fg-muted">{hint}</p>
        </div>
      </header>
      {children}
    </motion.section>
  );
}

function Chips({ items, tone, icon }: { items: string[]; tone: Tone; icon: LucideIcon }) {
  if (items.length === 0) return <p className="text-xs text-fg-faint">{s.none}</p>;
  return (
    <motion.ul className="flex flex-wrap gap-1.5" initial="initial" animate="animate" variants={stagger(0.025, 0.1)}>
      {items.map((item) => (
        <motion.li
          key={item}
          variants={variants.pop}
          className={cn("inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-xs [&_svg]:size-3 [&_svg]:shrink-0", chipTone[tone])}
        >
          {createElement(icon, { "aria-hidden": true })}
          <span className="truncate text-fg">{item}</span>
        </motion.li>
      ))}
    </motion.ul>
  );
}

/** A level meter: every step shown, the current one lit (sliding pill), with its explanation. */
function Levels<T extends string>({ id, label, levels, value, labels, hints, danger }: { id: string; label: string; levels: T[]; value: T; labels: Record<string, string>; hints: Record<string, string>; danger?: T[] }) {
  const index = levels.indexOf(value);
  return (
    <div className="flex flex-col gap-3">
      <LayoutGroup id={id}>
        <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={levels.length - 1} aria-valuenow={index} aria-valuetext={labels[value]} className="grid gap-1 rounded-[10px] bg-surface-sunken p-1" style={{ gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` }}>
          {levels.map((l, i) => {
            const active = l === value;
            const hot = danger?.includes(l);
            return (
              <div key={l} className="relative flex h-8 items-center justify-center rounded-[7px] px-2 text-xs">
                {active && (
                  <motion.span
                    layoutId="level"
                    transition={spring.layout}
                    className={cn("absolute inset-0 rounded-[7px] shadow-1", hot ? "bg-danger-soft ring-1 ring-danger/30" : "bg-surface")}
                  />
                )}
                <span className={cn("relative truncate", active ? (hot ? "font-medium text-danger" : "font-medium text-fg") : i < index ? "text-fg-muted" : "text-fg-faint")}>{labels[l]}</span>
              </div>
            );
          })}
        </div>
      </LayoutGroup>
      <AnimatePresence mode="wait" initial={false}>
        <motion.p key={value} {...variants.fade} className="text-xs text-fg-muted">
          {hints[value]}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

function NetworkState({ on }: { on: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <motion.span
        key={String(on)}
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={spring.bouncy}
        className={cn("grid size-10 place-items-center rounded-full [&_svg]:size-5", on ? "bg-success-soft text-success" : "bg-surface-sunken text-fg-muted")}
      >
        {on ? <Wifi /> : <WifiOff />}
      </motion.span>
      <div className="flex flex-col">
        <span className="text-sm font-medium text-fg">{on ? s.networkOn : s.networkOff}</span>
        <span className="text-xs text-fg-muted">{on ? s.networkOnHint : s.networkOffHint}</span>
      </div>
    </div>
  );
}

export function BoundariesView({ b }: { b: Boundaries }) {
  return (
    <motion.div className="grid grid-cols-1 gap-4 lg:grid-cols-2" initial="initial" animate="animate" variants={stagger(0.05)}>
      <Panel title={s.forbidden} hint={s.forbiddenHint} icon={Ban} tone="danger">
        <Chips items={b.forbidden_paths} tone="danger" icon={Ban} />
      </Panel>
      <Panel title={s.readonly} hint={s.readonlyHint} icon={Lock} tone="warning">
        <Chips items={b.readonly_paths} tone="warning" icon={Lock} />
      </Panel>
      <Panel title={s.allowed} hint={s.allowedHint} icon={CircleCheck} tone="success">
        <Chips items={b.allowed_commands} tone="success" icon={CircleCheck} />
      </Panel>
      <Panel title={s.denied} hint={s.deniedHint} icon={OctagonX} tone="danger">
        <Chips items={b.denied_commands} tone="danger" icon={OctagonX} />
      </Panel>
      <Panel title={s.network} hint={s.networkHint} icon={b.network ? Wifi : WifiOff} tone="neutral">
        <NetworkState on={b.network} />
      </Panel>
      <Panel title={s.sandbox} hint={s.sandboxHints[b.sandbox] ?? ""} icon={ShieldHalf} tone="neutral">
        <Levels id="sandbox" label={s.sandbox} levels={["read_only", "workspace_write", "full"]} value={b.sandbox} labels={s.sandboxLevels} hints={s.sandboxHints} danger={["full"]} />
      </Panel>
      <Panel title={s.remote} hint={s.remoteHints[b.remote_access] ?? ""} icon={Server} tone="neutral" className="lg:col-span-2">
        <Levels id="remote" label={s.remote} levels={["none", "read", "limited", "full"]} value={b.remote_access} labels={s.remoteLevels} hints={s.remoteHints} danger={["full"]} />
      </Panel>
    </motion.div>
  );
}

export function BoundariesPage({ ws }: { ws: string }) {
  const { data, isPending, isError, error, refetch } = useBoundaries(ws);
  const { data: warnings } = useBoundaryWarnings(ws);
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-6 px-10 pt-8 pb-20">
      <header className="flex items-end justify-between gap-6">
        <div className="flex max-w-[600px] flex-col gap-1.5">
          <h2 className="text-2xl text-fg">{s.boundariesTitle}</h2>
          <p className="text-sm text-fg-muted">{s.boundariesSubtitle}</p>
        </div>
        <Link
          to={docHref("boundaries.md", "edit")}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-sm font-medium text-fg outline-none transition-colors hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)] [&_svg]:size-4"
        >
          <FilePen />
          {s.editBoundaries}
        </Link>
      </header>
      <AnimatePresence initial={false}>
        {warnings && warnings.length > 0 && (
          <motion.div key="warnings" {...variants.fadeUp} role="alert" className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-soft/60 px-4 py-3">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-fg">{s.boundariesWarnings}</span>
              <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {isError && !data ? (
        <LoadError title={s.boundariesLoadError} error={error} onRetry={() => void refetch()} className="mt-8" />
      ) : isPending ? (
        <div className="grid grid-cols-2 gap-4" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={140} className="rounded-xl" />
          ))}
        </div>
      ) : (
        <BoundariesView b={data} />
      )}
    </div>
  );
}
