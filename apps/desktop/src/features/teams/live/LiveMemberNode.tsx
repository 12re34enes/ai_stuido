/**
 * Live member card: provider look, morphing status dot, the current assignment, context-window
 * ring, tokens, effort and model; testers show their latest verdict; the member's CLI-native
 * subagents hang underneath. Working members breathe; receiving work flashes the card once; a
 * failure shakes it. Hover opens the detail card, click selects (stream + message box).
 */
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowLeftRight, Check, CornerDownRight, Hourglass, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect } from "react";

import { SubagentTree } from "@/features/sessions/SubagentTree";
import { formatCompact, formatTime } from "@/i18n/format";
import { useShake } from "@/motion/hooks";
import { spring, transition } from "@/motion/tokens";
import { cn, ContextRing, HoverCard, ProviderMark, StatusDot, uiStrings } from "@/ui";
import { ActiveGlow } from "@/ui/flow";

import { EffortMeter, RoleGlyph } from "../chart/glyphs";
import { nameFont, providerRadius, providerRing, providerSurface } from "../chart/looks";
import { memberDot, type MemberLive, type TestVerdict } from "../model/live";
import { memberStatusStrings, s } from "../strings";
import type { Assignment, TeamMember } from "../types";
import { useLive } from "./context";
import { MemberDetails } from "./MemberDetails";

export const LIVE_CARD_W = 236;
export const LIVE_CARD_H = 92;

export interface LiveNodeData extends Record<string, unknown> {
  member: TeamMember;
  live: MemberLive | undefined;
  assignment: Assignment | null;
  verdict: TestVerdict | null;
  /** Id of the latest pulse arriving at this member (flash once per id). */
  arrival: number | null;
  /** Latest report / advice involving this member (advisors show it when idle). */
  note: string | null;
  selected: boolean;
}

function idleLine(m: TeamMember, live: MemberLive | undefined, note: string | null): string {
  if (live?.status === "done") return s.live.doneCount(live.completed);
  if (live?.status && live.status !== "idle") return memberStatusStrings[live.status];
  if (m.role === "advisor") return note ?? s.live.advisorIdle;
  if (m.role === "tester") return s.live.testerIdle;
  return s.live.noAssignment;
}

export type LiveNodeType = Node<LiveNodeData, "live">;

const handle = "!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0";

/** "Limit bekleniyor · 14:30" (when the window reopens, if known). */
function limitLine(live: MemberLive | undefined): string | null {
  const w = live?.limitWait;
  if (!w) return null;
  return w.resetsAt && Number.isFinite(Date.parse(w.resetsAt)) ? s.live.limitWaitUntil(formatTime(w.resetsAt)) : s.live.limitWait;
}

function VerdictChip({ verdict }: { verdict: TestVerdict }) {
  if (verdict.status === "running") return null;
  const ok = verdict.status === "passed";
  const error = verdict.status === "error";
  return (
    <motion.span
      key={`${verdict.status}-${verdict.round}`}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full px-1.5 text-2xs font-medium",
        ok ? "bg-success-soft text-success" : error ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger",
      )}
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1, transition: spring.bouncy }}
      title={verdict.summary || undefined}
      data-testid="test-verdict"
      data-verdict={verdict.status}
    >
      {ok ? <Check className="size-3" strokeWidth={2.75} aria-hidden /> : error ? <TriangleAlert className="size-3" aria-hidden /> : <X className="size-3" strokeWidth={2.75} aria-hidden />}
      {ok ? s.live.testPassed : error ? s.live.testError : s.live.testFailed}
      {verdict.round > 1 && <span className="font-normal opacity-80">· {s.live.testRound(verdict.round)}</span>}
    </motion.span>
  );
}

function LiveMemberNodeView({ id, data }: NodeProps<LiveNodeType>) {
  const { select } = useLive();
  const m = data.member;
  const live = data.live;
  const dot = memberDot(live);
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  useEffect(() => {
    if (dot === "error") shake();
  }, [dot, shake]);

  const usage = live?.usage;
  const tokens = usage ? usage.input + usage.output : null;
  const working = live?.status === "working" || live?.status === "testing" || live?.status === "consulting";
  const waitingLimit = limitLine(live);
  const line = waitingLimit ?? data.assignment?.title ?? idleLine(m, live, data.note);
  const statusText = memberStatusStrings[live?.status ?? "idle"];
  const satellite = m.role === "advisor" || m.role === "tester";
  // The provider it actually runs on: the engine may switch a member whose provider is out of limits.
  const provider = live?.provider ?? m.provider;
  const switched = live?.switchedFrom && live.switchedFrom !== provider ? live.switchedFrom : null;

  const card = (
    <div
      className="relative"
      style={{ width: LIVE_CARD_W }}
      onClick={(e) => {
        // The hover card must not toggle on click: click selects (xyflow's onNodeClick handles it).
        e.preventDefault();
      }}
    >
      <ActiveGlow active={working} tone={provider} radius={providerRadius(provider)} />
      <motion.span
        aria-hidden
        className={cn("pointer-events-none absolute -inset-[3px] border-[1.5px] border-accent shadow-[0_0_0_4px_var(--accent-soft)]", providerRing(provider))}
        initial={false}
        animate={{ opacity: data.selected ? 1 : 0, scale: data.selected ? 1 : 0.985 }}
        transition={spring.snappy}
      />
      <AnimatePresence>
        {data.arrival !== null && (
          <motion.span
            key={`arrival-${data.arrival}`}
            aria-hidden
            className={cn("pointer-events-none absolute inset-0 border-2 border-accent", providerRadius(provider))}
            initial={{ opacity: 0.9, scale: 1 }}
            animate={{ opacity: 0, scale: 1.06 }}
            transition={{ duration: 0.8, ease: [0.32, 0.72, 0, 1] }}
          />
        )}
      </AnimatePresence>
      <div
        ref={shakeRef}
        className={cn(
          "relative flex flex-col gap-1.5 overflow-hidden border px-3 pt-2.5 pb-2 shadow-1 transition-[border-color,box-shadow] duration-300",
          providerSurface(provider),
          satellite && "border-dashed",
          dot === "error" && "border-danger/60",
          "hover:shadow-2",
        )}
        style={{ minHeight: LIVE_CARD_H }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <ProviderMark provider={provider} variant="tile" size={20} />
          <span className={cn("min-w-0 flex-1 truncate leading-[18px] text-fg", nameFont(provider))}>{m.name}</span>
          <RoleGlyph member={m} />
          <StatusDot status={dot} tone={provider} size={12} label={statusText} />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          {waitingLimit ? <Hourglass className="size-3 shrink-0 text-warning" aria-hidden /> : data.assignment && <CornerDownRight className="size-3 shrink-0 text-fg-faint" aria-hidden />}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={line}
              className={cn("min-w-0 flex-1 truncate", waitingLimit ? "text-warning" : data.assignment ? "text-fg" : "text-fg-muted")}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: spring.smooth }}
              exit={{ opacity: 0, y: -6, transition: transition.exit }}
              title={line}
            >
              {line}
            </motion.span>
          </AnimatePresence>
          <AnimatePresence initial={false}>{data.verdict && <VerdictChip verdict={data.verdict} />}</AnimatePresence>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-2xs text-fg-muted">
          <span className="flex shrink-0 items-center gap-1 tabular" aria-label={usage?.contextUsed && usage.contextWindow ? s.live.contextOf(Math.round((usage.contextUsed / usage.contextWindow) * 100)) : undefined}>
            <ContextRing used={usage?.contextUsed} window={usage?.contextWindow} size={14} showLabel />
          </span>
          {tokens !== null && (
            <span className="shrink-0 tabular">
              {formatCompact(tokens)} {s.live.tokens}
            </span>
          )}
          <EffortMeter provider={provider} effort={switched ? null : m.effort} />
          {switched ? (
            // Switched off its provider (out of limits): the engine picks the other provider's default model.
            <span
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-full bg-warning-soft px-1.5 leading-4 font-medium text-warning"
              title={s.live.switched(uiStrings.providers[switched], uiStrings.providers[provider])}
              aria-label={s.live.switched(uiStrings.providers[switched], uiStrings.providers[provider])}
              data-testid="provider-switched"
            >
              <ArrowLeftRight className="size-2.5" aria-hidden />
              {s.live.switchedShort(uiStrings.providers[switched])}
            </span>
          ) : (
            <span className="ml-auto min-w-0 truncate font-mono text-[10px] text-fg-faint">{live?.model ?? m.model ?? ""}</span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col items-center gap-1.5" data-testid={`live-member-${id}`} data-status={live?.status ?? "idle"}>
      <HoverCard trigger={card} side="right" align="start" sideOffset={12} openDelay={420} label={m.name} className="p-0">
        {/* Portal content still bubbles React events through the node: don't let it select. */}
        <div className="nodrag nopan" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
          <MemberDetails member={m} />
        </div>
      </HoverCard>
      {live?.sessionId && (
        <div className="nodrag w-[220px]" onClick={(e) => e.stopPropagation()}>
          <SubagentTree sessionId={live.sessionId} compact onSelect={() => select(id)} />
        </div>
      )}
      <Handle id="t" type="target" position={Position.Top} className={handle} isConnectable={false} />
      <Handle id="l" type="target" position={Position.Left} className={handle} isConnectable={false} style={{ top: LIVE_CARD_H / 2 }} />
      {/* Delegation leaves below the subagent tree: native subagents hang under their member. */}
      <Handle id="b" type="source" position={Position.Bottom} className={handle} isConnectable={false} />
      <Handle id="r" type="source" position={Position.Right} className={handle} isConnectable={false} style={{ top: LIVE_CARD_H / 2 }} />
    </div>
  );
}

export const LiveMemberNode = memo(LiveMemberNodeView);
