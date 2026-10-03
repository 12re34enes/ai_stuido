/** Display helpers for subagents (labels, status → dot, chip text). */
import type { KeyboardEvent, MouseEvent } from "react";

import type { DotStatus } from "@/ui";

import { sessionStrings } from "../strings";
import type { SubagentStatus, SubagentSummary } from "./model";

const t = sessionStrings.subagents;

export const subagentDot: Record<SubagentStatus, DotStatus> = {
  running: "running",
  success: "success",
  error: "error",
  interrupted: "offline",
};

/** "3 alt ajan · 1 çalışıyor · 1 hatalı" (running and failed only when non-zero). */
export function subagentSummaryLabel(s: Pick<SubagentSummary, "total" | "running" | "error">): string {
  return [t.count(s.total), s.running > 0 ? t.running(s.running) : null, s.error > 0 ? t.failed(s.error) : null].filter(Boolean).join(" · ");
}

/** The type chip ("general-purpose", "explorer"); falls back to "alt ajan". */
export function subagentName(name: string | null | undefined): string {
  return name?.trim() || t.unnamed;
}

/** Stop a click / Enter / Space inside a clickable card (or its portaled popover) from
 *  activating the card: React bubbles portal events through the component tree. */
export const stopCard = {
  onClick: (e: MouseEvent) => e.stopPropagation(),
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") e.stopPropagation();
  },
};
