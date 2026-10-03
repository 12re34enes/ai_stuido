/**
 * Live event stream from studiod (`/ws/events`), mirrored from backend `core/events.py`.
 *
 * - Reconnects with backoff and resumes from the last persisted id (no gaps, no dupes).
 * - Delivers events in batches once per animation frame, so a burst of token deltas
 *   causes one React update per frame instead of hundreds.
 */
import { useEffect, useRef } from "react";

import { wsUrl } from "./backend";

export type Severity = "info" | "normal" | "high" | "critical";

export interface StudioEvent<P = Record<string, unknown>> {
  /** 0 for ephemeral events (token deltas). */
  id: number;
  ts: string;
  type: string;
  severity: Severity;
  actor: string;
  workspace_id: string | null;
  task_id: string | null;
  run_id: string | null;
  session_id: string | null;
  payload: P;
  ephemeral: boolean;
}

export interface EventFilter {
  types?: string[];
  workspace_id?: string;
  task_id?: string;
  run_id?: string;
  session_id?: string;
  ephemeral?: boolean;
  /** Replay persisted events after this id first (0 = full history). Omit for live-only. */
  after?: number;
}

type Listener = (batch: StudioEvent[]) => void;
type Status = "connecting" | "open" | "closed";

export class EventStream {
  private ws: WebSocket | null = null;
  private lastId: number | undefined;
  private buffer: StudioEvent[] = [];
  private frame: number | null = null;
  private retry = 0;
  private closed = false;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: Status) => void>();
  status: Status = "connecting";

  constructor(private readonly filter: EventFilter = {}) {
    this.lastId = filter.after;
    void this.connect();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: (s: Status) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  close(): void {
    this.closed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.ws?.close();
    this.setStatus("closed");
  }

  private setStatus(s: Status) {
    this.status = s;
    for (const fn of this.statusListeners) fn(s);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    this.setStatus("connecting");
    let url: string;
    try {
      url = await wsUrl("/ws/events", {
        types: this.filter.types?.join(","),
        workspace_id: this.filter.workspace_id,
        task_id: this.filter.task_id,
        run_id: this.filter.run_id,
        session_id: this.filter.session_id,
        ephemeral: this.filter.ephemeral === false ? "0" : undefined,
        after: this.lastId,
      });
    } catch {
      this.scheduleReconnect();
      return;
    }
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus("open");
    };
    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data as string) as
        | { kind: "event"; event: StudioEvent }
        | { kind: "ready"; last_id: number }
        | { kind: "lagged" };
      if (data.kind === "event") {
        if (data.event.id > 0) this.lastId = data.event.id;
        this.enqueue(data.event);
      } else if (data.kind === "ready") {
        if (this.lastId === undefined) this.lastId = data.last_id;
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.closed) this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    this.setStatus("connecting");
    const delay = Math.min(10_000, 250 * 2 ** this.retry++);
    setTimeout(() => void this.connect(), delay);
  }

  private enqueue(ev: StudioEvent) {
    this.buffer.push(ev);
    if (this.frame === null) {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        const batch = this.buffer;
        this.buffer = [];
        for (const fn of this.listeners) fn(batch);
      });
    }
  }
}

/**
 * Subscribe a component to events. `onBatch` is called once per frame with new events.
 * The connection is re-created when the filter changes (compared by value).
 */
export function useEventStream(filter: EventFilter | null, onBatch: Listener): void {
  const handler = useRef(onBatch);
  useEffect(() => {
    handler.current = onBatch;
  });
  const key = filter ? JSON.stringify(filter) : null;
  useEffect(() => {
    if (key === null) return;
    const stream = new EventStream(JSON.parse(key) as EventFilter);
    const off = stream.subscribe((batch) => handler.current(batch));
    return () => {
      off();
      stream.close();
    };
  }, [key]);
}

export function matchesType(type: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.endsWith(".*") ? type.startsWith(p.slice(0, -1)) : type === p));
}
