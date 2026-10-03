/**
 * Animated tree of a session's CLI-native subagents (nested), with status, task and tokens.
 * Embedded by the sessions stream, agent cards, task detail and the live team view.
 *
 * - full (default): the nested tree with connector lines, live lines, tokens, tool calls and
 *   duration; loading / error / empty states.
 * - compact: status dots with a count; hovering opens the tree in a popover. Renders nothing
 *   while the session has no subagents (cards stay clean).
 */
import { Bot, RotateCw } from "lucide-react";

import type { Provider } from "@/lib/types";
import { Button, EmptyState, Skeleton } from "@/ui";

import { errorMessage } from "./kit/errors";
import { sessionStrings } from "./strings";
import { CompactSubagents } from "./subagent/SubagentPopover";
import { SubagentTreeView } from "./subagent/SubagentTreeView";
import { useSessionProvider } from "./subagent/useSessionProvider";
import { useSubagentsQuery } from "./subagents";

const t = sessionStrings.subagents;

export interface SubagentTreeProps {
  sessionId: string;
  /** Compact = small inline variant for cards and team nodes. */
  compact?: boolean;
  /** Called when a subagent is clicked (e.g. scroll the stream to it). */
  onSelect?: (subagentId: string) => void;
  /** Provider styling; read from the cached session record when omitted. */
  provider?: Provider;
  className?: string;
}

function TreeSkeleton() {
  return (
    <div className="flex flex-col gap-3 py-2" aria-busy>
      <span className="sr-only">{t.loading}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-start gap-2" style={{ paddingLeft: i === 1 ? 16 : 0 }}>
          <Skeleton circle width={12} height={12} />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton height={12} width={`${70 - i * 12}%`} />
            <Skeleton height={9} width={`${50 - i * 8}%`} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SubagentTree({ sessionId, compact = false, onSelect, provider, className }: SubagentTreeProps) {
  const cached = useSessionProvider(sessionId);
  const look = provider ?? cached;
  if (compact) return <CompactSubagents sessionId={sessionId} provider={look} onSelect={onSelect} className={className} />;
  return <FullTree sessionId={sessionId} provider={look} onSelect={onSelect} className={className} />;
}

function FullTree({ sessionId, provider, onSelect, className }: { sessionId: string; provider?: Provider; onSelect?: (id: string) => void; className?: string }) {
  const q = useSubagentsQuery(sessionId);
  if (q.isLoading && q.nodes.length === 0) return <TreeSkeleton />;
  if (q.error && q.nodes.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={<Bot />}
        title={t.loadError}
        description={errorMessage(q.error)}
        action={
          <Button size="sm" icon={<RotateCw />} onClick={q.refetch}>
            {sessionStrings.retry}
          </Button>
        }
      />
    );
  }
  if (q.nodes.length === 0) return <EmptyState size="sm" icon={<Bot />} title={t.empty} description={t.emptyHint} />;
  return <SubagentTreeView nodes={q.nodes} provider={provider} onSelect={onSelect} className={className} />;
}
