/**
 * Full member detail for the hover card (spec §19 level 2): role, provider/model/effort, state,
 * context window, tokens, the member's share of team tokens next to its provider's account
 * limits, the latest output line and the assignment history.
 */
import { ArrowLeftRight, Hourglass, MousePointerClick } from "lucide-react";

import { useNow } from "@/hooks/useNow";
import { formatCompact, formatDuration, formatTime } from "@/i18n/format";
import { useLimits } from "@/lib/queries";
import { Badge, cn, ContextRing, LimitBar, ProviderMark, StatusDot, uiStrings } from "@/ui";
import { groupLimits } from "@/ui/limits";

import { EffortMeter } from "../chart/glyphs";
import { nameFont } from "../chart/looks";
import { memberAssignments, memberDot, tokenShare } from "../model/live";
import { roleLabel } from "../model/spec";
import { assignmentStatusStrings, memberStatusStrings, s } from "../strings";
import type { Assignment, TeamMember } from "../types";
import { useLive } from "./context";

const statusTone: Record<Assignment["status"], "neutral" | "accent" | "success" | "danger" | "info" | "warning"> = {
  pending: "neutral",
  blocked: "warning",
  running: "accent",
  testing: "info",
  completed: "success",
  failed: "danger",
  cancelled: "neutral",
};

function duration(a: Assignment, now: number): string | null {
  const start = a.started_at ? Date.parse(a.started_at) : NaN;
  if (!Number.isFinite(start)) return null;
  const end = a.finished_at ? Date.parse(a.finished_at) : now;
  return formatDuration(Math.max(0, end - start));
}

export function MemberDetails({ member }: { member: TeamMember }) {
  const { state, sessions } = useLive();
  const live = state.members[member.id];
  const limits = useLimits();
  const now = useNow(1000);
  const history = memberAssignments(state, member.id).slice(-5).reverse();
  const share = tokenShare(state, member.id);
  const session = live?.sessionId ? sessions.get(live.sessionId) : undefined;
  const model = live?.model ?? session?.model ?? member.model;
  const usage = live?.usage;
  const pct = usage?.contextUsed && usage.contextWindow ? Math.round((usage.contextUsed / usage.contextWindow) * 100) : null;
  const provider = live?.provider ?? member.provider;
  const switched = live?.switchedFrom && live.switchedFrom !== provider ? live.switchedFrom : null;
  const providerLimits = groupLimits(limits.data ?? []).find((g) => g.provider === provider)?.windows.slice(0, 2) ?? [];
  const dot = memberDot(live);

  return (
    <div className="flex w-[320px] flex-col" data-testid={`member-details-${member.id}`}>
      <div className="flex items-start gap-2.5 border-b border-line-subtle px-3.5 pt-3 pb-2.5">
        <ProviderMark provider={provider} variant="tile" size={26} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className={cn("truncate text-fg", nameFont(provider))}>{member.name}</span>
          <span className="truncate text-xs text-fg-muted">
            {roleLabel(member)} · {uiStrings.providers[provider]}
          </span>
        </div>
        <span className="flex items-center gap-1.5 pt-0.5 text-xs text-fg-muted">
          <StatusDot status={dot} tone={provider} size={10} />
          {memberStatusStrings[live?.status ?? "idle"]}
        </span>
      </div>

      {(switched || live?.limitWait) && (
        <div className="flex flex-col gap-1 border-b border-line-subtle bg-warning-soft/50 px-3.5 py-2 text-xs text-warning" data-testid="member-provider-notice">
          {switched && (
            <span className="flex items-center gap-1.5">
              <ArrowLeftRight className="size-3 shrink-0" aria-hidden />
              {s.live.switched(uiStrings.providers[switched], uiStrings.providers[provider])}
            </span>
          )}
          {live?.limitWait && (
            <span className="flex items-start gap-1.5">
              <Hourglass className="mt-px size-3 shrink-0" aria-hidden />
              <span>
                {live.limitWait.resetsAt && Number.isFinite(Date.parse(live.limitWait.resetsAt)) ? s.live.limitWaitUntil(formatTime(live.limitWait.resetsAt)) : s.live.limitWait}
                {live.limitWait.reason && <span className="block text-fg-muted">{live.limitWait.reason}</span>}
              </span>
            </span>
          )}
        </div>
      )}

      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 px-3.5 py-2.5 text-xs">
        <dt className="text-fg-muted">{s.inspector.model}</dt>
        <dd className="truncate font-mono text-[11px] text-fg">{model ?? s.inspector.modelPlaceholder}</dd>
        <dt className="text-fg-muted">{s.inspector.effort}</dt>
        <dd>
          <EffortMeter provider={provider} effort={switched ? null : member.effort} showLabel />
        </dd>
        <dt className="text-fg-muted">{s.live.context}</dt>
        <dd className="flex items-center gap-2 text-fg">
          <ContextRing used={usage?.contextUsed} window={usage?.contextWindow} size={16} />
          {pct !== null && usage ? (
            <span className="tabular">
              %{pct} · {formatCompact(usage.contextUsed ?? 0)} / {formatCompact(usage.contextWindow ?? 0)}
            </span>
          ) : (
            <span className="text-fg-faint">—</span>
          )}
        </dd>
        <dt className="text-fg-muted">{s.live.tokens}</dt>
        <dd className="text-fg tabular">
          {usage ? (
            <>
              {formatCompact(usage.input)} {s.live.tokensIn} · {formatCompact(usage.output)} {s.live.tokensOut}
            </>
          ) : (
            <span className="text-fg-faint">—</span>
          )}
        </dd>
      </dl>

      {(providerLimits.length > 0 || share !== null) && (
        <div className="flex flex-col gap-1.5 border-t border-line-subtle px-3.5 py-2.5">
          <div className="flex items-center justify-between text-2xs">
            <span className="font-medium tracking-wide text-fg-faint uppercase">{s.live.limitsShare}</span>
            {share !== null && <span className="text-fg-muted">{s.live.teamShare(share)}</span>}
          </div>
          {providerLimits.map((w) => (
            <LimitBar key={w.window} value={w.used_percent} status={w.status} label={w.label} resetsAt={w.resets_at} size="md" />
          ))}
        </div>
      )}

      {live?.lastLine && (
        <p className="truncate border-t border-line-subtle px-3.5 py-2 font-mono text-[11px] text-fg-muted" title={live.lastLine}>
          {live.lastLine}
        </p>
      )}

      <div className="flex flex-col gap-1 border-t border-line-subtle px-3.5 pt-2.5 pb-3">
        <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{s.live.history}</span>
        {history.length === 0 ? (
          <span className="text-xs text-fg-muted">{s.live.historyEmpty}</span>
        ) : (
          <ul className="flex flex-col gap-1">
            {history.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-xs">
                <Badge tone={statusTone[a.status]} dot>
                  {assignmentStatusStrings[a.status]}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-fg">{a.title}</span>
                {a.round > 1 && <span className="text-2xs text-fg-faint">{s.live.testRound(a.round)}</span>}
                <span className="shrink-0 text-2xs text-fg-faint tabular">{duration(a, now) ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
        <span className="mt-1 flex items-center gap-1 text-2xs text-fg-faint">
          <MousePointerClick className="size-3" aria-hidden />
          {s.live.openStream} · {s.live.message}
        </span>
      </div>
    </div>
  );
}
