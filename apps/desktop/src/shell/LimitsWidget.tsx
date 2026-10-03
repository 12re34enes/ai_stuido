import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { useLimits } from "@/lib/queries";
import type { LimitWindow, Provider } from "@/lib/types";
import { Badge, cn, LimitBar, limitTone, Popover, ProviderMark, uiStrings } from "@/ui";
import { groupLimits } from "@/ui/limits";

import { shellStrings as s } from "./strings";

function ProviderSection({ provider, windows }: { provider: Provider; windows: LimitWindow[] }) {
  const now = useNow(30_000);
  const newest = windows.reduce((a, b) => (new Date(a.observed_at) > new Date(b.observed_at) ? a : b));
  return (
    <section className="flex flex-col gap-3 px-4 py-3.5">
      <header className="flex items-center gap-2">
        <ProviderMark provider={provider} variant="tile" size={18} />
        <span className={cn("text-sm font-medium text-fg", provider === "claude" ? "font-serif" : "font-mono text-xs")}>
          {uiStrings.providers[provider]}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-2xs text-fg-faint">
          <Badge tone="neutral" size="sm">
            {s.limits.source[newest.source] ?? newest.source}
          </Badge>
          {s.limits.updated(relativeTime(newest.observed_at, new Date(now)))}
        </span>
      </header>
      {windows.map((w) => (
        <LimitBar key={w.window} label={w.label} value={w.used_percent} status={w.status} resetsAt={w.resets_at} />
      ))}
    </section>
  );
}

/** Two thin bars per provider (5 saat, Haftalık); click opens the breakdown with countdowns. */
export function LimitsWidget() {
  const { data } = useLimits();
  const groups = groupLimits(data ?? []);
  if (groups.length === 0) return null;
  const worst = Math.max(...(data ?? []).map((w) => (limitTone(w.used_percent, w.status) === "critical" ? 2 : limitTone(w.used_percent, w.status) === "warning" ? 1 : 0)));
  return (
    <Popover
      align="end"
      className="w-80 overflow-hidden p-0"
      label={s.limits.title}
      trigger={
        <button
          type="button"
          aria-label={s.topbar.limits}
          data-severity={worst}
          className="no-drag flex h-7 items-center gap-3 rounded-md px-2 outline-none transition-colors duration-150 hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)] data-[state=open]:bg-surface-hover"
        >
          {groups.map((g) => (
            <span key={g.provider} className="flex items-center gap-1.5">
              <ProviderMark provider={g.provider} size={12} label="" />
              <span className="flex flex-col gap-[3px]">
                {g.windows.slice(0, 2).map((w) => (
                  <LimitBar key={w.window} size="mini" value={w.used_percent} status={w.status} label={`${uiStrings.providers[g.provider]} ${w.label}`} className="w-11" />
                ))}
              </span>
            </span>
          ))}
        </button>
      }
    >
      <div className="flex items-center justify-between border-b border-line-subtle px-4 py-2.5">
        <span className="text-xs font-medium text-fg">{s.limits.title}</span>
      </div>
      <div className="divide-y divide-line-subtle">
        {groups.map((g) => (
          <ProviderSection key={g.provider} provider={g.provider} windows={g.windows} />
        ))}
      </div>
    </Popover>
  );
}
