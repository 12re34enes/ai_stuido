/** Replay model: speeds, playback timing and the position reducer (pure). */
import type { StudioEvent } from "@/lib/events";

import { emptyStream, foldEvents, type StreamState } from "./model";

export const REPLAY_SPEEDS = ["1", "2", "4", "8"] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Delay before showing event `next` after `prev` (ms): real gaps, scaled and capped. */
export function replayDelay(prev: StudioEvent | undefined, next: StudioEvent | undefined, speed: number): number {
  if (!prev || !next) return 0;
  const gap = Math.max(0, Date.parse(next.ts) - Date.parse(prev.ts));
  return Math.round(Math.min(Math.max(gap, 60), 1200) / Math.max(1, speed));
}

export interface ReplayState {
  /** Events shown (prefix length); null = all. */
  pos: number | null;
  view: StreamState | null;
  playing: boolean;
  speed: ReplaySpeed;
}

export type ReplayAction =
  | { type: "seek"; pos: number; events: readonly StudioEvent[]; sessionId: string }
  | { type: "step"; events: readonly StudioEvent[]; sessionId: string }
  | { type: "playing"; playing: boolean }
  | { type: "speed"; speed: ReplaySpeed };

export const INITIAL_REPLAY: ReplayState = { pos: null, view: null, playing: false, speed: "2" };

export function replayReducer(s: ReplayState, a: ReplayAction): ReplayState {
  switch (a.type) {
    case "seek": {
      if (a.pos >= a.events.length) return { ...s, pos: null, view: null };
      const pos = Math.max(0, a.pos);
      return { ...s, pos, view: foldEvents(emptyStream(), a.events.slice(0, pos), { sessionId: a.sessionId }) };
    }
    case "step": {
      const from = s.pos ?? a.events.length;
      const next = from + 1;
      if (from >= a.events.length) return { ...s, playing: false };
      const view = foldEvents(s.view ?? emptyStream(), a.events.slice(from, next), { live: true, sessionId: a.sessionId });
      return next >= a.events.length ? { ...s, pos: null, view: null, playing: false } : { ...s, pos: next, view };
    }
    case "playing":
      return { ...s, playing: a.playing };
    case "speed":
      return { ...s, speed: a.speed };
  }
}
