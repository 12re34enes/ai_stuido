import { Lock, ShieldCheck } from "lucide-react";
import type { ReactElement } from "react";

import { Badge, cn, ProviderMark, Tooltip } from "@/ui";

import type { GateSummary, TeamMember } from "../model";
import { teamProviders } from "../model";
import { studioStrings as s } from "../strings";

/**
 * Overlapping provider tiles with a headcount ("3 ajan"). Interactive (focusable, tooltip listing
 * the members) unless it sits inside a link, where nested focus targets are not allowed.
 */
export function TeamMarks({ team, className, interactive = true }: { team: TeamMember[]; className?: string; interactive?: boolean }) {
  const counts = teamProviders(team);
  if (team.length === 0) return null;
  const summary = `${s.team}: ${team.map((m) => m.label).join(", ")}`;
  const body: ReactElement = (
    <span
      className={cn("inline-flex items-center gap-2 whitespace-nowrap outline-none", className)}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? summary : undefined}
      title={interactive ? undefined : summary}
    >
      <span className="flex items-center -space-x-1" aria-hidden>
        {counts.flatMap(({ provider, count }) =>
          Array.from({ length: Math.min(count, 3) }, (_, i) => (
            <ProviderMark key={`${provider}-${i}`} provider={provider} variant="tile" size={18} label="" className="ring-2 ring-surface" />
          )),
        )}
      </span>
      <span className="text-2xs text-fg-muted tabular">{s.agents(team.length)}</span>
    </span>
  );
  if (!interactive) return body;
  return (
    <Tooltip
      side="top"
      content={
        <span className="flex flex-col gap-0.5 py-0.5">
          {team.map((m) => (
            <span key={m.nodeId} className="flex items-center gap-1.5">
              {m.provider && <ProviderMark provider={m.provider} size={11} variant="mono" label="" />}
              <span>{m.label}</span>
              <span className="opacity-60">· {m.role}</span>
            </span>
          ))}
        </span>
      }
    >
      {body}
    </Tooltip>
  );
}

/** Gate chips on one line; locked gates (production deploy approval) carry a lock. */
export function GateBadges({ gates, max = 3, className, interactive = true }: { gates: GateSummary[]; max?: number; className?: string; interactive?: boolean }) {
  if (gates.length === 0) return <span className={cn("flex text-2xs text-fg-faint", className)}>{s.noGates}</span>;
  const shown = gates.slice(0, max);
  const rest = gates.slice(max);
  const more = <Badge tone="neutral">+{rest.length}</Badge>;
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-1", className)} aria-label={`${s.gates}: ${gates.map((g) => g.label).join(", ")}`}>
      {shown.map((g) => (
        <Badge key={g.kind} tone={g.locked ? "warning" : "neutral"} icon={g.locked ? <Lock /> : <ShieldCheck />}>
          {g.label}
        </Badge>
      ))}
      {rest.length > 0 &&
        (interactive ? (
          <Tooltip content={rest.map((g) => g.label).join(", ")} side="top">
            <span tabIndex={0} className="outline-none">
              {more}
            </span>
          </Tooltip>
        ) : (
          <span title={rest.map((g) => g.label).join(", ")}>{more}</span>
        ))}
    </span>
  );
}
