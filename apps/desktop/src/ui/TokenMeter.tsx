/**
 * Token usage with rolling digits ("48,2 B giriş · 6,1 B çıkış" or a single total) and a tooltip
 * that breaks it down exactly (input, output, cache, reasoning).
 */
import type { ReactNode } from "react";

import { formatCompact, formatNumber } from "@/i18n/format";
import type { Usage } from "@/lib/types";

import { AnimatedNumber } from "./AnimatedNumber";
import { cn } from "./cn";
import { contextStrings as t, totalTokens } from "./contextWindow";
import { Tooltip } from "./Tooltip";

export interface TokenMeterProps {
  usage: Pick<Usage, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "reasoning_tokens"> | null | undefined;
  /** `split`: input · output (default); `total`: one number with "token". */
  variant?: "split" | "total";
  /** Leading icon (e.g. a small glyph in dense rows). */
  icon?: ReactNode;
  tooltip?: boolean;
  className?: string;
}

function Row({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <span className={cn("flex items-baseline justify-between gap-4 tabular", strong && "font-medium")}>
      <span className={strong ? undefined : "text-tooltip-fg/75"}>{label}</span>
      <span>{formatNumber(value)}</span>
    </span>
  );
}

export function TokenBreakdown({ usage }: { usage: NonNullable<TokenMeterProps["usage"]> }) {
  const extra: [string, number | undefined][] = [
    [t.cacheRead, usage.cache_read_tokens],
    [t.cacheWrite, usage.cache_write_tokens],
    [t.reasoning, usage.reasoning_tokens],
  ];
  return (
    <span className="flex min-w-44 flex-col gap-0.5 py-0.5">
      <span className="text-2xs text-tooltip-fg/70">{t.usage}</span>
      <Row label={t.input} value={usage.input_tokens ?? 0} />
      <Row label={t.output} value={usage.output_tokens ?? 0} />
      {extra.map(([label, v]) => (v ? <Row key={label} label={label} value={v} /> : null))}
      <span className="my-0.5 h-px bg-tooltip-fg/15" aria-hidden />
      <Row label={t.total} value={totalTokens(usage)} strong />
    </span>
  );
}

export function TokenMeter({ usage, variant = "split", icon, tooltip = true, className }: TokenMeterProps) {
  if (!usage || totalTokens(usage) === 0) return null;
  const content = (
    <span className={cn("inline-flex items-center gap-1 text-2xs whitespace-nowrap text-fg-muted tabular", className)}>
      {icon}
      {variant === "total" ? (
        <>
          <AnimatedNumber value={totalTokens(usage)} format={formatCompact} /> {t.tokens}
        </>
      ) : (
        <>
          <AnimatedNumber value={usage.input_tokens ?? 0} format={formatCompact} /> {t.inputShort}
          <span aria-hidden className="text-fg-faint">
            ·
          </span>
          <AnimatedNumber value={usage.output_tokens ?? 0} format={formatCompact} /> {t.outputShort}
        </>
      )}
    </span>
  );
  if (!tooltip) return content;
  return (
    <Tooltip content={<TokenBreakdown usage={usage} />} side="bottom">
      {content}
    </Tooltip>
  );
}
