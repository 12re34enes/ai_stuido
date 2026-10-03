/** Small visual vocabulary of team members: role glyphs and the effort meter. */
import { Crown, FlaskConical, Lightbulb } from "lucide-react";

import { cn } from "@/ui";

import { effortLevel } from "../model/spec";
import { roleStrings } from "../strings";
import type { Provider, TeamMember } from "../types";

const roleIcon = { lead: Crown, advisor: Lightbulb, tester: FlaskConical } as const;

/** Role mark for non-workers (crown, bulb, flask). Workers carry none: they are the default. */
export function RoleGlyph({ member, className }: { member: Pick<TeamMember, "role">; className?: string }) {
  if (member.role === "worker") return null;
  const Icon = roleIcon[member.role];
  return (
    <span
      role="img"
      aria-label={roleStrings[member.role].label}
      className={cn(
        "grid size-[18px] shrink-0 place-items-center rounded-full [&_svg]:size-3",
        member.role === "lead" && "bg-accent-soft text-accent",
        member.role === "advisor" && "bg-info-soft text-info",
        member.role === "tester" && "bg-success-soft text-success",
        className,
      )}
    >
      <Icon aria-hidden strokeWidth={2.25} />
    </span>
  );
}

/** Ascending bars: how much effort the member spends (filled up to its level). */
export function EffortMeter({ provider, effort, className, showLabel = false }: { provider: Provider; effort: string | null; className?: string; showLabel?: boolean }) {
  const { index, of, label } = effortLevel(provider, effort);
  const text = label ? `Efor: ${label}` : "Efor: varsayılan";
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)} role="img" aria-label={text} title={text}>
      <svg width={of * 4 - 1} height={10} viewBox={`0 0 ${of * 4 - 1} 10`} aria-hidden className="overflow-visible">
        {Array.from({ length: of }, (_, i) => {
          const h = 3 + (7 * (i + 1)) / of;
          return (
            <rect
              key={i}
              x={i * 4}
              y={10 - h}
              width={3}
              height={h}
              rx={1}
              className={cn("transition-[fill] duration-200", i < index ? (provider === "codex" ? "fill-codex" : "fill-claude") : "fill-line-strong")}
            />
          );
        })}
      </svg>
      {showLabel && <span className="text-2xs text-fg-muted">{label ?? "Varsayılan"}</span>}
    </span>
  );
}
