/**
 * Inline permission requests (agent.permission.request / .decided). Policy auto-decisions show
 * as a quiet row; "ask" requests show a card whose buttons resolve the matching
 * tool_permission approval (payload.request_id) — the same approval the inbox shows.
 */
import { ShieldAlert, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { ApiError } from "@/lib/api";
import { useShake } from "@/motion/hooks";
import { spring, variants } from "@/motion/tokens";
import { Button, cn, EnvBadge, toast, Tooltip } from "@/ui";

import { usePendingApprovalList, useDecide, type ApprovalRecord } from "../../approvals/api";
import { CommandLine, InlineCode } from "../kit/InlineCode";
import { sessionStrings as t } from "../strings";
import { useStreamContext } from "./context";
import type { PermissionItem } from "./model";
import { RowGrid } from "./rows";

const ps = t.stream.permission;

function deciderLabel(who: string): string {
  if (who === "user") return "siz";
  if (who === "policy") return "politika";
  if (who.startsWith("channel:")) return who.slice(8).replace(/^./, (c) => c.toLocaleUpperCase("tr-TR"));
  return who;
}

function useMatchingApproval(item: PermissionItem, sessionId: string): ApprovalRecord | undefined {
  const { data } = usePendingApprovalList();
  return data?.find(
    (a) =>
      a.kind === "tool_permission" &&
      a.payload.request_id === item.requestId &&
      (a.session_id === sessionId || a.payload.session_id === sessionId || (!a.session_id && !a.payload.session_id)),
  );
}

function AutoRow({ item }: { item: PermissionItem }) {
  const { compact } = useStreamContext();
  const allow = item.verdict === "allow";
  return (
    <RowGrid
      gutter={
        <span className={cn("grid place-items-center", compact ? "h-[22px]" : "h-7", allow ? "text-fg-faint" : "text-danger")}>
          {allow ? <ShieldCheck className="size-3.5" aria-hidden /> : <ShieldX className="size-3.5" aria-hidden />}
        </span>
      }
    >
      <Tooltip content={item.policyReason ?? (allow ? ps.allowAuto : ps.denyAuto)} side="top">
        <p className={cn("flex min-w-0 items-center gap-1.5 truncate", compact ? "h-[22px] text-xs" : "h-7 text-sm")}>
          <span className={cn("shrink-0 font-medium", allow ? "text-fg-muted" : "text-danger")}>{allow ? ps.allowAuto : ps.denyAuto}</span>
          <span className="min-w-0 truncate text-fg-faint">{item.command ?? item.summary}</span>
        </p>
      </Tooltip>
    </RowGrid>
  );
}

function DecidedLine({ item, sent }: { item: PermissionItem; sent?: boolean | null }) {
  const d = item.decision ?? (sent === true || sent === false ? { allow: sent, reason: null, decidedBy: "user", approvalId: null } : null);
  if (!d) return null;
  return (
    <motion.div {...variants.fadeUp} className="flex items-center gap-2 text-xs">
      <motion.span
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1, transition: spring.bouncy }}
        className={cn("flex", d.allow ? "text-success" : "text-danger")}
      >
        {d.allow ? <ShieldCheck className="size-3.5" aria-hidden /> : <ShieldX className="size-3.5" aria-hidden />}
      </motion.span>
      <span className={cn("font-medium", d.allow ? "text-success" : "text-danger")}>{d.allow ? ps.allowed : ps.denied}</span>
      <span className="text-fg-faint">· {ps.by(deciderLabel(d.decidedBy))}</span>
      {d.reason && <span className="min-w-0 truncate text-fg-muted">· {d.reason}</span>}
    </motion.div>
  );
}

function AskCard({ item }: { item: PermissionItem }) {
  const { sessionId, interactive, replay, compact } = useStreamContext();
  const approval = useMatchingApproval(item, sessionId);
  const decide = useDecide();
  const [scope, shake] = useShake<HTMLDivElement>();
  // The approval leaves the pending list optimistically; remember our answer until the
  // agent.permission.decided event confirms it.
  const [sent, setSent] = useState<boolean | null>(null);
  const decided = item.decision !== null || sent !== null;
  const production = approval?.production === true;
  const canAct = interactive && !replay && !decided;

  const submit = (approve: boolean) => {
    if (!approval) return;
    setSent(approve);
    decide.mutate(
      { approval, approve },
      {
        onError: (err) => {
          setSent(null);
          shake();
          toast.error(ps.failed, { description: err instanceof ApiError ? err.message : undefined });
        },
      },
    );
  };

  const pendingTone = production ? "border-env-production/45 bg-env-production-soft/45" : "border-warning/35 bg-warning-soft/45";
  return (
    <RowGrid
      gutter={
        <span
          className={cn(
            "grid place-items-center",
            compact ? "h-[22px]" : "h-7",
            decided ? "text-fg-faint" : production ? "text-env-production" : "text-warning",
          )}
        >
          {production ? <ShieldAlert className="size-4" aria-hidden /> : <ShieldQuestion className="size-4" aria-hidden />}
        </span>
      }
    >
      <motion.div
        ref={scope}
        layout="position"
        transition={spring.layout}
        className={cn("flex flex-col gap-2.5 rounded-lg border p-3 transition-colors duration-300", decided ? "border-line bg-surface" : pendingTone)}
        role="group"
        aria-label={ps.title}
      >
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-2xs font-medium tracking-[0.04em] text-fg-muted uppercase">{ps.title}</span>
            <p data-selectable className={cn("text-fg [overflow-wrap:anywhere]", compact ? "text-xs" : "text-sm")}>
              <InlineCode text={item.summary} codeClassName="bg-surface/70" />
            </p>
          </div>
          {production && <EnvBadge environment="production" size="sm" />}
        </div>
        {item.command && !item.summary.includes(`\`${item.command}\``) && <CommandLine command={item.command} />}
        {item.paths.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs text-fg-muted">{ps.paths}:</span>
            {item.paths.slice(0, 8).map((p) => (
              <code key={p} className="rounded-[4px] bg-surface-sunken px-1.5 py-px font-mono text-2xs text-fg">
                {p}
              </code>
            ))}
            {item.paths.length > 8 && <span className="text-2xs text-fg-faint">+{item.paths.length - 8}</span>}
          </div>
        )}
        {item.policyReason && !decided && (
          <p className="text-xs text-fg-muted">
            <span className="font-medium">{ps.policy}:</span> {item.policyReason}
          </p>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          {decided ? (
            <DecidedLine key="decided" item={item} sent={sent} />
          ) : canAct ? (
            <motion.div key="actions" {...variants.fade} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-2xs text-fg-muted">{production ? ps.production : approval ? ps.waiting : ps.notFound}</span>
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="secondary" disabled={!approval || decide.isPending} onClick={() => submit(false)}>
                  {ps.deny}
                </Button>
                <Button
                  size="sm"
                  variant={production ? "danger" : "primary"}
                  disabled={!approval}
                  loading={decide.isPending && decide.variables?.approve === true}
                  onClick={() => submit(true)}
                >
                  {ps.allow}
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.span key="waiting" {...variants.fade} className="session-breathe text-2xs text-fg-muted">
              {ps.waiting}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.div>
    </RowGrid>
  );
}

export function PermissionRow({ item }: { item: PermissionItem }) {
  return item.verdict === "ask" ? <AskCard item={item} /> : <AutoRow item={item} />;
}
