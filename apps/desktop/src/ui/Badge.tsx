import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "./cn";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "claude" | "codex";
export type BadgeVariant = "soft" | "solid" | "outline";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  size?: "sm" | "md";
  /** Leading dot in the tone color. */
  dot?: boolean;
  icon?: ReactNode;
}

const soft: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-fg-muted",
  accent: "bg-accent-soft text-accent",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  claude: "bg-claude-soft text-claude-strong",
  codex: "bg-codex-soft text-codex",
};

const solid: Record<BadgeTone, string> = {
  neutral: "bg-fg-muted text-canvas",
  accent: "bg-accent text-fg-on-accent",
  success: "bg-success text-fg-on-accent",
  warning: "bg-warning text-fg-on-accent",
  danger: "bg-danger text-fg-on-accent",
  info: "bg-info text-fg-on-accent",
  claude: "bg-claude text-fg-on-accent",
  codex: "bg-codex text-codex-surface",
};

const outline: Record<BadgeTone, string> = {
  neutral: "border border-line text-fg-muted",
  accent: "border border-accent/40 text-accent",
  success: "border border-success/40 text-success",
  warning: "border border-warning/40 text-warning",
  danger: "border border-danger/40 text-danger",
  info: "border border-info/40 text-info",
  claude: "border border-claude-line text-claude-strong",
  codex: "border border-codex-line text-codex",
};

const dotColor: Record<BadgeTone, string> = {
  neutral: "bg-fg-faint",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  claude: "bg-claude",
  codex: "bg-codex",
};

export function Badge({ tone = "neutral", variant = "soft", size = "sm", dot, icon, className, children, ...rest }: BadgeProps) {
  const palette = variant === "solid" ? solid : variant === "outline" ? outline : soft;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full font-medium whitespace-nowrap",
        size === "sm" ? "h-[18px] px-1.5 text-2xs [&_svg]:size-3" : "h-[22px] px-2 text-xs [&_svg]:size-3.5",
        palette[tone],
        className,
      )}
      {...rest}
    >
      {dot && <span className={cn("size-1.5 rounded-full", variant === "solid" ? "bg-current" : dotColor[tone])} />}
      {icon}
      {children}
    </span>
  );
}
