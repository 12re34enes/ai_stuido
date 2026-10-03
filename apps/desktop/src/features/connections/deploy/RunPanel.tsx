import { Ban, HeartPulse, Hourglass, Inbox, Undo2, UserCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { formatDateTime, formatDuration } from "@/i18n/format";
import { useEventStream } from "@/lib/events";
import { variants } from "@/motion/tokens";
import { Badge, Button, Divider, LogView, Skeleton, toast } from "@/ui";

import { useCancelDeploy, useDeployRun, useRollbackDeploy } from "../api";
import { Callout, errorMessage, ErrorState, RunStatusBadge } from "../kit";
import { actorLabel, approverLabel, logLines, stampLine } from "../format";
import { connStrings as s } from "../strings";
import type { DeployRun } from "../types";

const d = s.deploy.detail;
const LIVE: DeployRun["status"][] = ["running", "pending_approval"];

/** One deploy run: status, approval waiting state, actions and the live log. */
export function RunPanel({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const run = useDeployRun(runId);
  const cancel = useCancelDeploy();
  const rollback = useRollbackDeploy();
  const [live, setLive] = useState<string[]>([]);
  const data = run.data;
  const streaming = data ? LIVE.includes(data.status) : false;

  useEventStream(streaming && data ? { types: ["deploy.*"], workspace_id: data.workspace_id } : null, (batch) => {
    const lines = batch
      .filter((ev) => ev.type === "deploy.log" && ev.payload.deploy_id === runId && typeof ev.payload.line === "string")
      .flatMap((ev) => String(ev.payload.line).split("\n").map((l) => stampLine(ev.ts, l)));
    if (lines.length) setLive((old) => [...old, ...lines].slice(-4000));
  });

  if (run.isPending)
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton height={14} width="40%" />
        <Skeleton height={260} />
      </div>
    );
  if (run.isError || !data) return <ErrorState error={run.error} onRetry={() => void run.refetch()} size="sm" />;

  // The stored log is written when a run finishes: while it runs, live lines extend it.
  const stored = logLines(data.log);
  const lines = streaming ? [...stored, ...live.filter((l) => !stored.includes(l))] : stored;
  const duration = data.finished_at ? new Date(data.finished_at).getTime() - new Date(data.started_at).getTime() : null;

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <RunStatusBadge status={data.status} size="md" />
        {data.ref && <code className="rounded-md bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-fg">{data.ref}</code>}
        {data.rollback_of && (
          <Badge tone="neutral" size="sm" icon={<Undo2 aria-hidden />}>
            {d.rollbackOf}
          </Badge>
        )}
        <span className="text-xs text-fg-muted">{formatDateTime(data.started_at)}</span>
        {duration !== null && <span className="text-xs text-fg-faint tabular">· {formatDuration(duration)}</span>}
        <span className="flex-1" />
        {LIVE.includes(data.status) && (
          <Button
            size="sm"
            icon={<Ban />}
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate(data.id, {
                onSuccess: () => toast({ title: s.deploy.cancelled }),
                onError: (e) => toast.error(s.common.unknownError, { description: errorMessage(e) }),
              })
            }
          >
            {s.deploy.cancel}
          </Button>
        )}
        {data.rollback_available && (
          <Button
            size="sm"
            variant="danger"
            icon={<Undo2 />}
            loading={rollback.isPending}
            onClick={() =>
              rollback.mutate(data.id, {
                onSuccess: (r) => {
                  toast.success(s.deploy.rollbackStarted, { description: data.profile_name });
                  void navigate(`/connections/deploy/${encodeURIComponent(r.profile_id)}?run=${encodeURIComponent(r.id)}`, { replace: true });
                },
                onError: (e) => toast.error(s.common.unknownError, { description: errorMessage(e) }),
              })
            }
          >
            {s.deploy.rollback}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 text-xs text-fg-muted">
        <span>{d.by(actorLabel(data.actor))}</span>
        {data.approved_by && (
          <span className="flex items-center gap-1">
            <UserCheck className="size-3.5" aria-hidden />
            {d.approvedBy(approverLabel(data.approved_by))}
          </span>
        )}
        {data.health_ok !== null && (
          <span className={data.health_ok ? "flex items-center gap-1 text-success" : "flex items-center gap-1 text-danger"}>
            <HeartPulse className="size-3.5" aria-hidden />
            {d.health(data.health_ok)}
          </span>
        )}
      </div>
      {data.summary && <p className="px-4 pb-3 text-sm whitespace-pre-wrap text-fg">{data.summary}</p>}
      <AnimatePresence initial={false}>
        {data.status === "pending_approval" && (
          <motion.div key="wait" {...variants.fadeUp} className="px-4 pb-3">
            <Callout
              tone={data.environment === "production" ? "production" : "warning"}
              icon={<Hourglass className="animate-pulse" />}
              title={d.waitingApproval}
              actions={
                <Button size="sm" icon={<Inbox />} onClick={() => void navigate(data.approval_id ? `/approvals/${encodeURIComponent(data.approval_id)}` : "/approvals")}>
                  {d.openApproval}
                </Button>
              }
            >
              {d.waitingApprovalBody}
            </Callout>
          </motion.div>
        )}
        {data.error && data.status !== "pending_approval" && (
          <motion.div key="err" {...variants.fadeUp} className="px-4 pb-3">
            <Callout tone="danger">{data.error}</Callout>
          </motion.div>
        )}
      </AnimatePresence>
      <Divider subtle />
      <LogView lines={lines} aria-label={d.log} emptyLabel={d.logEmpty} className="h-[380px]" />
    </div>
  );
}
