/**
 * Replay transport: play/pause, playhead with key-moment markers on a spring-driven track,
 * hover preview (time + nearest moment), compressed-gap breaks, and 1×/2×/4×/8× speed.
 * The track is an ARIA slider (←/→ 1 s, PageUp/PageDown 10 s, Home/End).
 */
import { Pause, Play, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { formatTime } from "@/i18n/format";
import { spring, transition } from "@/motion/tokens";
import { cn, SegmentedControl } from "@/ui";

import type { KeyMoment, MomentKind, TimeGap } from "../replay";
import { clock, SPEEDS, type Speed } from "../replayClock";
import { s } from "../strings";


const markerTone: Record<MomentKind, string> = {
  start: "bg-fg-muted",
  end: "bg-fg-muted",
  handoff: "bg-accent",
  "gate-pass": "bg-success",
  "gate-fail": "bg-danger",
  error: "bg-danger",
  approval: "bg-warning",
  loop: "bg-warning",
  checkpoint: "bg-info",
};

export interface ScrubberMoment extends KeyMoment {
  pos: number;
}

export interface ScrubberProps {
  duration: number;
  pos: number;
  onSeek: (pos: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  speed: Speed;
  onSpeed: (s: Speed) => void;
  moments: ScrubberMoment[];
  gaps: TimeGap[];
  /** Real elapsed ms since the run started at a position. */
  elapsedAt: (pos: number) => number;
  /** Wall clock at a position (epoch ms). */
  timeAt: (pos: number) => number;
  live?: boolean;
}

export function Scrubber({ duration, pos, onSeek, playing, onTogglePlay, speed, onSpeed, moments, gaps, elapsedAt, timeAt, live }: ScrubberProps) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ pos: number; moment: ScrubberMoment | null } | null>(null);
  const dragging = useRef(false);
  const safe = Math.max(1, duration);
  const pct = Math.min(1, Math.max(0, pos / safe));
  const atEnd = pos >= duration - 1;

  const posFromEvent = (e: PointerEvent<HTMLDivElement>) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration;
  };

  const nearest = (p: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r) return null;
    const px = (m: ScrubberMoment) => Math.abs((m.pos - p) / safe) * r.width;
    let best: ScrubberMoment | null = null;
    for (const m of moments) if (px(m) <= 7 && (!best || px(m) < px(best))) best = m;
    return best;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "PageUp" || e.key === "PageDown" ? 10_000 : 1_000;
    let next: number | null = null;
    if (e.shiftKey) return; // moments are handled by the page
    if (e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "PageUp") next = pos + step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "PageDown") next = pos - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = duration;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    onSeek(Math.min(duration, Math.max(0, next)));
  };

  const hovered = hover?.moment ?? null;
  const hoverPos = hovered ? hovered.pos : (hover?.pos ?? null);

  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <motion.button
        type="button"
        onClick={onTogglePlay}
        aria-label={playing ? s.pause : atEnd ? s.restart : s.play}
        whileTap={{ scale: 0.9 }}
        transition={spring.snappy}
        className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-fg-on-accent shadow-1 outline-none transition-colors hover:bg-accent-hover focus-visible:shadow-[var(--focus-ring)]"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={playing ? "pause" : atEnd ? "restart" : "play"}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
            exit={{ opacity: 0, scale: 0.5, transition: transition.exit }}
            className="grid place-items-center"
          >
            {playing ? <Pause className="size-4" fill="currentColor" /> : atEnd ? <RotateCcw className="size-4" /> : <Play className="ml-0.5 size-4" fill="currentColor" />}
          </motion.span>
        </AnimatePresence>
      </motion.button>

      <span className="w-14 shrink-0 text-right font-mono text-xs text-fg tabular" aria-hidden>
        {clock(elapsedAt(pos))}
      </span>

      <div className="relative min-w-0 flex-1">
        <div
          ref={track}
          role="slider"
          tabIndex={0}
          aria-label={s.scrubber}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(pos)}
          aria-valuetext={`${clock(elapsedAt(pos))} · ${formatTime(timeAt(pos))}`}
          onKeyDown={onKey}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            onSeek(posFromEvent(e));
          }}
          onPointerMove={(e) => {
            const p = posFromEvent(e);
            setHover({ pos: p, moment: nearest(p) });
            if (dragging.current) onSeek(p);
          }}
          onPointerUp={(e) => {
            dragging.current = false;
            e.currentTarget.releasePointerCapture(e.pointerId);
            const m = nearest(posFromEvent(e));
            if (m) onSeek(m.pos);
          }}
          onPointerLeave={() => setHover(null)}
          className="group relative h-9 cursor-pointer rounded-md outline-none focus-visible:shadow-[var(--focus-ring)]"
        >
          {/* rail */}
          <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-surface-sunken">
            <motion.div className="absolute inset-0 origin-left rounded-full bg-accent/80" style={{ scaleX: pct }} />
          </div>
          {/* compressed gaps */}
          {gaps.map((g) => (
            <span
              key={g.from}
              aria-hidden
              title={s.gap(clock(g.realMs))}
              className="absolute top-1/2 h-2.5 -translate-y-1/2 rounded-[2px] bg-[repeating-linear-gradient(90deg,var(--line-strong)_0_2px,transparent_2px_4px)]"
              style={{ left: `${(g.from / safe) * 100}%`, width: `max(4px, ${((g.to - g.from) / safe) * 100}%)` }}
            />
          ))}
          {/* key moments */}
          {moments.map((m, i) => {
            const passed = m.pos <= pos;
            const small = m.kind === "handoff";
            return (
              <motion.span
                key={`${m.index}-${i}`}
                aria-hidden
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: hovered === m ? 1.6 : 1, opacity: passed ? 1 : 0.55 }}
                transition={hovered === m ? spring.bouncy : { ...spring.smooth, delay: Math.min(i, 30) * 0.012 }}
                className={cn("absolute top-[7px] -translate-x-1/2 rounded-full ring-2 ring-surface", markerTone[m.kind], small ? "size-1.5" : "size-2")}
                style={{ left: `${(m.pos / safe) * 100}%` }}
              />
            );
          })}
          {/* hover ghost */}
          {hoverPos !== null && (
            <span aria-hidden className="pointer-events-none absolute inset-y-1 w-px bg-fg/25" style={{ left: `${(hoverPos / safe) * 100}%` }} />
          )}
          {/* playhead: a full-width layer translated by the progress (transform only) */}
          <span aria-hidden className="pointer-events-none absolute inset-0" style={{ transform: `translateX(${pct * 100}%)` }}>
            <span className="absolute top-1/2 left-0 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-surface shadow-2 transition-transform duration-150 group-active:scale-125" />
          </span>
        </div>
        <AnimatePresence>
          {hoverPos !== null && (
            <motion.div
              key="tip"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: spring.snappy }}
              exit={{ opacity: 0, transition: { duration: 0.08 } }}
              className="pointer-events-none absolute bottom-full mb-1.5 max-w-72 -translate-x-1/2 rounded-md bg-tooltip px-2 py-1 text-2xs whitespace-nowrap text-tooltip-fg shadow-2"
              style={{ left: `${(hoverPos / safe) * 100}%` }}
            >
              <span className="font-mono tabular">{clock(elapsedAt(hoverPos))}</span>
              {hovered && <span className="ml-1.5 inline-block max-w-56 truncate align-bottom">{hovered.label}</span>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <span className="w-14 shrink-0 font-mono text-xs text-fg-faint tabular" aria-hidden>
        {clock(elapsedAt(duration))}
      </span>

      <SegmentedControl
        size="sm"
        aria-label={s.speed}
        value={String(speed)}
        onValueChange={(v) => onSpeed(Number(v) as Speed)}
        options={SPEEDS.map((x) => ({ value: String(x), label: `${x}×` }))}
      />
      {live && (
        <span className="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2 py-0.5 text-2xs font-medium text-danger">
          <span className="size-1.5 animate-[studio-breathe_var(--dur-pulse)_var(--ease-in-out)_infinite] rounded-full bg-danger" />
          {s.live}
        </span>
      )}
    </div>
  );
}
