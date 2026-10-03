import type { Provider } from "@/lib/types";

import { ClaudeGlyph, CodexGlyph } from "./assets/providerMarks";
import { cn } from "./cn";
import { uiStrings } from "./strings";

export interface ProviderMarkProps {
  provider: Provider;
  /** Pixel size of the mark (tile included). */
  size?: number;
  /** `glyph`: colored glyph; `tile`: glyph on a provider-colored square; `mono`: currentColor. */
  variant?: "glyph" | "tile" | "mono";
  className?: string;
  /** Accessible name; defaults to the provider name. Pass "" when decorative. */
  label?: string;
}

export function ProviderMark({ provider, size = 16, variant = "glyph", className, label }: ProviderMarkProps) {
  const Glyph = provider === "claude" ? ClaudeGlyph : CodexGlyph;
  const name = label ?? uiStrings.providers[provider];
  const a11y = name ? { role: "img", "aria-label": name } : { "aria-hidden": true };
  if (variant === "tile") {
    return (
      <span
        {...a11y}
        style={{ width: size, height: size }}
        className={cn(
          "inline-grid shrink-0 place-items-center",
          provider === "claude" ? "rounded-[30%] bg-claude text-fg-on-accent" : "rounded-[22%] bg-codex text-codex-surface",
          className,
        )}
      >
        <Glyph style={{ width: size * 0.66, height: size * 0.66 }} />
      </span>
    );
  }
  return (
    <span {...a11y} className={cn("inline-flex shrink-0", variant === "glyph" && (provider === "claude" ? "text-claude" : "text-codex"), className)}>
      <Glyph style={{ width: size, height: size }} />
    </span>
  );
}
