/**
 * Model and effort chips with explanatory tooltips (agent cards, panels, hover cards).
 * Provider language: Claude soft and rounded, Codex mono and sharp.
 */
import { Gauge } from "lucide-react";

import { formatNumber } from "@/i18n/format";
import type { Provider } from "@/lib/types";
import { cn, Tooltip, uiStrings } from "@/ui";

import { sessionStrings } from "../strings";

const c = sessionStrings.chips;

export function ModelChip({ model, provider, contextWindow, className }: { model: string | null | undefined; provider: Provider; contextWindow?: number | null; className?: string }) {
  if (!model) return null;
  return (
    <Tooltip content={c.modelTip(uiStrings.providers[provider], contextWindow ? formatNumber(contextWindow) : null)} side="top">
      <span className={cn("min-w-0 truncate", provider === "codex" && "font-mono", className)}>{model}</span>
    </Tooltip>
  );
}

/** Normalized effort level key ("XHigh" → "xhigh"). */
function effortKey(effort: string): string {
  return effort.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function EffortChip({ effort, provider, className }: { effort: string | null | undefined; provider: Provider; className?: string }) {
  if (!effort?.trim()) return null;
  const key = effortKey(effort);
  const level = c.effortLevels[key] ?? effort;
  const hint = c.effortHints[key] ?? c.effortUnknown;
  return (
    <Tooltip content={c.effortTip(level, hint)} side="top">
      <span
        className={cn(
          "inline-flex h-[18px] shrink-0 items-center gap-1 px-1.5 text-2xs font-medium",
          provider === "claude" ? "rounded-full bg-claude-soft text-claude-strong" : "rounded-[3px] border border-codex-line font-mono text-codex",
          className,
        )}
      >
        <Gauge className="size-3" aria-hidden />
        <span className="sr-only">{c.effort}:</span>
        {key}
      </span>
    </Tooltip>
  );
}
