/**
 * Replay scrubber (spec §18 "Oturum tekrar oynatma"): play/pause, restart, speed and a position
 * slider over the persisted events. Playback follows the real gaps between events, scaled by
 * the speed and capped so idle stretches never stall it.
 */
import { Pause, Play, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";

import { formatTime } from "@/i18n/format";
import type { StudioEvent } from "@/lib/events";
import { spring, transition } from "@/motion/tokens";
import { IconButton, SegmentedControl } from "@/ui";

import { sessionStrings as t } from "../strings";
import { REPLAY_SPEEDS, replayDelay, type ReplaySpeed } from "./replay";

const r = t.stream.replay;
export interface ReplayBarProps {
  events: StudioEvent[];
  position: number;
  playing: boolean;
  speed: ReplaySpeed;
  onPosition: (p: number) => void;
  onStep: () => void;
  onPlaying: (p: boolean) => void;
  onSpeed: (s: ReplaySpeed) => void;
}

export function ReplayBar({ events, position, playing, speed, onPosition, onStep, onPlaying, onSpeed }: ReplayBarProps) {
  const total = events.length;
  const atEnd = position >= total;

  useEffect(() => {
    if (!playing || atEnd) return;
    const delay = replayDelay(events[position - 1], events[position], Number(speed));
    const timer = setTimeout(onStep, delay);
    return () => clearTimeout(timer);
  }, [atEnd, events, onStep, playing, position, speed]);

  const current = events[Math.max(0, position - 1)];
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-t border-line-subtle bg-canvas-subtle px-6" role="group" aria-label={r.title}>
      <IconButton label={r.restart} icon={<RotateCcw />} size="md" onClick={() => onPosition(0)} disabled={total === 0} />
      <IconButton
        label={playing ? r.pause : r.play}
        variant="secondary"
        size="lg"
        disabled={total === 0}
        onClick={() => {
          if (atEnd) onPosition(0);
          onPlaying(!playing);
        }}
        icon={
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={playing ? "pause" : "play"}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: spring.snappy }}
              exit={{ opacity: 0, scale: 0.6, transition: transition.exit }}
              className="flex"
            >
              {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
            </motion.span>
          </AnimatePresence>
        }
      />
      <input
        type="range"
        min={0}
        max={total}
        step={1}
        value={position}
        aria-label={r.position}
        aria-valuetext={r.step(position, total)}
        onChange={(e) => {
          onPlaying(false);
          onPosition(Number(e.target.value));
        }}
        className="h-1 min-w-0 flex-1 cursor-default accent-[var(--accent)]"
      />
      <span className="w-20 shrink-0 text-right text-2xs text-fg-muted tabular">{r.step(position, total)}</span>
      <span className="w-12 shrink-0 text-2xs text-fg-faint tabular">{current ? formatTime(current.ts) : "—"}</span>
      <SegmentedControl
        size="sm"
        aria-label={r.speed}
        value={speed}
        onValueChange={onSpeed}
        options={REPLAY_SPEEDS.map((s) => ({ value: s, label: `${s}×` }))}
      />
    </div>
  );
}
