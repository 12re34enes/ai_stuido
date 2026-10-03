import {
  BadgeCheck,
  BookOpen,
  CheckCheck,
  Database,
  Gauge,
  GitMerge,
  Inbox,
  ListChecks,
  MessageCircleQuestion,
  Rocket,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { ApiError } from "@/lib/api";
import { useDecideApproval, usePendingApprovals } from "@/lib/queries";
import type { Approval, ApprovalKind } from "@/lib/types";
import { variants } from "@/motion/tokens";
import { Button, cn, CountBadge, EmptyState, EnvBadge, Popover, ScrollArea, Textarea, toast, Tooltip } from "@/ui";

import { shellStrings as s } from "./strings";

const kindIcon: Record<ApprovalKind, LucideIcon> = {
  plan: ListChecks,
  memory: BookOpen,
  remote_command: Terminal,
  db_write: Database,
  deploy: Rocket,
  merge: GitMerge,
  final: BadgeCheck,
  tool_permission: Wrench,
  question: MessageCircleQuestion,
  budget: Gauge,
  custom: Inbox,
};

function ApprovalRow({ approval, now }: { approval: Approval; now: number }) {
  const present = useIsPresent();
  const decide = useDecideApproval();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const Icon = kindIcon[approval.kind] ?? Inbox;

  const submit = (approve: boolean) =>
    decide.mutate(
      { id: approval.id, approve, note: approve ? undefined : note.trim() || undefined },
      {
        onSuccess: () =>
          approve
            ? toast.success(s.approvals.approved, { description: approval.title })
            : toast({ title: s.approvals.rejected, description: approval.title }),
        onError: (err) => toast.error(s.approvals.failed, { description: err instanceof ApiError ? err.message : undefined }),
      },
    );

  return (
    <motion.li
      layout
      variants={variants.dismissRight}
      initial="initial"
      animate="animate"
      exit="exit"
      // A decided row slides away; it must not take clicks or focus while it does.
      inert={!present}
      aria-hidden={!present || undefined}
      className="list-none"
    >
      <div className={cn("flex flex-col gap-2.5 rounded-lg border bg-surface p-3", approval.production ? "border-env-production/40" : "border-line")}>
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "grid size-7 shrink-0 place-items-center rounded-md [&_svg]:size-3.5",
              approval.production ? "bg-env-production-soft text-env-production" : "bg-surface-sunken text-fg-muted",
            )}
          >
            <Icon />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="text-2xs font-medium text-fg-muted">{s.approvals.kinds[approval.kind] ?? approval.kind}</span>
              {approval.production && <EnvBadge environment="production" size="sm" className="h-4 px-1.5" />}
              <span className="ml-auto shrink-0 text-2xs text-fg-faint">{relativeTime(approval.created_at, new Date(now))}</span>
            </div>
            <p className="line-clamp-2 text-sm leading-[18px] font-medium text-fg">{approval.title}</p>
            {approval.summary && <p className="line-clamp-2 text-xs text-fg-muted">{approval.summary}</p>}
          </div>
        </div>
        <AnimatePresence mode="popLayout" initial={false}>
          {rejecting ? (
            <motion.div key="reject" {...variants.fadeUp} className="flex flex-col gap-2">
              <Textarea
                autoFocus
                minRows={2}
                maxRows={5}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={s.approvals.note}
                className="text-xs"
              />
              <div className="flex justify-end gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
                  {s.approvals.cancel}
                </Button>
                <Button size="sm" variant="danger" loading={decide.isPending} onClick={() => submit(false)}>
                  {s.approvals.reject}
                </Button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="actions" {...variants.fade} className="flex justify-end gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => setRejecting(true)} disabled={decide.isPending}>
                {s.approvals.reject}
              </Button>
              <Button size="sm" variant={approval.production ? "danger" : "primary"} loading={decide.isPending} onClick={() => submit(true)}>
                {s.approvals.approve}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.li>
  );
}

/** Approval counter (spec §19) with an inbox popover for deciding in place. */
export function ApprovalsWidget() {
  const { data, isError } = usePendingApprovals();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const now = useNow(30_000, open);
  if (isError && !data) return null;
  const items = data ?? [];
  const hasProduction = items.some((a) => a.production);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={s.approvals.title}
      className="flex w-[380px] flex-col overflow-hidden p-0"
      trigger={
        <span className="no-drag inline-flex">
          <Tooltip content={s.approvals.count(items.length)}>
            <button
              type="button"
              aria-label={`${s.topbar.approvals}: ${s.approvals.count(items.length)}`}
              className="relative grid size-7 place-items-center rounded-md text-fg-muted outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
            >
              <Inbox className="size-4" />
              <CountBadge count={items.length} tone={hasProduction ? "danger" : "accent"} className="absolute -top-1 -right-1.5" />
            </button>
          </Tooltip>
        </span>
      }
    >
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-4 py-2.5">
        <span className="text-xs font-medium text-fg">{s.approvals.title}</span>
        <Button
          size="sm"
          variant="ghost"
          className="-mr-2 h-6 px-2"
          onClick={() => {
            setOpen(false);
            void navigate("/approvals");
          }}
        >
          {s.approvals.viewAll}
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState size="sm" icon={<CheckCheck />} title={s.approvals.empty} description={s.approvals.emptyHint} />
      ) : (
        <ScrollArea className="max-h-[440px]" viewportClassName="max-h-[440px]">
          <ul className="flex flex-col gap-2 p-2.5">
            <AnimatePresence initial={false} mode="popLayout">
              {items.map((a) => (
                <ApprovalRow key={a.id} approval={a} now={now} />
              ))}
            </AnimatePresence>
          </ul>
        </ScrollArea>
      )}
    </Popover>
  );
}
