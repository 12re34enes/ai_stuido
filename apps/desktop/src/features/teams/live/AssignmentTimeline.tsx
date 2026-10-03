/**
 * Gantt-like assignment timeline: a lane per member, a bar per assignment colored by status,
 * dependency connectors, a "now" line, and running bars that grow live (transform-only fill with
 * a glowing head). Hover a bar for details; click a bar or lane to focus that member.
 */
import { useMemo } from "react";

import { useNow } from "@/hooks/useNow";
import { formatDuration } from "@/i18n/format";
import { cn, ProviderMark, Tooltip } from "@/ui";

import { layoutTimeline, steppedEnd, tickStep, type TimelineBar } from "../model/timeline";
import { treeOrder } from "../model/tree";
import { assignmentStatusStrings, s } from "../strings";
import type { Provider } from "../types";
import { useLive } from "./context";

const ROW = 20;
const LANE_PAD = 6;
const LABEL_W = 168;

const timeFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });
const timeFmtSec = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function barTone(bar: TimelineBar, provider: Provider): string {
  switch (bar.status) {
    case "running":
      return provider === "codex" ? "bg-codex text-codex-surface" : "bg-claude text-fg-on-accent";
    case "testing":
      return "bg-info text-fg-on-accent";
    case "completed":
      return "bg-success/75 text-fg-on-accent";
    case "failed":
      return "bg-danger/85 text-fg-on-accent";
    default:
      return "border border-dashed border-line-strong bg-surface text-fg-muted";
  }
}

export function AssignmentTimeline({ className }: { className?: string }) {
  const { state, select, selected } = useLive();
  const spec = state.spec;
  const assignments = useMemo(() => state.order.map((id) => state.assignments[id]!).filter(Boolean), [state.assignments, state.order]);
  const anyLive = assignments.some((a) => !a.finished_at && (a.status === "running" || a.status === "testing" || a.status === "pending" || a.status === "blocked"));
  const now = useNow(1000, anyLive);
  const order = useMemo(() => (spec ? treeOrder(spec) : []), [spec]);
  const layout = useMemo(() => layoutTimeline(assignments, order, now), [assignments, now, order]);
  const members = useMemo(() => new Map((spec?.members ?? []).map((m) => [m.id, m])), [spec]);

  // The domain grows in steps so finished bars don't creep left every second.
  const first = layout.bars.length ? Math.min(...layout.bars.map((b) => b.start)) : layout.start;
  const last = layout.bars.length ? Math.max(...layout.bars.map((b) => b.end), anyLive ? now : -Infinity) : layout.end;
  const domainEnd = anyLive ? steppedEnd(first, Math.max(last, first + 60_000)) : Math.max(last, first + 60_000) + (Math.max(last, first + 60_000) - first) * 0.03;
  const start = first - (domainEnd - first) * 0.03;
  const end = domainEnd;
  const span = Math.max(1, end - start);
  const step = tickStep(span);
  const ticks: number[] = [];
  for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
  const fmt = step < 60_000 ? timeFmtSec : timeFmt;
  const x = (t: number) => ((t - start) / span) * 100;

  const laneTop: number[] = [];
  let acc = 0;
  for (const lane of layout.lanes) {
    laneTop.push(acc);
    acc += lane.rows * ROW + LANE_PAD;
  }
  const height = acc;
  const barById = new Map(layout.bars.map((b) => [b.id, b]));
  const barY = (b: TimelineBar) => laneTop[b.lane]! + LANE_PAD / 2 + b.row * ROW + ROW / 2;

  if (!layout.bars.length) {
    return <p className={cn("px-5 py-4 text-center text-xs text-fg-faint", className)}>{s.live.timelineEmpty}</p>;
  }

  return (
    <div className={cn("flex flex-col", className)} role="group" aria-label={s.live.timeline} data-testid="team-timeline">
      <div className="flex max-h-[260px] overflow-y-auto overscroll-contain">
        <ul className="shrink-0 border-r border-line-subtle" style={{ width: LABEL_W }}>
          {layout.lanes.map((lane) => {
            const m = members.get(lane.memberId);
            return (
              <li key={lane.memberId} style={{ height: lane.rows * ROW + LANE_PAD }}>
                <button
                  type="button"
                  onClick={() => select(lane.memberId)}
                  aria-label={s.live.focusMember(m?.name ?? lane.memberId)}
                  className={cn(
                    "flex size-full items-center gap-2 px-4 text-left text-xs outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:shadow-[inset_var(--focus-ring)]",
                    selected === lane.memberId ? "text-fg" : "text-fg-muted",
                  )}
                >
                  {m && <ProviderMark provider={m.provider} size={12} label="" />}
                  <span className="truncate">{m?.name ?? lane.memberId}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="relative min-w-0 flex-1" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} aria-hidden className="absolute inset-y-0 w-px bg-line-subtle" style={{ left: `${x(t)}%` }} />
          ))}
          {layout.lanes.map((lane, i) => (
            <span key={lane.memberId} aria-hidden className={cn("absolute inset-x-0", selected === lane.memberId && "bg-accent-soft/40")} style={{ top: laneTop[i], height: lane.rows * ROW + LANE_PAD }} />
          ))}
          <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden preserveAspectRatio="none">
            {layout.links.map((l) => {
              const a = barById.get(l.from);
              const b = barById.get(l.to);
              if (!a || !b) return null;
              return (
                <line key={l.id} x1={`${x(a.end)}%`} y1={barY(a)} x2={`${x(b.start)}%`} y2={barY(b)} strokeWidth={1} strokeDasharray="2 3" className="stroke-fg-faint" />
              );
            })}
          </svg>
          {layout.bars.map((b) => {
            const m = members.get(b.memberId);
            const provider = m?.provider ?? "claude";
            const left = x(b.start);
            const a = state.assignments[b.id];
            const from = a ? (members.get(a.from_member)?.name ?? (a.from_member === "engine" ? s.live.engine : a.from_member)) : "";
            const dur = formatDuration(b.end - b.start);
            const growing = b.live && !b.waiting;
            // Live bars span to the end of the domain and reveal their fill by translation.
            const width = growing ? 100 - left : Math.max(0.6, x(b.end) - left);
            const fill = growing ? Math.max(0.004, (b.end - b.start) / Math.max(1, end - b.start)) : 1;
            return (
              <Tooltip
                key={b.id}
                side="top"
                content={
                  <span className="flex max-w-64 flex-col gap-0.5">
                    <span className="font-medium">{b.title}</span>
                    <span className="opacity-80">
                      {s.live.from(from)} · {assignmentStatusStrings[b.status]} · {dur}
                      {b.round > 1 ? ` · ${s.live.testRound(b.round)}` : ""}
                    </span>
                    {a?.depends_on.length ? <span className="opacity-80">{s.live.dependsOn(a.depends_on.length)}</span> : null}
                    {a?.result_summary && <span className="opacity-80">{a.result_summary}</span>}
                    {a?.error && <span className="opacity-90">{a.error}</span>}
                    {a?.merge?.status === "conflict" && <span className="opacity-90">{s.live.conflicts(a.merge.conflicts.length)}</span>}
                  </span>
                }
              >
                <button
                  type="button"
                  onClick={() => select(b.memberId)}
                  aria-label={`${b.title} · ${assignmentStatusStrings[b.status]} · ${dur}`}
                  className="absolute overflow-hidden rounded-[5px] outline-none focus-visible:shadow-[var(--focus-ring)]"
                  style={{ left: `${left}%`, width: `${width}%`, top: barY(b) - 7, height: 14 }}
                  data-testid={`timeline-bar-${b.id}`}
                  data-status={b.status}
                >
                  <span
                    className={cn("absolute inset-0 flex items-center overflow-hidden rounded-[5px] px-1.5 text-[10px] leading-none font-medium whitespace-nowrap transition-[transform,background-color] duration-700 ease-linear", barTone(b, provider))}
                    style={growing ? { transform: `translateX(-${(1 - fill) * 100}%)` } : undefined}
                  >
                    <span className="truncate" style={growing ? { marginLeft: `${(1 - fill) * 100}%` } : undefined}>
                      {b.title}
                    </span>
                    {growing && <span aria-hidden className="absolute top-1/2 right-0.5 size-2 -translate-y-1/2 rounded-full bg-fg-on-accent/80 shadow-[0_0_6px_var(--fg-on-accent)]" />}
                  </span>
                </button>
              </Tooltip>
            );
          })}
          {anyLive && now >= start && now <= end && <span aria-hidden className="absolute inset-y-0 w-px bg-accent/70" style={{ left: `${x(now)}%` }} />}
        </div>
      </div>
      <div className="relative ml-[168px] h-5 border-t border-line-subtle">
        {ticks.map((t) => (
          <span key={t} className="absolute top-1 -translate-x-1/2 text-[10px] text-fg-faint tabular" style={{ left: `${x(t)}%` }}>
            {fmt.format(t)}
          </span>
        ))}
      </div>
    </div>
  );
}
