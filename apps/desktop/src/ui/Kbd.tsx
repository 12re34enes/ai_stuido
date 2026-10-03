import { cn } from "./cn";
import { shortcutKeys } from "./shortcuts";

export interface KbdProps {
  /** A shortcut string ("⌘K", "⌘⇧P") rendered as separate keys. */
  shortcut?: string;
  /** Or explicit keys. */
  keys?: string[];
  /** `inverse` for use on dark tooltips. */
  tone?: "default" | "inverse" | "accent";
  className?: string;
}

export function Kbd({ shortcut, keys, tone = "default", className }: KbdProps) {
  const list = keys ?? (shortcut ? shortcutKeys(shortcut) : []);
  return (
    <kbd className={cn("inline-flex items-center gap-[3px] font-sans not-italic", className)} aria-label={list.join(" ")}>
      {list.map((k, i) => (
        <span
          key={`${k}-${i}`}
          aria-hidden
          className={cn(
            "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] px-[5px] text-2xs leading-none font-medium tabular",
            tone === "default" && "border border-line bg-surface text-fg-muted shadow-[0_1px_0_var(--line)]",
            tone === "inverse" && "bg-tooltip-fg/14 text-tooltip-fg/85",
            tone === "accent" && "bg-fg-on-accent/20 text-fg-on-accent",
          )}
        >
          {k}
        </span>
      ))}
    </kbd>
  );
}
