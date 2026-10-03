/**
 * Menu bar popover window (#/menubar, ~360×480, spec §19 "Menü çubuğu"). Placeholder: shows live
 * limits, pending approvals and active agents from the same queries as the shell; actions that
 * need the main window arrive with the native bridge.
 */
import { Inbox, Plus } from "lucide-react";

import { useConnection } from "@/lib/connection";
import { useShellLiveSync } from "@/lib/live";
import { useActiveSessions, useLimits, usePendingApprovals } from "@/lib/queries";
import { agentDotStatus, Button, EmptyState, LimitBar, ProviderMark, StatusDot, uiStrings } from "@/ui";
import { groupLimits } from "@/ui/limits";

import { shellStrings as s } from "../strings";
import { WindowSurface } from "./WindowSurface";

function SectionTitle({ children }: { children: string }) {
  return <h2 className="px-4 pt-3 pb-1.5 font-sans text-2xs font-medium tracking-wide text-fg-faint uppercase">{children}</h2>;
}

export default function MenubarWindow() {
  useShellLiveSync();
  const limits = groupLimits(useLimits().data ?? []);
  const approvals = usePendingApprovals().data ?? [];
  const sessions = useActiveSessions().data ?? [];
  const status = useConnection((st) => st.status);

  return (
    <WindowSurface>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line-subtle px-4">
        <span className="font-serif text-base text-fg">{s.appName}</span>
        <StatusDot status={status === "offline" ? "error" : "success"} size={10} className="ml-auto" />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {limits.length > 0 && (
          <>
            <SectionTitle>{s.limits.title}</SectionTitle>
            <div className="flex flex-col gap-3 px-4">
              {limits.map((g) => (
                <div key={g.provider} className="flex items-start gap-3">
                  <ProviderMark provider={g.provider} variant="tile" size={18} className="mt-0.5" />
                  <div className="grid flex-1 grid-cols-2 gap-3">
                    {g.windows.slice(0, 2).map((w) => (
                      <LimitBar key={w.window} label={w.label} value={w.used_percent} status={w.status} resetsAt={w.resets_at} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
        <SectionTitle>{s.approvals.title}</SectionTitle>
        {approvals.length === 0 ? (
          <EmptyState size="sm" icon={<Inbox />} title={s.approvals.empty} />
        ) : (
          <ul className="flex flex-col gap-1 px-2">
            {approvals.slice(0, 4).map((a) => (
              <li key={a.id} className="rounded-md px-2 py-1.5 text-sm text-fg hover:bg-surface-hover">
                <span className="block truncate">{a.title}</span>
                <span className="text-2xs text-fg-muted">{s.approvals.kinds[a.kind] ?? a.kind}</span>
              </li>
            ))}
          </ul>
        )}
        {sessions.length > 0 && (
          <>
            <SectionTitle>{s.agents.title}</SectionTitle>
            <ul className="flex flex-col px-2">
              {sessions.map((x) => (
                <li key={x.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm">
                  <StatusDot status={agentDotStatus(x.state)} tone={x.provider} size={12} />
                  <span className="min-w-0 flex-1 truncate text-fg">{x.label ?? x.title ?? uiStrings.providers[x.provider]}</span>
                  <span className="text-2xs text-fg-muted">{uiStrings.agentState[x.state]}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line-subtle px-3 py-2.5">
        {/* TODO(native): send a "new-task" shell action to the main window via the bridge. */}
        <Button size="sm" variant="primary" icon={<Plus />}>
          Yeni görev
        </Button>
      </footer>
    </WindowSurface>
  );
}
