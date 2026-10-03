/**
 * Run replay (spec §18 "Oturum tekrar oynatma", §19 level 4): the run's event log rebuilt into
 * node / agent / gate state at any moment. A scrubber with play/pause, 1×–8× speed and key-moment
 * markers drives the flow canvas (nodes morph, batons hand off, gates check / shake as the
 * playhead passes) and an event list that follows the playhead. Running runs keep streaming in.
 */
import { ChevronLeft, ListFilter } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import { formatDateTime } from "@/i18n/format";
import { useEventStream, type StudioEvent } from "@/lib/events";
import { useReducedMotionPref } from "@/motion/hooks";
import { variants } from "@/motion/tokens";
import { Button, EmptyState, isTypingTarget, Kbd, SegmentedControl, Skeleton, uiStrings } from "@/ui";

import { useRunSessions, useTaskDetail, useTimeline } from "./api";
import { PageError, SectionTitle, StatusPill } from "./components/bits";
import { EventList, type EventRow } from "./components/EventList";
import { FlowCanvas } from "./components/FlowCanvas";
import { useNodeInfo } from "./components/nodeInfo";
import { ReplayStatePanel } from "./components/ReplayState";
import { Scrubber, type ScrubberMoment } from "./components/Scrubber";
import { describeEvent, isKeyEvent, type DescribeContext } from "./describe";
import { isNotFound } from "./errors";
import { deriveFlow, layoutGraph } from "./graph";
import { buildTimeAxis, keyMoments, lastIndexAtOrBefore, Replay } from "./replay";
import { defaultSpeed, type Speed } from "./replayClock";
import { s } from "./strings";

const HANDOFF_MS = 2600;

function ReplaySkeleton() {
  return (
    <div aria-busy aria-label={s.replayLoading} className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-8 pt-5 pb-16">
      <Skeleton width={160} height={10} />
      <Skeleton width="36%" height={26} />
      <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-1">
        <div className="flex items-center gap-14 py-6">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} width={200} height={72} className="rounded-xl" />
          ))}
        </div>
        <Skeleton height={36} className="rounded-lg" />
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_400px] gap-5">
        <Skeleton height={260} className="rounded-xl" />
        <Skeleton height={260} className="rounded-xl" />
      </div>
    </div>
  );
}

export function RunPage({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const reduced = useReducedMotionPref();
  const timelineQ = useTimeline(runId);
  const page = timelineQ.data;
  const run = page?.run;
  const detailQ = useTaskDetail(run?.task_id ?? "");
  const sessionsQ = useRunSessions(runId);

  // ------------------------------------------------------------------ events (+ live tail)
  const [extra, setExtra] = useState<StudioEvent[]>([]);
  const isLive = run?.status === "running" || run?.status === "waiting";
  const onBatch = useCallback((batch: StudioEvent[]) => setExtra((prev) => [...prev, ...batch.filter((e) => e.id > 0)]), []);
  useEventStream(isLive && page ? { run_id: runId, ephemeral: false, after: page.events[page.events.length - 1]?.id ?? 0 } : null, onBatch);

  const events = useMemo(() => {
    const seen = new Set<number>();
    const out: StudioEvent[] = [];
    for (const e of [...(page?.events ?? []), ...extra]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }, [extra, page?.events]);

  const replay = useMemo(() => new Replay(events), [events]);
  const runEnded = events.some((e) => e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled");
  const axis = useMemo(
    () =>
      buildTimeAxis(replay.times, {
        start: run ? Date.parse(run.started_at) : undefined,
        end: run?.finished_at && runEnded ? Date.parse(run.finished_at) : undefined,
      }),
    [replay, run, runEnded],
  );
  const positions = useMemo(() => replay.times.map(axis.toPos), [axis, replay]);

  // ------------------------------------------------------------------ labels
  const graph = run?.graph ?? null;
  const sessions = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);
  const ctx = useMemo<DescribeContext>(() => {
    const labels = new Map(graph?.nodes.map((n) => [n.id, n.label]) ?? []);
    const sess = new Map(sessions.map((sv) => [sv.id, sv.label || sv.title || uiStrings.agentRole[sv.role]]));
    return { nodeLabel: (id) => labels.get(id) ?? id, sessionLabel: (id) => sess.get(id) ?? "Ajan" };
  }, [graph, sessions]);
  const moments = useMemo<ScrubberMoment[]>(
    () => keyMoments(replay.events, (e) => describeEvent(e, ctx).title).map((m) => ({ ...m, pos: axis.toPos(m.time) })),
    [axis, ctx, replay],
  );

  // ------------------------------------------------------------------ playback
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speedPick, setSpeed] = useState<Speed | null>(null);
  const speed = speedPick ?? defaultSpeed(axis.duration);
  const posRef = useRef(0);
  const durationRef = useRef(axis.duration);
  useEffect(() => {
    durationRef.current = axis.duration;
  }, [axis.duration]);

  const seek = useCallback((p: number) => {
    posRef.current = p;
    setPos(p);
  }, []);

  // Autoplay once the timeline is there (not with reduced motion: the user starts it).
  const autoplayed = useRef(false);
  useEffect(() => {
    if (autoplayed.current || !page || reduced || replay.events.length === 0) return;
    autoplayed.current = true;
    const t = setTimeout(() => setPlaying(true), 450);
    return () => clearTimeout(t);
  }, [page, reduced, replay.events.length]);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = requestAnimationFrame(function tick(t) {
      const dt = Math.min(100, t - last);
      last = t;
      const next = Math.min(durationRef.current, posRef.current + dt * speed);
      posRef.current = next;
      setPos(next);
      if (next >= durationRef.current && !isLive) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [isLive, playing, speed]);

  const togglePlay = useCallback(() => {
    if (!playing && posRef.current >= durationRef.current - 1) seek(0);
    setPlaying((p) => !p);
  }, [playing, seek]);

  const index = lastIndexAtOrBefore(positions, pos);
  const state = useMemo(() => replay.stateAt(index), [index, replay]);
  const time = axis.toTime(pos);
  const secondTime = Math.floor(time / 1000) * 1000;
  // The canvas only needs ~5 updates per second of playback (baton windows), not one per frame.
  const quantum = 200 * speed;
  const canvasTime = Math.floor(time / quantum) * quantum;

  const seekToIndex = useCallback((i: number) => seek(positions[i] ?? 0), [positions, seek]);
  const jumpMoment = useCallback(
    (dir: 1 | -1) => {
      const list = dir > 0 ? moments.filter((m) => m.pos > pos + 1) : moments.filter((m) => m.pos < pos - 1).reverse();
      const m = list[0];
      if (m) seek(m.pos);
    },
    [moments, pos, seek],
  );

  // keyboard: Space play/pause · ←/→ event · ⇧←/⇧→ key moment
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const target = e.target as HTMLElement | null;
      if (e.key === " " && !target?.closest("button,[role=radio],a")) {
        e.preventDefault();
        togglePlay();
      } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.shiftKey) {
        e.preventDefault();
        jumpMoment(e.key === "ArrowRight" ? 1 : -1);
      } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !target?.closest("[role=slider],[role=radiogroup],.react-flow")) {
        e.preventDefault();
        seekToIndex(Math.max(0, Math.min(replay.events.length - 1, index + (e.key === "ArrowRight" ? 1 : -1))));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, jumpMoment, replay.events.length, seekToIndex, togglePlay]);

  // ------------------------------------------------------------------ canvas
  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);
  const handoffs = useMemo(() => new Map(Object.entries(state.handoffs)), [state.handoffs]);
  const view = useMemo(
    () => (graph && layout ? deriveFlow(graph, state.nodeRuns, { handoffs, now: canvasTime, handoffMs: HANDOFF_MS * speed, topology: layout.topology }) : null),
    [canvasTime, graph, handoffs, layout, speed, state.nodeRuns],
  );
  const agents = useMemo(() => Object.values(state.agents), [state.agents]);
  const sessionLike = useMemo(
    () => [...sessions.map((sv) => ({ node_id: sv.node_id, provider: sv.provider, model: sv.model })), ...agents.filter((a) => a.provider).map((a) => ({ node_id: a.nodeId, provider: a.provider!, model: a.model ?? null }))],
    [agents, sessions],
  );
  const gateSummaries = useMemo(() => state.gates.map((g) => ({ node_id: g.nodeId, summary: g.summary, attempt: g.attempt })), [state.gates]);
  const progress = useMemo(() => new Map(Object.entries(state.progress)), [state.progress]);
  const { info } = useNodeInfo({ view, sessions: sessionLike, gates: gateSummaries, progress, at: secondTime });

  const [selected, setSelected] = useState<string | null>(null);
  const selectedId = selected && view?.nodes[selected] ? selected : (view?.focus ?? null);

  // ------------------------------------------------------------------ event list
  const [filter, setFilter] = useState<"key" | "all">("key");
  const rows = useMemo<EventRow[]>(() => {
    const out: EventRow[] = [];
    replay.events.forEach((ev, i) => {
      if (filter === "key" && !isKeyEvent(ev)) return;
      out.push({ index: i, elapsed: replay.times[i]! - axis.start, description: describeEvent(ev, ctx) });
    });
    return out;
  }, [axis.start, ctx, filter, replay]);

  // ------------------------------------------------------------------ render
  if (timelineQ.isPending) return <ReplaySkeleton />;
  if (timelineQ.isError || !page || !run) {
    return (
      <PageError
        error={timelineQ.error}
        notFound={isNotFound(timelineQ.error)}
        onRetry={() => void timelineQ.refetch()}
        back={
          <Button variant="secondary" onClick={() => void navigate(-1)}>
            {s.back}
          </Button>
        }
      />
    );
  }

  const task = detailQ.data?.task;
  const sv = selectedId && view ? view.nodes[selectedId] : undefined;

  return (
    <motion.div variants={variants.page} initial="initial" animate="animate" className="mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-8 pt-5 pb-16">
      <header className="flex flex-col gap-3">
        <nav aria-label="Konum" className="flex min-w-0 items-center gap-1 text-xs text-fg-faint">
          <Link to="/tasks" className="-ml-1 inline-flex items-center gap-0.5 rounded-md py-0.5 pr-1.5 pl-0.5 text-fg-muted outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]">
            <ChevronLeft className="size-3.5" aria-hidden />
            {s.breadcrumbTasks}
          </Link>
          <span aria-hidden>/</span>
          <Link to={`/tasks/${run.task_id}`} className="min-w-0 truncate rounded-md px-1 py-0.5 text-fg-muted outline-none hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]">
            {task?.title ?? run.task_id}
          </Link>
          <span aria-hidden>/</span>
          <span>{s.replayTitle}</span>
        </nav>
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl leading-tight text-fg">{s.replayTitle}</h1>
              <StatusPill status={replay.events.length ? state.runStatus : run.status} className="mt-1" />
            </div>
            <p className="flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
              <span className="min-w-0 truncate">{task?.title}</span>
              {task && <span aria-hidden className="text-fg-faint">·</span>}
              <span>{formatDateTime(run.started_at)}</span>
              <span aria-hidden className="text-fg-faint">·</span>
              <span className="tabular">{s.eventCount(replay.events.length)}</span>
              <span aria-hidden className="text-fg-faint">·</span>
              <span className="font-mono text-2xs">{run.id}</span>
            </p>
          </div>
          <Button variant="secondary" icon={<ChevronLeft />} onClick={() => void navigate(`/tasks/${run.task_id}`)}>
            {s.backToTask}
          </Button>
        </div>
      </header>

      {replay.events.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface shadow-1">
          <EmptyState title={s.replayEmpty} />
        </div>
      ) : (
        <>
          <section aria-label={s.flow} className="overflow-hidden rounded-xl border border-line bg-surface shadow-1">
            <div className="bg-canvas-subtle bg-[radial-gradient(var(--line)_1px,transparent_1px)] [background-size:18px_18px]">
              {layout && view && <FlowCanvas layout={layout} view={view} info={info} selected={selectedId} onSelect={setSelected} />}
            </div>
            <div className="border-t border-line-subtle">
              <Scrubber
                duration={axis.duration}
                pos={pos}
                onSeek={seek}
                playing={playing}
                onTogglePlay={togglePlay}
                speed={speed}
                onSpeed={setSpeed}
                moments={moments}
                gaps={axis.gaps}
                elapsedAt={(p) => axis.toTime(p) - axis.start}
                timeAt={axis.toTime}
                live={isLive}
              />
            </div>
          </section>

          <div className="grid grid-cols-[minmax(0,1fr)_400px] items-start gap-5">
            <ReplayStatePanel
              index={index}
              current={index >= 0 ? describeEvent(replay.events[index]!, ctx) : null}
              elapsed={time - axis.start}
              node={sv}
              state={state}
              sessions={sessions}
              sessionLabel={ctx.sessionLabel}
              nodeLabel={ctx.nodeLabel}
            />

            {/* events */}
            <section aria-labelledby="events-title" className="flex h-[560px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-1">
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line-subtle px-4">
                <SectionTitle id="events-title" count={rows.length}>
                  {s.events}
                </SectionTitle>
                <div className="ml-auto flex items-center gap-2">
                  <ListFilter className="size-3.5 text-fg-faint" aria-hidden />
                  <SegmentedControl
                    size="sm"
                    aria-label={s.events}
                    value={filter}
                    onValueChange={setFilter}
                    options={[
                      { value: "key", label: s.keyEvents },
                      { value: "all", label: s.allEvents },
                    ]}
                  />
                </div>
              </div>
              <EventList rows={rows} current={index} smooth={!playing && !reduced} onSeek={seekToIndex} label={s.events} />
              <div className="flex h-9 shrink-0 items-center gap-1.5 border-t border-line-subtle px-4 text-2xs whitespace-nowrap text-fg-faint">
                <Kbd keys={["Boşluk"]} /> {s.play.toLocaleLowerCase("tr")}
                <span className="mx-1 text-line-strong">·</span>
                <Kbd keys={["←", "→"]} /> {s.prevNextEvent}
                <span className="mx-1 text-line-strong">·</span>
                <Kbd keys={["⇧", "→"]} /> {s.nextMoment.toLocaleLowerCase("tr")}
              </div>
            </section>
          </div>
        </>
      )}
    </motion.div>
  );
}
