/** Task page header: breadcrumb, title + live status, meta, prompt, quality, rating and actions. */
import {
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  FileCode2,
  FileJson,
  FileText,
  FolderGit2,
  GitBranch,
  History,
  MoreHorizontal,
  Play,
  RotateCcw,
  Timer,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Link } from "react-router";

import { formatDateTime, formatDuration, relativeTime } from "@/i18n/format";
import { useNow } from "@/hooks/useNow";
import { spring, transition } from "@/motion/tokens";
import { Badge, Button, cn, Dialog, IconButton, Menu, MenuItem, MenuLabel, MenuSeparator, Tooltip, toast } from "@/ui";

import type { ExportFormat } from "../api";
import { s } from "../strings";
import type { QualityBreakdown, Repo, TaskDetail } from "../types";
import { Meta, StatusPill } from "./bits";
import { QualityScore, RatingStars } from "./Quality";

export interface TaskHeaderProps {
  detail: TaskDetail;
  /** Provisional breakdown while the run is still going (detail.quality is set at the end). */
  liveQuality?: QualityBreakdown | null;
  workspaceName?: string;
  repos?: Repo[];
  runId: string | null;
  onOpenReplay: () => void;
  onStart: (opts: { now?: boolean; start_on_reset?: boolean }) => void;
  onCancel: () => void;
  onExport: (format: ExportFormat) => void;
  onRate: (n: number) => void;
  starting?: boolean;
  cancelling?: boolean;
  exporting?: boolean;
}

function Elapsed({ from, to }: { from: string; to: string | null }) {
  const now = useNow(1000, !to);
  const end = to ? Date.parse(to) : now;
  return <span className="tabular">{formatDuration(Math.max(0, end - Date.parse(from)))}</span>;
}

function Prompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 220 || text.split("\n").length > 3;
  return (
    <div className="flex max-w-[78ch] flex-col items-start gap-1">
      <motion.div layout transition={spring.layout} className="relative overflow-hidden">
        <p data-selectable className={cn("text-sm leading-6 whitespace-pre-wrap text-fg-muted", !open && long && "line-clamp-2")}>
          {text}
        </p>
      </motion.div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-fg-muted outline-none hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          {open ? s.hidePrompt : s.showPrompt}
          <motion.span animate={{ rotate: open ? 180 : 0 }} transition={spring.snappy} className="flex">
            <ChevronDown className="size-3.5" />
          </motion.span>
        </button>
      )}
    </div>
  );
}

const exportIcon = { md: FileText, html: FileCode2, json: FileJson } as const;

export function TaskHeader({ detail, liveQuality, workspaceName, repos, runId, onOpenReplay, onStart, onCancel, onExport, onRate, starting, cancelling, exporting }: TaskHeaderProps) {
  const { task } = detail;
  const [confirm, setConfirm] = useState(false);
  const run = detail.current_run;
  const live = task.status === "running" || task.status === "waiting";
  const finished = task.status === "completed" || task.status === "failed" || task.status === "cancelled";
  const repoNames = task.repo_ids?.length
    ? task.repo_ids.map((id) => repos?.find((r) => r.id === id)?.name ?? id).join(", ")
    : repos?.length
      ? repos.map((r) => r.name).join(", ")
      : s.allRepos;

  const copyId = () => {
    void navigator.clipboard?.writeText(task.id).then(
      () => toast.success(s.copied),
      () => undefined,
    );
  };

  return (
    <header className="flex flex-col gap-4">
      <nav aria-label="Konum" className="flex items-center gap-1 text-xs text-fg-faint">
        <Link
          to="/tasks"
          className="-ml-1 inline-flex items-center gap-0.5 rounded-md py-0.5 pr-1.5 pl-0.5 text-fg-muted outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          <ChevronLeft className="size-3.5" aria-hidden />
          {s.breadcrumbTasks}
        </Link>
        <span aria-hidden>/</span>
        <span className="font-mono text-2xs">{task.id}</span>
      </nav>

      <div className="flex items-start gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="min-w-0 text-2xl leading-tight text-fg" data-selectable>
              {task.title}
            </h1>
            <StatusPill status={task.status} className="mt-1" />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Badge size="md" tone="neutral" icon={<Workflow />}>
              {s.mode[task.mode]}
            </Badge>
            {workspaceName && <Meta icon={<FolderGit2 />}>{workspaceName}</Meta>}
            <Meta icon={<GitBranch />} title={repoNames}>
              {repoNames}
              {task.base_ref ? <span className="text-fg-faint"> · {task.base_ref}</span> : null}
            </Meta>
            <Meta icon={<CalendarClock />} title={formatDateTime(task.created_at)}>
              {s.created} {relativeTime(task.created_at)}
            </Meta>
            {run && (
              <Meta icon={<Timer />} title={`${s.started} ${formatDateTime(run.started_at)}`}>
                {s.duration} <Elapsed from={run.started_at} to={run.finished_at} />
              </Meta>
            )}
          </div>
          <AnimatePresence initial={false}>
            {task.status === "queued" && detail.hold_reason && (
              <motion.p {...{ initial: { opacity: 0, y: -4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, transition: transition.exit } }} className="text-xs text-warning">
                {s.hold(detail.hold_reason)}
              </motion.p>
            )}
          </AnimatePresence>
          {task.prompt && <Prompt text={task.prompt} />}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-3">
          <div className="flex items-center gap-1.5">
            {live ? (
              <Button variant="secondary" icon={<X />} loading={cancelling} onClick={() => setConfirm(true)}>
                {s.cancel}
              </Button>
            ) : task.status === "queued" ? (
              <Button variant="primary" icon={<Zap />} loading={starting} onClick={() => onStart({ now: true })}>
                {s.startNow}
              </Button>
            ) : (
              <Button variant={finished ? "secondary" : "primary"} icon={finished ? <RotateCcw /> : <Play />} loading={starting} onClick={() => onStart({})}>
                {finished ? s.rerun : s.start}
              </Button>
            )}
            <Menu
              align="end"
              trigger={<IconButton label={s.export} icon={<Download />} variant="secondary" size="lg" loading={exporting} />}
            >
              <MenuLabel>{s.export}</MenuLabel>
              {(["md", "html", "json"] as const).map((f) => {
                const Icon = exportIcon[f];
                return (
                  <MenuItem key={f} icon={<Icon />} onSelect={() => onExport(f)}>
                    {s.exportAs[f]}
                  </MenuItem>
                );
              })}
            </Menu>
            <Menu align="end" trigger={<IconButton label={s.more} icon={<MoreHorizontal />} variant="secondary" size="lg" />}>
              {runId && (
                <MenuItem icon={<History />} onSelect={onOpenReplay}>
                  {s.openReplay}
                </MenuItem>
              )}
              {!live && (
                <>
                  <MenuItem icon={<Zap />} onSelect={() => onStart({ now: true })}>
                    {s.startNow}
                  </MenuItem>
                  <MenuItem icon={<CalendarClock />} onSelect={() => onStart({ start_on_reset: true })}>
                    {s.startOnReset}
                  </MenuItem>
                </>
              )}
              {task.status === "queued" && (
                <MenuItem icon={<X />} tone="danger" onSelect={() => setConfirm(true)}>
                  {s.cancelTask}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem icon={<Copy />} onSelect={copyId}>
                {s.copyId}
              </MenuItem>
            </Menu>
          </div>
          <div className="flex items-center gap-3">
            <QualityScore quality={detail.quality ?? liveQuality ?? null} provisional={!detail.quality && Boolean(liveQuality)} />
            {finished && (
              <Tooltip content={detail.rating ? `${s.yourRating}: ${detail.rating}/5` : s.rate}>
                <span className="flex">
                  <RatingStars value={detail.rating} onRate={onRate} />
                </span>
              </Tooltip>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={s.cancelConfirmTitle}
        description={s.cancelConfirmBody}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {s.keepRunning}
            </Button>
            <Button
              variant="danger"
              icon={<X />}
              onClick={() => {
                setConfirm(false);
                onCancel();
              }}
            >
              {s.cancelTask}
            </Button>
          </>
        }
      />
    </header>
  );
}
