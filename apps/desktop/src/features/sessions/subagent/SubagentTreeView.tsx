/**
 * The subagent tree, drawn from nodes (no data fetching here): connector lines that draw in,
 * status dots that morph, a shimmering live line while a subagent works, tokens, tool calls and
 * duration. `full` for the stream rail, `dense` for popovers. Long trees virtualize.
 */
import "./subagent.css";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, Wrench } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { formatCompact, formatDuration, formatNumber } from "@/i18n/format";
import type { Provider } from "@/lib/types";
import { duration, spring, transition, variants } from "@/motion/tokens";
import { cn, StatusDot, Tooltip } from "@/ui";

import { sessionStrings } from "../strings";
import { subagentDot, subagentName } from "./format";
import { buildSubagentTree, flattenTree, subagentDuration, type FlatRow, type SubagentNode } from "./model";

const t = sessionStrings.subagents;

const INDENT = 16;
const DOT = 12;
const CENTER = DOT / 2;
/** Rows above this count render through the virtualizer (no enter/exit choreography). */
const VIRTUAL_AT = 60;

export type SubagentTreeVariant = "full" | "dense";

export interface SubagentTreeViewProps {
  nodes: readonly SubagentNode[];
  provider?: Provider;
  variant?: SubagentTreeVariant;
  onSelect?: (subagentId: string) => void;
  /** Highlighted node (e.g. the one just jumped to). */
  selectedId?: string | null;
  /** Max height of the scroll area (CSS length); the view scrolls inside it. */
  maxHeight?: number | string;
  className?: string;
  "aria-label"?: string;
}

const chipLook: Record<Provider | "none", string> = {
  claude: "rounded-full bg-claude-soft text-claude-strong",
  codex: "rounded-[3px] border border-codex-line bg-codex-soft font-mono text-codex",
  none: "rounded-full bg-surface-sunken text-fg-muted",
};

export function SubagentChip({ name, model, provider, className }: { name: string | null; model?: string | null; provider?: Provider; className?: string }) {
  const chip = (
    <span
      className={cn(
        "inline-flex h-[18px] max-w-[11rem] shrink-0 items-center truncate px-1.5 text-2xs leading-[18px] font-medium",
        chipLook[provider ?? "none"],
        className,
      )}
    >
      <span className="truncate">{subagentName(name)}</span>
    </span>
  );
  return model ? (
    <Tooltip content={`${t.model}: ${model}`} side="top">
      {chip}
    </Tooltip>
  ) : (
    chip
  );
}

// ----------------------------------------------------------------------------- connectors

function Connectors({ row, dotY, enter, delay }: { row: FlatRow; dotY: number; enter: boolean; delay: number }) {
  const draw = (axis: "x" | "y") =>
    enter
      ? {
          initial: axis === "y" ? { scaleY: 0 } : { scaleX: 0 },
          animate: axis === "y" ? { scaleY: 1 } : { scaleX: 1 },
          transition: { ...spring.smooth, delay },
        }
      : { initial: false as const };
  const hasKids = row.childCount > 0 && !row.collapsed;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0" style={{ width: row.depth * INDENT + DOT }}>
      {row.guides.map((g, i) => (g ? <span key={i} className="absolute inset-y-0 w-px bg-line-strong" style={{ left: i * INDENT + CENTER }} /> : null))}
      {row.depth > 0 && (
        <>
          <motion.span
            {...draw("y")}
            className="absolute top-0 w-px origin-top bg-line-strong"
            style={{ left: (row.depth - 1) * INDENT + CENTER, height: row.last ? dotY : "100%" }}
          />
          <motion.span
            {...draw("x")}
            className="absolute h-px origin-left bg-line-strong"
            style={{ left: (row.depth - 1) * INDENT + CENTER, top: dotY, width: INDENT - CENTER - 2 }}
          />
        </>
      )}
      {hasKids && (
        <motion.span
          {...draw("y")}
          className="absolute bottom-0 w-px origin-top bg-line-strong"
          style={{ left: row.depth * INDENT + CENTER, top: dotY + CENTER + 2 }}
        />
      )}
    </span>
  );
}

// ----------------------------------------------------------------------------- row

interface RowProps {
  row: FlatRow;
  variant: SubagentTreeVariant;
  provider?: Provider;
  now: number;
  enter: boolean;
  index: number;
  selected: boolean;
  onSelect?: (id: string) => void;
  onToggle: (id: string) => void;
}

function LiveLine({ node, dense }: { node: SubagentNode; dense: boolean }) {
  const running = node.status === "running";
  const text = node.lastText ?? (running ? t.waitingFirst : null);
  if (!text) return null;
  return (
    <span
      className={cn(
        "block min-w-0 truncate",
        dense ? "text-2xs" : "text-xs",
        node.waiting && running ? "text-warning" : running ? "text-fg-muted" : node.status === "error" ? "text-danger/90" : "text-fg-faint",
      )}
      data-selectable
    >
      {/* The shimmer hugs the text (an inline box), not the whole row. */}
      <span className={cn(running && "subagent-shimmer truncate")}>{text}</span>
    </span>
  );
}

function Meta({ node, now, dense }: { node: SubagentNode; now: number; dense: boolean }) {
  const total = node.inputTokens + node.outputTokens;
  const ms = subagentDuration(node, now);
  return (
    <span className={cn("flex min-w-0 items-center gap-2 text-2xs whitespace-nowrap text-fg-faint tabular", dense && "gap-1.5")}>
      {total > 0 && (
        <Tooltip content={`${formatNumber(node.inputTokens)} giriş · ${formatNumber(node.outputTokens)} çıkış`} side="top">
          <span>{t.tokens(formatCompact(total))}</span>
        </Tooltip>
      )}
      {node.toolCalls > 0 && (
        <Tooltip content={t.toolCalls(node.toolCalls)} side="top">
          <span className="inline-flex items-center gap-0.5">
            <Wrench className="size-2.5" aria-hidden />
            {node.toolCalls}
          </span>
        </Tooltip>
      )}
      {!dense && ms !== null && <span>{formatDuration(ms)}</span>}
    </span>
  );
}

function TreeRow({ row, variant, provider, now, enter, index, selected, onSelect, onToggle }: RowProps) {
  const { node } = row;
  const dense = variant === "dense";
  const dotY = dense ? 10 : 12;
  const ms = subagentDuration(node, now);
  const statusText = [t.status[node.status], ms !== null ? formatDuration(ms) : null].filter(Boolean).join(" · ");
  const label = [subagentName(node.name), node.description, t.status[node.status]].filter(Boolean).join(" · ");
  const body = (
    <>
      <Tooltip content={statusText} side="left">
        <span className="relative z-[1] grid shrink-0 place-items-center" style={{ width: DOT, height: DOT, marginTop: dotY - CENTER - (dense ? 4 : 6) }}>
          <StatusDot
            status={node.waiting && node.status === "running" ? "waiting" : subagentDot[node.status]}
            tone={provider ?? "accent"}
            size={DOT}
            label={node.waiting ? t.waiting : t.status[node.status]}
          />
        </span>
      </Tooltip>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <SubagentChip name={node.name} model={node.model} provider={provider} />
          <span className={cn("min-w-0 flex-1 truncate text-fg", dense ? "text-xs" : "text-sm")}>{node.description ?? t.noDescription}</span>
          {dense && <Meta node={node} now={now} dense />}
        </span>
        {(!dense || node.status === "running" || node.status === "error") && <LiveLine node={node} dense={dense} />}
        {!dense && <Meta node={node} now={now} dense={false} />}
      </span>
    </>
  );
  return (
    <div
      className="relative"
      style={{ paddingLeft: row.depth * INDENT }}
      data-subagent-id={node.id}
      data-status={node.status}
      data-waiting={node.waiting ? "true" : undefined}
      data-depth={row.depth}
    >
      <Connectors row={row} dotY={dotY} enter={enter} delay={Math.min(index * (duration.micro / 4), duration.page)} />
      <div className={cn("relative flex min-w-0 items-start", dense ? "py-1" : "py-1.5")}>
        {onSelect ? (
          <button
            type="button"
            onClick={() => onSelect(node.id)}
            aria-label={`${label} — ${t.jump}`}
            className={cn(
              "-my-0.5 flex min-w-0 flex-1 items-start gap-2 rounded-md py-0.5 pr-1.5 text-left outline-none transition-colors duration-150",
              "hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]",
              selected && "bg-accent-soft/60",
            )}
          >
            {body}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2 pr-1.5">
            {body}
          </div>
        )}
        {row.childCount > 0 && (
          <Tooltip content={row.collapsed ? t.expandTree : t.collapseTree} side="left">
            <button
              type="button"
              onClick={() => onToggle(node.id)}
              aria-expanded={!row.collapsed}
              aria-label={`${row.collapsed ? t.expandTree : t.collapseTree}: ${t.nested(row.childCount)}`}
              className="relative z-[1] mt-0.5 flex h-5 shrink-0 items-center gap-0.5 rounded-md px-1 text-2xs text-fg-faint outline-none hover:bg-surface-hover hover:text-fg-muted focus-visible:shadow-[var(--focus-ring)]"
            >
              {row.collapsed && row.activeBelow > 0 && <span className="size-1.5 rounded-full bg-accent" aria-hidden />}
              {row.collapsed && <span className="tabular">{row.childCount}</span>}
              <motion.span animate={{ rotate: row.collapsed ? 0 : 90 }} transition={spring.snappy} className="flex">
                <ChevronRight className="size-3" aria-hidden />
              </motion.span>
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- view

export function SubagentTreeView({
  nodes,
  provider,
  variant = "full",
  onSelect,
  selectedId,
  maxHeight,
  className,
  "aria-label": ariaLabel,
}: SubagentTreeViewProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => flattenTree(buildSubagentTree(nodes), collapsed), [collapsed, nodes]);
  const running = nodes.some((n) => n.status === "running");
  const now = useNow(1000, running);
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length > VIRTUAL_AT;
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // TanStack Virtual is not React-Compiler-memoizable (warning only).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (variant === "dense" ? 30 : 62),
    getItemKey: (i) => rows[i]?.node.id ?? i,
    overscan: 8,
  });

  // Keyed rows mount once, so connectors draw in exactly when a row appears (virtualized rows
  // remount while scrolling: no draw-in there).
  const renderRow = (row: FlatRow, index: number) => {
    return (
      <TreeRow
        row={row}
        variant={variant}
        provider={provider}
        now={now}
        enter={!virtual}
        index={index}
        selected={selectedId === row.node.id}
        onSelect={onSelect}
        onToggle={toggle}
      />
    );
  };

  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label={ariaLabel ?? t.tree}
      className={cn("min-h-0 overflow-y-auto overscroll-contain", className)}
      style={{ maxHeight }}
    >
      {virtual ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            return (
              <div key={v.key} ref={virtualizer.measureElement} data-index={v.index} className="absolute top-0 left-0 w-full" style={{ transform: `translateY(${v.start}px)` }}>
                {renderRow(row, v.index)}
              </div>
            );
          })}
        </div>
      ) : (
        <motion.ul layout="position" transition={spring.layout} className="flex flex-col">
          <AnimatePresence>
            {rows.map((row, i) => (
              <motion.li
                key={row.node.id}
                layout="position"
                variants={variants.listItem}
                initial="initial"
                animate="animate"
                exit={{ opacity: 0, transition: transition.exit }}
                transition={spring.layout}
                className="list-none"
              >
                {renderRow(row, i)}
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      )}
    </div>
  );
}
