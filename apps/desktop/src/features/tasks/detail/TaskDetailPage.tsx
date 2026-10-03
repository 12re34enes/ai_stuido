/**
 * Task detail (spec §19 "Görev detayı"): header with live status, quality and actions; the flow
 * progress canvas with live node states and baton hand-offs; a tabbed panel for the selected node
 * (agents → drawer, gates with evidence, output), the run's changes, gate overview and checkpoints;
 * usage and runs on the side. Live through one task event stream that patches the caches.
 */
import { History } from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useEnvironmentScope } from "@/lib/environment";
import { usePendingApprovals, useWorkspaces } from "@/lib/queries";
import { spring, variants } from "@/motion/tokens";
import { Button, ProgressBar, Tabs, TabsContent, TabsList, TabsTrigger, toast } from "@/ui";

import {
  downloadTaskExport,
  useCancelTask,
  usePreviewGraph,
  useRateTask,
  useRestoreCheckpoint,
  useRetryNode,
  useRun,
  useRunCheckpoints,
  useRunEvidence,
  useRunGates,
  useRunSessions,
  useStartTask,
  useTaskDetail,
  useTaskQuality,
  useTaskUsage,
  useWorkspaceRepos,
  type ExportFormat,
} from "./api";
import { useTaskCommands } from "./commands";
import { PageError, SectionTitle, Swap, TaskPageSkeleton } from "./components/bits";
import { errorMessage, isNotFound } from "./errors";
import { ChangesPanel } from "./components/ChangesPanel";
import { Checkpoints } from "./components/Checkpoints";
import { FlowCanvas } from "./components/FlowCanvas";
import { NodePanel } from "./components/NodePanel";
import { useNodeInfo } from "./components/nodeInfo";
import { GatesList, RunsCard, TaskApprovals, UsageCard } from "./components/Side";
import { TaskHeader } from "./components/TaskHeader";
import { deriveFlow, layoutGraph } from "./graph";
import { useTaskLive } from "./live";
import { s } from "./strings";
import type { CheckpointInfo } from "./types";

type Tab = "node" | "changes" | "gates" | "checkpoints";

export function TaskDetailPage({ taskId }: { taskId: string }) {
  const navigate = useNavigate();
  const detailQ = useTaskDetail(taskId);
  const detail = detailQ.data;
  const task = detail?.task;

  // ------------------------------------------------------------------ run selection
  const [runPick, setRunPick] = useState<string | null>(null);
  const runId = runPick ?? detail?.current_run?.id ?? task?.current_run_id ?? null;
  const runQ = useRun(runId);
  const run = runQ.data ?? (detail?.current_run?.id === runId ? detail.current_run : null) ?? null;
  const previewQ = usePreviewGraph(task, Boolean(detail) && !runId);
  const graph = run?.graph ?? (runId ? null : (previewQ.data ?? null));
  const preview = !run;

  const gatesQ = useRunGates(runId);
  const evidenceQ = useRunEvidence(runId);
  const checkpointsQ = useRunCheckpoints(runId);
  const sessionsQ = useRunSessions(runId);
  const usageQ = useTaskUsage(taskId);
  const qualityQ = useTaskQuality(taskId, Boolean(runId) && !detail?.quality);
  const reposQ = useWorkspaceRepos(task?.workspace_id);
  const workspacesQ = useWorkspaces();
  const approvalsQ = usePendingApprovals();
  const approvals = useMemo(() => (approvalsQ.data ?? []).filter((a) => a.task_id === taskId), [approvalsQ.data, taskId]);
  const workspaceName = workspacesQ.data?.find((w) => w.id === task?.workspace_id)?.name;

  // A pending production approval of this task puts the window into production mode.
  useEnvironmentScope(approvals.some((a) => a.production) ? "production" : null, task?.title);

  // ------------------------------------------------------------------ live
  const live = useTaskLive(taskId, {
    onConflict: (p) => toast({ title: s.conflictToast(String(p.repo ?? "")), tone: "warning" }),
  });

  // ------------------------------------------------------------------ flow view
  const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);
  const view = useMemo(
    () => (graph && layout ? deriveFlow(graph, run?.nodes ?? [], { handoffs: live.handoffs, now: live.now, topology: layout.topology }) : null),
    [graph, layout, live.handoffs, live.now, run?.nodes],
  );
  const sessions = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);
  const { info, providers } = useNodeInfo({ view, sessions, gates: gatesQ.data, progress: live.progress });

  // When the page opens on a running flow, play the hand-off into the active nodes once.
  const seeded = useRef<string | null>(null);
  const { seedHandoffs } = live;
  useEffect(() => {
    if (!run || !view || seeded.current === run.id) return;
    seeded.current = run.id;
    seedHandoffs(view.edges.filter((e) => !e.back && e.state === "done" && (view.nodes[e.target]?.status === "running" || view.nodes[e.target]?.status === "waiting")).map((e) => e.id));
  }, [run, seedHandoffs, view]);

  const [selected, setSelected] = useState<string | null>(null);
  const selectedId = selected && view?.nodes[selected] ? selected : (view?.focus ?? null);
  const [tab, setTab] = useState<Tab>("node");
  const tabsRef = useRef<HTMLDivElement>(null);

  const nodeLabel = useCallback((id: string) => graph?.nodes.find((n) => n.id === id)?.label ?? id, [graph]);

  // ------------------------------------------------------------------ actions
  const start = useStartTask(taskId);
  const cancel = useCancelTask(taskId);
  const rate = useRateTask(taskId);
  const retryNode = useRetryNode(runId);
  const restore = useRestoreCheckpoint(runId);
  const [exporting, setExporting] = useState(false);

  const onStart = useCallback(
    (opts: { now?: boolean; start_on_reset?: boolean } = {}) => {
      setRunPick(null);
      start.mutate(opts, {
        onSuccess: (d) => toast.success(d.task.status === "queued" ? s.queued : s.started_),
        onError: (e) => toast({ title: errorMessage(e), tone: "danger" }),
      });
    },
    [start],
  );
  const onCancel = useCallback(() => {
    cancel.mutate(undefined, {
      onSuccess: () => toast.info(s.cancelled),
      onError: (e) => toast({ title: errorMessage(e), tone: "danger" }),
    });
  }, [cancel]);
  const onExport = useCallback(
    (format: ExportFormat) => {
      setExporting(true);
      downloadTaskExport(taskId, format)
        .then((name) => toast.success(s.exportDone(name)))
        .catch((e: unknown) => toast({ title: s.exportFailed, description: errorMessage(e), tone: "danger" }))
        .finally(() => setExporting(false));
    },
    [taskId],
  );
  const onRate = useCallback(
    (n: number) => rate.mutate(n, { onSuccess: () => toast.success(s.rated(n)), onError: (e) => toast({ title: s.rateFailed, description: errorMessage(e), tone: "danger" }) }),
    [rate],
  );
  const onRetry = useCallback(
    (nodeId: string) =>
      retryNode.mutate(nodeId, {
        onSuccess: () => toast.info(s.retried(nodeLabel(nodeId))),
        onError: (e) => toast({ title: s.retryFailed, description: errorMessage(e), tone: "danger" }),
      }),
    [nodeLabel, retryNode],
  );
  const onRestore = useCallback(
    (ck: CheckpointInfo) =>
      restore.mutate(ck.id, {
        onSuccess: () => toast.success(s.restored(ck.label)),
        onError: (e) => toast({ title: s.restoreFailed, description: errorMessage(e), tone: "danger" }),
      }),
    [restore],
  );
  const openReplay = useCallback(() => {
    if (runId) void navigate(`/tasks/runs/${runId}`);
  }, [navigate, runId]);
  const openChanges = useCallback(() => {
    setTab("changes");
    requestAnimationFrame(() => tabsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);
  const selectNode = useCallback((id: string) => {
    setSelected(id);
    setTab("node");
  }, []);

  const failedNode = useMemo(() => {
    if (!view || !run || run.status === "completed") return null;
    const f = Object.values(view.nodes).find((n) => n.status === "failed" && !n.stale);
    return f ? { id: f.id, label: f.node.label } : null;
  }, [run, view]);

  useTaskCommands({
    taskId,
    title: task?.title,
    status: task?.status,
    runId,
    failedNode,
    onCancel,
    onStart,
    onExport,
    onOpenChanges: openChanges,
    onOpenReplay: openReplay,
    onRetry,
  });

  // ------------------------------------------------------------------ render
  if (detailQ.isPending) return <TaskPageSkeleton />;
  if (detailQ.isError || !detail || !task) {
    return (
      <PageError
        error={detailQ.error}
        notFound={isNotFound(detailQ.error)}
        onRetry={() => void detailQ.refetch()}
        back={
          <Button variant="secondary" onClick={() => void navigate("/tasks")}>
            {s.back}
          </Button>
        }
      />
    );
  }

  const gateCount = gatesQ.data?.length ?? 0;
  const checkpointCount = checkpointsQ.data?.length ?? 0;
  const runFinished = run?.status === "completed";
  const progressPct = view && view.total ? (view.done / view.total) * 100 : 0;

  return (
    <motion.div variants={variants.page} initial="initial" animate="animate" className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-8 pt-5 pb-16">
      <TaskHeader
        detail={detail}
        liveQuality={qualityQ.data?.score != null ? qualityQ.data : null}
        workspaceName={workspaceName}
        repos={reposQ.data}
        runId={runId}
        onOpenReplay={openReplay}
        onStart={onStart}
        onCancel={onCancel}
        onExport={onExport}
        onRate={onRate}
        starting={start.isPending}
        cancelling={cancel.isPending}
        exporting={exporting}
      />

      <TaskApprovals approvals={approvals} />

      {/* flow progress */}
      <motion.section layout="position" transition={spring.layout} aria-labelledby="flow-title" className="overflow-hidden rounded-xl border border-line bg-surface shadow-1">
        <div className="flex h-12 items-center gap-3 border-b border-line-subtle px-5">
          <SectionTitle id="flow-title">{s.flow}</SectionTitle>
          {view && !preview && (
            <div className="flex items-center gap-2.5">
              <span className="text-xs whitespace-nowrap text-fg-muted tabular">{s.flowProgress(view.done, view.total)}</span>
              <div className="w-24">
                <ProgressBar value={progressPct} size="xs" tone={run?.status === "failed" ? "danger" : run?.status === "completed" ? "success" : "accent"} aria-label={s.flowProgress(view.done, view.total)} />
              </div>
            </div>
          )}
          {preview && graph && <span className="truncate text-xs text-fg-faint">{s.flowPreview}</span>}
          <div className="ml-auto flex items-center gap-1">
            {runId && (
              <Button size="sm" variant="ghost" icon={<History />} onClick={openReplay}>
                {s.replay}
              </Button>
            )}
          </div>
        </div>
        <div className="bg-canvas-subtle bg-[radial-gradient(var(--line)_1px,transparent_1px)] [background-size:18px_18px]">
          {layout && view ? (
            <FlowCanvas layout={layout} view={view} info={info} selected={selectedId} onSelect={selectNode} preview={preview} />
          ) : (runId && runQ.isPending) || previewQ.isFetching ? (
            <div className="flex h-[168px] items-center gap-16 px-8">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="h-[78px] w-[220px] animate-pulse rounded-xl bg-surface-sunken" />
              ))}
            </div>
          ) : (
            <div className="grid h-[148px] place-items-center px-6 text-center">
              <div className="flex flex-col items-center gap-1">
                <span className="font-serif text-md text-fg">{s.notStartedTitle}</span>
                <span className="text-sm text-fg-muted">{runQ.isError ? errorMessage(runQ.error) : s.notStartedBody}</span>
              </div>
            </div>
          )}
        </div>
      </motion.section>

      {/* node / changes / gates / checkpoints + side */}
      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-6">
        <section ref={tabsRef} className="min-w-0 scroll-mt-4 rounded-xl border border-line bg-surface shadow-1">
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList aria-label="Görev ayrıntıları" className="px-5">
              <TabsTrigger value="node">
                {s.tabNode}
                {selectedId && view?.nodes[selectedId] ? <span className="max-w-40 truncate font-normal text-fg-faint">· {view.nodes[selectedId]!.node.label}</span> : null}
              </TabsTrigger>
              <TabsTrigger value="changes">{s.tabChanges}</TabsTrigger>
              <TabsTrigger value="gates" trailing={gateCount ? <span className="text-xs font-normal text-fg-faint tabular">{gateCount}</span> : undefined}>
                {s.tabGates}
              </TabsTrigger>
              <TabsTrigger value="checkpoints" trailing={checkpointCount ? <span className="text-xs font-normal text-fg-faint tabular">{checkpointCount}</span> : undefined}>
                {s.tabCheckpoints}
              </TabsTrigger>
            </TabsList>
            <div className="p-5">
              <TabsContent value="node">
                {view && (
                  <Swap k={selectedId ?? "none"}>
                    <NodePanel
                      run={run}
                      view={view}
                      nodeId={selectedId}
                      provider={selectedId ? providers.get(selectedId) : undefined}
                      gates={gatesQ.data}
                      gatesLoading={gatesQ.isPending && Boolean(runId)}
                      gatesError={gatesQ.error}
                      onRetryGates={() => void gatesQ.refetch()}
                      evidence={evidenceQ.data}
                      sessions={sessions}
                      lastLines={live.lastLines}
                      progress={selectedId ? live.progress.get(selectedId) : undefined}
                      waitingReason={selectedId ? live.waiting.get(selectedId) : undefined}
                      approvals={approvals}
                      canRetry={Boolean(runId) && !runFinished}
                      retrying={retryNode.isPending}
                      onRetry={onRetry}
                      preview={preview}
                    />
                  </Swap>
                )}
              </TabsContent>
              <TabsContent value="changes">
                <ChangesPanel runId={runId} repos={reposQ.data} />
              </TabsContent>
              <TabsContent value="gates">
                <GatesList gates={gatesQ.data} loading={gatesQ.isPending && Boolean(runId)} error={gatesQ.error} onRetry={() => void gatesQ.refetch()} nodeLabel={nodeLabel} onSelect={selectNode} />
              </TabsContent>
              <TabsContent value="checkpoints">
                <Checkpoints
                  checkpoints={checkpointsQ.data}
                  loading={checkpointsQ.isPending && Boolean(runId)}
                  error={checkpointsQ.error}
                  onRetry={() => void checkpointsQ.refetch()}
                  nodeLabel={nodeLabel}
                  onRestore={onRestore}
                  restoringId={restore.isPending ? (restore.variables ?? null) : null}
                />
              </TabsContent>
            </div>
          </Tabs>
        </section>

        <aside className="sticky top-5 flex flex-col gap-4" aria-label={s.usage}>
          {detail.runs.length > 0 && <UsageCard usage={usageQ.data} loading={usageQ.isPending} error={usageQ.error} onRetry={() => void usageQ.refetch()} budget={task.budget} />}
          <RunsCard
            runs={detail.runs}
            selected={runId}
            onSelect={(id) => {
              setRunPick(id === detail.current_run?.id ? null : id);
              setSelected(null);
            }}
            onReplay={(id) => void navigate(`/tasks/runs/${id}`)}
          />
        </aside>
      </div>
    </motion.div>
  );
}
