/**
 * Live view of one agent session (messages, thinking, tool calls, file changes, permission
 * prompts, input box for send/steer/interrupt). Shared: the tasks feature embeds it in the drawer.
 *
 * History is backfilled from `/api/events?session_id=` and followed live over the event socket;
 * token deltas fold into the streaming message once per frame. `replay` reads the persisted
 * events only and adds a scrubber.
 */
import "./stream/stream.css";

import { MessageSquare } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { readPref, writePref } from "@/lib/storage";
import type { AgentState, Usage } from "@/lib/types";
import { variants } from "@/motion/tokens";
import { Badge, cn, EmptyState, ProviderMark, Skeleton, toast, uiStrings } from "@/ui";

import { useSession, useSessionControl, type SessionView } from "./api";
import { ErrorState } from "./kit/Page";
import { sessionStrings as t } from "./strings";
import { unionSubagents, type SubagentNode } from "./subagent/model";
import { useSubagentsQuery } from "./subagents";
import { Composer } from "./stream/Composer";
import { StreamContext, type StreamContextValue } from "./stream/context";
import { emptyStream, foldEvents, isBusy, subagentPath, type StreamItem, type StreamState } from "./stream/model";
import { ReplayBar } from "./stream/ReplayBar";
import { INITIAL_REPLAY, replayReducer, type ReplaySpeed } from "./stream/replay";
import { StreamBody, type StreamBodyHandle } from "./stream/StreamBody";
import { CompactStatus, StreamHeader } from "./stream/StreamHeader";
import { SubagentPopoverToggle, SubagentRail, SubagentToggle } from "./stream/SubagentRail";
import { subagentNodesFromStream } from "./stream/subagents";
import { useSessionEvents, useSessionStream } from "./stream/useSessionStream";

export interface SessionStreamProps {
  sessionId: string;
  /** Compact = drawer/inline variant (no header chrome, smaller type). */
  compact?: boolean;
  /** Show the input box (send / steer / interrupt). Default true. */
  interactive?: boolean;
  /** Replay persisted history with a scrubber instead of following live (no input box). */
  replay?: boolean;
  /** Open and scroll to this subagent's block once it is in the stream (deep link). */
  focusSubagent?: string | null;
}

// --------------------------------------------------------------------------- shared bits

function useDisclosure() {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback((key: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const reveal = useCallback((keys: readonly string[]) => {
    setOpen((prev) => (keys.every((k) => prev.has(k)) ? prev : new Set([...prev, ...keys])));
  }, []);
  return { open, toggle, reveal };
}

const RAIL_PREF = "sessions.subagentRail";

/**
 * Subagents of the stream: the folded events (exact, delta-fresh) merged over the API snapshot
 * (which may know subagents older than the loaded history), plus the jump-to-block action.
 */
function useStreamSubagents(
  session: SessionView,
  state: StreamState | null,
  body: RefObject<StreamBodyHandle | null>,
  reveal: (keys: readonly string[]) => void,
  enabled = true,
) {
  const api = useSubagentsQuery(session.id, { enabled });
  const fromStream = useMemo(() => subagentNodesFromStream(state, session.cwd), [session.cwd, state]);
  const nodes = useMemo<SubagentNode[]>(() => unionSubagents(api.nodes, fromStream), [api.nodes, fromStream]);
  const [highlight, setHighlight] = useState<{ id: string; nonce: number } | null>(null);
  const select = useCallback(
    (id: string) => {
      if (!state) return;
      const path = subagentPath(state, id);
      const target = state.subagents[id];
      if (!path || !target) return;
      reveal(path.chain.map((sid) => state.subagents[sid]?.key).filter((k): k is string => Boolean(k)));
      body.current?.scrollToItem(path.topKey, target.key);
      setHighlight((h) => ({ id, nonce: (h?.nonce ?? 0) + 1 }));
    },
    [body, reveal, state],
  );
  return { nodes, select, highlight };
}

/** Jump to `id` once its block exists (deep links from cards, popovers and the drawer). */
function useFocusSubagent(id: string | null | undefined, state: StreamState | null, select: (id: string) => void) {
  const done = useRef<string | null>(null);
  const ready = Boolean(id && state?.subagents[id]);
  useEffect(() => {
    if (!id || !ready || done.current === id) return;
    // Let the virtualized list measure its first rows before scrolling. A live batch that lands
    // first re-schedules the jump (it is only marked done once it ran).
    const frame = requestAnimationFrame(() => {
      done.current = id;
      select(id);
    });
    return () => cancelAnimationFrame(frame);
  }, [id, ready, select]);
}

function BodySkeleton({ compact }: { compact: boolean }) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-5 overflow-hidden", compact ? "px-4 py-4" : "mx-auto w-full max-w-[760px] px-8 py-6")} aria-busy>
      <span className="sr-only">{t.stream.loading}</span>
      <Skeleton className="ml-auto rounded-[18px]" width="46%" height={38} />
      <div className="flex gap-3">
        <Skeleton circle width={16} height={16} />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton height={10} width="92%" />
          <Skeleton height={10} width="80%" />
          <Skeleton height={10} width="54%" />
        </div>
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton width={22} height={22} />
          <Skeleton height={10} width={`${48 - i * 9}%`} />
        </div>
      ))}
    </div>
  );
}

/** Breathing "the agent is working" line under the last row while nothing streams. */
function WorkingLine({ provider, state, compact }: { provider: SessionView["provider"]; state: AgentState; compact: boolean }) {
  return (
    <motion.div
      {...variants.fadeUp}
      className={cn("flex items-center gap-2.5 text-fg-muted", compact ? "px-4 pb-3 text-xs" : "mx-auto w-full max-w-[760px] px-8 pb-4 text-sm")}
      aria-live="polite"
    >
      <span className="session-breathe flex">
        <ProviderMark provider={provider} size={compact ? 14 : 16} label="" />
      </span>
      <span className="session-breathe">{uiStrings.agentState[state]}…</span>
    </motion.div>
  );
}

/** Stream usage wins; the context window falls back to the session record when unknown. */
function mergeUsage(record: Usage | null | undefined, live: Usage | null | undefined): Usage | null {
  if (!live) return record ?? null;
  if (!record) return live;
  return { ...record, ...live, context_used: live.context_used ?? record.context_used, context_window: live.context_window ?? record.context_window };
}

function isStreamingNow(items: StreamItem[]): boolean {
  const last = items[items.length - 1];
  if (!last) return false;
  if ((last.kind === "assistant" || last.kind === "thinking") && last.streaming) return true;
  if (last.kind === "tool" && last.result === null) return true;
  if (last.kind === "subagent" && last.status === "running") return true;
  return last.kind === "permission" && last.verdict === "ask" && last.decision === null;
}

function StreamFrame({ provider, children }: { provider: SessionView["provider"]; children: ReactNode }) {
  return (
    <div data-provider={provider} className="flex h-full min-h-0 flex-col bg-canvas">
      {children}
    </div>
  );
}

// --------------------------------------------------------------------------- live

function LiveStreamView({
  session,
  compact,
  interactive,
  focusSubagent,
}: {
  session: SessionView;
  compact: boolean;
  interactive: boolean;
  focusSubagent?: string | null;
}) {
  const navigate = useNavigate();
  const stream = useSessionStream(session.id);
  const control = useSessionControl(session.id);
  const { open, toggle, reveal } = useDisclosure();
  const bodyRef = useRef<StreamBodyHandle>(null);
  const subagents = useStreamSubagents(session, stream.state, bodyRef, reveal);
  const [railOpen, setRailOpen] = useState(() => readPref<boolean>(RAIL_PREF, false));
  const toggleRail = useCallback(() => {
    setRailOpen((o) => {
      writePref(RAIL_PREF, !o);
      return !o;
    });
  }, []);
  const showRail = !compact && railOpen && subagents.nodes.length > 0;
  useFocusSubagent(focusSubagent, stream.state, subagents.select);
  const inputId = `composer-${session.id}`;
  const state: AgentState = stream.liveState ?? session.state;
  const usage = mergeUsage(session.last_usage, stream.state?.usage);
  const items = stream.state?.items ?? [];
  const busy = isBusy(state);
  const ended = state === "done" || state === "error";
  const readonly = session.origin === "external";

  const ctx = useMemo<StreamContextValue>(
    () => ({
      sessionId: session.id,
      provider: session.provider,
      compact,
      cwd: session.cwd,
      interactive,
      replay: false,
      isOpen: (k) => open.has(k),
      toggle,
      lanes: stream.state?.lanes,
      highlight: subagents.highlight,
      focusSubagent: subagents.select,
    }),
    [compact, interactive, open, session.cwd, session.id, session.provider, stream.state?.lanes, subagents.highlight, subagents.select, toggle],
  );

  const closeSession = useCallback(() => {
    control.close.mutate(undefined, {
      onSuccess: () => toast.success(t.stream.actions.closed),
      onError: (err) => toast.error(t.stream.composer.failed, { description: err instanceof ApiError ? err.message : undefined }),
    });
  }, [control.close]);

  const interrupt = control.interrupt.mutateAsync;
  const commands = useMemo<StudioCommand[]>(
    () =>
      compact || !interactive || readonly
        ? []
        : [
            {
              id: "session.focus-input",
              title: "Oturuma mesaj yaz",
              group: commandGroups.actions,
              keywords: ["send", "gönder", "mesaj"],
              run: () => document.getElementById(inputId)?.focus(),
            },
            {
              id: "session.interrupt",
              title: "Ajanı durdur",
              group: commandGroups.actions,
              keywords: ["interrupt", "stop", "durdur"],
              visible: busy,
              run: () => void interrupt(),
            },
            {
              id: "session.close",
              title: t.stream.actions.close,
              group: commandGroups.actions,
              keywords: ["close", "kapat"],
              visible: !ended,
              run: closeSession,
            },
            {
              id: "session.replay",
              title: t.stream.actions.replay,
              group: commandGroups.actions,
              keywords: ["replay", "tekrar"],
              run: () => void navigate(`/history/replay/${session.id}`),
            },
          ],
    [busy, closeSession, compact, ended, inputId, interactive, interrupt, navigate, readonly, session.id],
  );
  useRegisterCommands(commands);

  const showWorking = busy && !stream.isLoading && !isStreamingNow(items) && state !== "waiting_permission";
  return (
    <StreamContext.Provider value={ctx}>
      <StreamFrame provider={session.provider}>
        {compact ? (
          <CompactStatus
            session={session}
            state={state}
            usage={usage}
            subagents={<SubagentPopoverToggle nodes={subagents.nodes} provider={session.provider} onSelect={subagents.select} />}
          />
        ) : (
          <StreamHeader
            session={session}
            state={state}
            usage={usage}
            onClose={interactive && !readonly ? closeSession : undefined}
            closing={control.close.isPending}
            onReplay={() => void navigate(`/history/replay/${session.id}`)}
            subagents={<SubagentToggle nodes={subagents.nodes} provider={session.provider} open={showRail} onToggle={toggleRail} />}
          />
        )}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {stream.isLoading ? (
              <BodySkeleton compact={compact} />
            ) : stream.error ? (
              <div className="grid flex-1 place-items-center">
                <ErrorState title={t.stream.loadError} error={stream.error} onRetry={stream.refetch} />
              </div>
            ) : (
              <StreamBody
                ref={bodyRef}
                items={items}
                compact={compact}
                busy={busy}
                layoutKey={compact ? undefined : showRail}
                footer={showWorking ? <WorkingLine provider={session.provider} state={state} compact={compact} /> : null}
                empty={
                  <EmptyState
                    size={compact ? "sm" : "md"}
                    icon={<MessageSquare />}
                    title={t.stream.empty}
                    description={interactive && !readonly ? t.stream.emptyHint : t.stream.emptyReadonly}
                  />
                }
              />
            )}
            {interactive && (
              <Composer
                provider={session.provider}
                busy={busy}
                ended={ended}
                readonly={readonly}
                compact={compact}
                inputId={inputId}
                layoutKey={compact ? undefined : showRail}
                onSend={(text) => control.send.mutateAsync(text)}
                onSteer={(text) => control.steer.mutateAsync(text)}
                onInterrupt={() => control.interrupt.mutateAsync()}
              />
            )}
          </div>
          <AnimatePresence initial={false} mode="popLayout">
            {showRail && (
              <SubagentRail
                key="rail"
                nodes={subagents.nodes}
                provider={session.provider}
                selectedId={subagents.highlight?.id ?? null}
                onSelect={subagents.select}
                onClose={toggleRail}
              />
            )}
          </AnimatePresence>
        </div>
      </StreamFrame>
    </StreamContext.Provider>
  );
}

// --------------------------------------------------------------------------- replay

function ReplayStreamView({ session, compact }: { session: SessionView; compact: boolean }) {
  const eventsQ = useSessionEvents(session.id);
  const events = useMemo(() => eventsQ.data ?? [], [eventsQ.data]);
  const full = useMemo(() => foldEvents(emptyStream(), events, { sessionId: session.id }), [events, session.id]);
  const [rs, dispatch] = useReducer(replayReducer, INITIAL_REPLAY);
  const { open, toggle, reveal } = useDisclosure();
  const view = rs.view ?? full;
  const position = rs.pos ?? events.length;
  const bodyRef = useRef<StreamBodyHandle>(null);
  // Replays show what the history knew at this point: no API snapshot.
  const subagents = useStreamSubagents(session, view, bodyRef, reveal, false);

  const ctx = useMemo<StreamContextValue>(
    () => ({
      sessionId: session.id,
      provider: session.provider,
      compact,
      cwd: session.cwd,
      interactive: false,
      replay: true,
      isOpen: (k) => open.has(k),
      toggle,
      lanes: view.lanes,
      highlight: subagents.highlight,
      focusSubagent: subagents.select,
    }),
    [compact, open, session.cwd, session.id, session.provider, subagents.highlight, subagents.select, toggle, view.lanes],
  );
  const onStep = useCallback(() => dispatch({ type: "step", events, sessionId: session.id }), [events, session.id]);
  const onPosition = useCallback((pos: number) => dispatch({ type: "seek", pos, events, sessionId: session.id }), [events, session.id]);
  const onPlaying = useCallback((playing: boolean) => dispatch({ type: "playing", playing }), []);
  const onSpeed = useCallback((speed: ReplaySpeed) => dispatch({ type: "speed", speed }), []);

  return (
    <StreamContext.Provider value={ctx}>
      <StreamFrame provider={session.provider}>
        {compact ? (
          <CompactStatus
            session={session}
            state={view.state ?? session.state}
            usage={mergeUsage(session.last_usage, view.usage)}
            subagents={<SubagentPopoverToggle nodes={subagents.nodes} provider={session.provider} onSelect={subagents.select} />}
          />
        ) : (
          <StreamHeader
            session={session}
            state={view.state ?? session.state}
            usage={mergeUsage(session.last_usage, view.usage)}
            trailing={<Badge tone="info">{t.stream.replay.title}</Badge>}
            subagents={<SubagentPopoverToggle nodes={subagents.nodes} provider={session.provider} onSelect={subagents.select} />}
          />
        )}
        {eventsQ.isLoading ? (
          <BodySkeleton compact={compact} />
        ) : eventsQ.error ? (
          <div className="grid flex-1 place-items-center">
            <ErrorState title={t.stream.loadError} error={eventsQ.error} onRetry={() => void eventsQ.refetch()} />
          </div>
        ) : (
          <StreamBody ref={bodyRef} items={view.items} compact={compact} empty={<EmptyState size="sm" icon={<MessageSquare />} title={t.stream.replay.empty} />} />
        )}
        <ReplayBar
          events={events}
          position={position}
          playing={rs.playing}
          speed={rs.speed}
          onPosition={onPosition}
          onStep={onStep}
          onPlaying={onPlaying}
          onSpeed={onSpeed}
        />
      </StreamFrame>
    </StreamContext.Provider>
  );
}

// --------------------------------------------------------------------------- entry

export function SessionStream({ sessionId, compact = false, interactive = true, replay = false, focusSubagent }: SessionStreamProps) {
  const sessionQ = useSession(sessionId);
  if (sessionQ.isLoading) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {!compact && (
          <div className="flex h-[66px] shrink-0 items-center gap-4 border-b border-line px-6">
            <Skeleton width={34} height={34} className="rounded-[10px]" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton height={12} width={220} />
              <Skeleton height={9} width={320} />
            </div>
          </div>
        )}
        <BodySkeleton compact={compact} />
      </div>
    );
  }
  if (sessionQ.error || !sessionQ.data) {
    const notFound = sessionQ.error instanceof ApiError && sessionQ.error.status === 404;
    return (
      <div className="grid h-full place-items-center">
        {notFound ? (
          // Name the id: a stale link or a session from another studiod is easy to tell apart.
          <EmptyState size={compact ? "sm" : "md"} icon={<MessageSquare />} title={t.stream.notFound} description={t.stream.notFoundId(sessionId)} />
        ) : (
          <ErrorState size={compact ? "sm" : "md"} title={t.stream.loadError} error={sessionQ.error} onRetry={() => void sessionQ.refetch()} />
        )}
      </div>
    );
  }
  return replay ? (
    <ReplayStreamView key={sessionId} session={sessionQ.data} compact={compact} />
  ) : (
    <LiveStreamView key={sessionId} session={sessionQ.data} compact={compact} interactive={interactive} focusSubagent={focusSubagent} />
  );
}
