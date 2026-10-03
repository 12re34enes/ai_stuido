/** /flows/schedules — CRUD over /engine/schedules with a friendly cron builder, enable switch and "Şimdi çalıştır". */
import { CalendarClock, ChevronLeft, CircleAlert, Pencil, Play, Plus, Trash2, Workflow } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, transition, variants } from "@/motion/tokens";
import { Badge, Button, Dialog, EmptyState, IconButton, Input, SegmentedControl, Select, Skeleton, Switch, Textarea, toast, type SelectOption } from "@/ui";

import { useCreateSchedule, useDeleteSchedule, useFlows, useModes, useRunSchedule, useSchedules, useUpdateSchedule } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { builderToCron, COMMON_TIMEZONES, cronToBuilder, describeCron, localTimeZone, nextRuns, parseCron, type CronBuilder } from "../model/cron";
import { modeLabels, s } from "../strings";
import { errorText } from "../util";
import type { FlowMode, Schedule, ScheduleTemplate } from "../types";
import { FormField } from "../editor/inspector/controls";
import { CronBuilderField, CronPreview } from "./CronBuilder";
import { formatRunDay, formatRunTime, relativeRun } from "./format";

const RUNNABLE_MODES: FlowMode[] = ["single", "duo", "race", "pipeline", "council"];

interface Draft {
  name: string;
  title: string;
  prompt: string;
  source: "flow" | "mode";
  flowId: string | null;
  mode: FlowMode;
  builder: CronBuilder;
  timezone: string;
  enabled: boolean;
}

function draftFrom(schedule: Schedule | null): Draft {
  if (!schedule) {
    return { name: "", title: "", prompt: "", source: "mode", flowId: null, mode: "duo", builder: { kind: "weekdays", hour: 8, minute: 45 }, timezone: localTimeZone(), enabled: true };
  }
  const t = schedule.template;
  return {
    name: schedule.name,
    title: t.title,
    prompt: t.prompt,
    source: t.flow_id ? "flow" : "mode",
    flowId: t.flow_id,
    mode: t.mode,
    builder: cronToBuilder(schedule.cron),
    timezone: schedule.timezone,
    enabled: schedule.enabled,
  };
}

function ScheduleDialog({ open, onOpenChange, schedule, workspaceId }: { open: boolean; onOpenChange: (o: boolean) => void; schedule: Schedule | null; workspaceId: string }) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(schedule));
  const flows = useFlows(workspaceId);
  const modes = useModes();
  const create = useCreateSchedule();
  const update = useUpdateSchedule();
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), title: useId(), prompt: useId(), flow: useId(), mode: useId(), tz: useId() };
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const cron = builderToCron(draft.builder);
  const cronOk = parseCron(cron).ok;
  const valid = draft.name.trim() && draft.title.trim() && draft.prompt.trim() && cronOk && (draft.source === "mode" || draft.flowId);
  const busy = create.isPending || update.isPending;

  const tzOptions: SelectOption[] = [...new Set([draft.timezone, localTimeZone(), ...COMMON_TIMEZONES])].map((tz) => ({ value: tz, label: tz.replace(/_/g, " ") }));
  const flowOptions: SelectOption[] = (flows.data ?? []).map((f) => ({ value: f.id, label: f.name, description: `${s.version(f.version)} · ${s.nodeCount(f.graph.nodes.length)}` }));
  const modeOptions: SelectOption<FlowMode>[] = RUNNABLE_MODES.map((m) => ({ value: m, label: modes.data?.find((x) => x.mode === m)?.label ?? modeLabels[m], description: modes.data?.find((x) => x.mode === m)?.description }));

  const submit = async () => {
    if (!valid) return;
    setError(null);
    const template: ScheduleTemplate = {
      ...(schedule?.template ?? { studio_id: null, repo_ids: null, base_ref: null, inputs: {}, budget: null, priority: 0 }),
      title: draft.title.trim(),
      prompt: draft.prompt,
      mode: draft.source === "flow" ? "custom" : draft.mode,
      flow_id: draft.source === "flow" ? draft.flowId : null,
    };
    try {
      if (schedule) await update.mutateAsync({ id: schedule.id, body: { name: draft.name.trim(), cron, timezone: draft.timezone, template, enabled: draft.enabled } });
      else await create.mutateAsync({ workspace_id: workspaceId, name: draft.name.trim(), cron, timezone: draft.timezone, template, enabled: draft.enabled });
      toast.success(s.schedules.saved, { description: describeCron(cron) ?? cron });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : s.schedules.saveFailed);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      className="max-w-[820px]"
      title={schedule ? s.schedules.edit : s.schedules.new}
      footer={
        <>
          <Switch className="mr-auto" label={draft.enabled ? s.schedules.enabled : s.schedules.disabled} checked={draft.enabled} onCheckedChange={(enabled) => set({ enabled })} />
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.cancel}
          </Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void submit()} data-testid="schedule-submit">
            {schedule ? s.schedules.save : s.schedules.create}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-6 p-px"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        data-testid="schedule-form"
      >
        <div className="grid grid-cols-2 gap-x-6 gap-y-4">
          <FormField label={s.schedules.name} htmlFor={ids.name}>
            <Input id={ids.name} autoFocus value={draft.name} placeholder={s.schedules.namePlaceholder} onChange={(e) => set({ name: e.target.value })} />
          </FormField>
          <FormField label={s.schedules.taskTitle} htmlFor={ids.title}>
            <Input id={ids.title} value={draft.title} placeholder={s.schedules.taskTitlePlaceholder} onChange={(e) => set({ title: e.target.value })} />
          </FormField>
          <FormField label={s.schedules.prompt} htmlFor={ids.prompt} className="col-span-2">
            <Textarea id={ids.prompt} minRows={2} maxRows={6} value={draft.prompt} placeholder={s.schedules.promptPlaceholder} onChange={(e) => set({ prompt: e.target.value })} />
          </FormField>
          <FormField label={s.schedules.runWith} className="col-span-2">
            <div className="flex items-center gap-3">
              <SegmentedControl
                size="sm"
                aria-label={s.schedules.runWith}
                value={draft.source}
                onValueChange={(source) => set({ source })}
                options={[
                  { value: "mode" as const, label: s.schedules.mode },
                  { value: "flow" as const, label: s.schedules.flow },
                ]}
              />
              <div className="min-w-0 flex-1">
                <AnimatePresence mode="popLayout" initial={false}>
                  {draft.source === "flow" ? (
                    <motion.div key="flow" {...variants.fade}>
                      <Select id={ids.flow} aria-label={s.schedules.flow} placeholder={s.schedules.flow} value={draft.flowId ?? undefined} options={flowOptions} onValueChange={(flowId) => set({ flowId })} className="w-full" />
                    </motion.div>
                  ) : (
                    <motion.div key="mode" {...variants.fade}>
                      <Select<FlowMode> id={ids.mode} aria-label={s.schedules.mode} value={draft.mode} options={modeOptions} onValueChange={(mode) => set({ mode })} className="w-full" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </FormField>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,300px)] gap-6 border-t border-line-subtle pt-5">
          <div className="flex flex-col gap-4">
            <h3 className="font-sans text-2xs font-medium tracking-wide text-fg-faint uppercase">{s.schedules.when}</h3>
            <CronBuilderField value={draft.builder} onChange={(builder) => set({ builder })} />
            <FormField label={s.schedules.timezone} htmlFor={ids.tz}>
              <Select id={ids.tz} size="sm" aria-label={s.schedules.timezone} value={draft.timezone} options={tzOptions} onValueChange={(timezone) => set({ timezone })} className="w-60" />
            </FormField>
          </div>
          <CronPreview cron={cron} timezone={draft.timezone} />
        </div>

        <AnimatePresence initial={false}>
          {error && (
            <motion.p key="err" role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: transition.exit }} className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
              {error}
            </motion.p>
          )}
        </AnimatePresence>
      </form>
    </Dialog>
  );
}

function ScheduleRow({
  schedule,
  index,
  flowName,
  now,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  index: number;
  flowName: string | null;
  now: number;
  onEdit: (s: Schedule) => void;
  onDelete: (s: Schedule) => void;
}) {
  const navigate = useNavigate();
  const update = useUpdateSchedule();
  const run = useRunSchedule();
  const description = describeCron(schedule.cron) ?? schedule.cron;
  const next = useMemo(() => {
    if (!schedule.enabled) return null;
    if (schedule.next_run_at) return new Date(schedule.next_run_at);
    return nextRuns(schedule.cron, schedule.timezone, new Date(now), 1)[0] ?? null;
  }, [now, schedule.cron, schedule.enabled, schedule.next_run_at, schedule.timezone]);
  const t = schedule.template;
  const target = t.flow_id ? (flowName ?? s.schedules.flowMissing) : s.schedules.modeLabel(modeLabels[t.mode]);

  const runNow = async () => {
    try {
      const task = await run.mutateAsync(schedule.id);
      toast.success(s.schedules.ran, { description: task.title, action: { label: s.start.open, onClick: () => void navigate(`/tasks/${encodeURIComponent(task.id)}`) } });
    } catch (e) {
      toast.error(s.schedules.runFailed, { description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { ...spring.smooth, delay: Math.min(index, 8) * 0.04 } }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
      transition={spring.layout}
      className="group/row flex items-center gap-5 rounded-xl border border-line bg-surface px-5 py-4 shadow-1 transition-shadow duration-200 hover:shadow-2"
      data-testid={`schedule-${schedule.id}`}
    >
      <Switch
        aria-label={`${schedule.name}: ${schedule.enabled ? s.schedules.disable : s.schedules.enable}`}
        checked={schedule.enabled}
        onCheckedChange={(enabled) =>
          update.mutate(
            { id: schedule.id, body: { enabled } },
            { onSuccess: () => toast.info(s.schedules.toggled(enabled), { id: `sched-${schedule.id}`, duration: 1800 }) },
          )
        }
      />
      <div className={`flex min-w-0 flex-1 flex-col gap-1 transition-opacity duration-200 ${schedule.enabled ? "" : "opacity-60"}`}>
        <div className="flex items-center gap-2">
          <h3 className="truncate text-md leading-6 text-fg">{schedule.name}</h3>
          {!schedule.enabled && <Badge>{s.schedules.disabled}</Badge>}
        </div>
        <p className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
          <CalendarClock className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate text-fg" data-testid="schedule-description">
            {description}
          </span>
          <span className="text-fg-faint" aria-hidden>
            ·
          </span>
          <span className="shrink-0 text-xs">{schedule.timezone}</span>
        </p>
        <p className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
          <Workflow className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {target} · {t.title}
          </span>
        </p>
      </div>
      <div className="flex w-44 shrink-0 flex-col items-end gap-0.5 text-right">
        <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{s.schedules.nextRun}</span>
        {next ? (
          <>
            <span className="text-sm text-fg tabular">
              {formatRunDay(next, schedule.timezone)} {formatRunTime(next, schedule.timezone)}
            </span>
            <span className="text-xs text-fg-muted">{relativeRun(next, new Date(now))}</span>
          </>
        ) : (
          <span className="text-sm text-fg-muted">{s.schedules.noNext}</span>
        )}
        <span className="mt-1 text-2xs text-fg-faint">
          {s.schedules.lastRun}: {schedule.last_run_at ? relativeTime(schedule.last_run_at, new Date(now)) : s.schedules.never}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" icon={<Play />} loading={run.isPending} onClick={() => void runNow()} data-testid="run-now">
          {s.schedules.runNow}
        </Button>
        <IconButton label={s.schedules.edit} icon={<Pencil />} onClick={() => onEdit(schedule)} />
        <IconButton label={s.delete} variant="danger" icon={<Trash2 />} onClick={() => onDelete(schedule)} />
      </div>
    </motion.li>
  );
}

export function SchedulesPage() {
  const navigate = useNavigate();
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const schedules = useSchedules(workspaceId);
  const flows = useFlows(workspaceId);
  const remove = useDeleteSchedule();
  const now = useNow(30_000);
  const [dialog, setDialog] = useState<{ open: boolean; schedule: Schedule | null; key: number }>({ open: false, schedule: null, key: 0 });
  // Each open gets a fresh dialog instance (drafts never leak between schedules).
  const openEditor = (schedule: Schedule | null) => setDialog((d) => ({ open: true, schedule, key: d.key + 1 }));
  const [toDelete, setToDelete] = useState<Schedule | null>(null);
  const flowNames = useMemo(() => new Map((flows.data ?? []).map((f) => [f.id, f.name])), [flows.data]);
  const list = useMemo(() => {
    const next = (x: Schedule) => (x.enabled ? (x.next_run_at ? Date.parse(x.next_run_at) : (nextRuns(x.cron, x.timezone, new Date(), 1)[0]?.getTime() ?? Infinity)) : Infinity);
    return [...(schedules.data ?? [])].sort((a, b) => Number(b.enabled) - Number(a.enabled) || next(a) - next(b) || a.name.localeCompare(b.name, "tr"));
  }, [schedules.data]);

  const commands = useMemo<StudioCommand[]>(
    () => [{ id: "flows.schedules.new", title: s.schedules.new, group: commandGroups.actions, icon: CalendarClock, order: 4, keywords: ["schedule", "cron", "zamanla"], run: () => setDialog((d) => ({ open: true, schedule: null, key: d.key + 1 })) }],
    [],
  );
  useRegisterCommands(commands);

  const confirmDelete = async () => {
    const sch = toDelete;
    setToDelete(null);
    if (!sch) return;
    try {
      await remove.mutateAsync(sch.id);
      toast.success(s.schedules.deleted, { description: sch.name });
    } catch (e) {
      toast.error(s.schedules.saveFailed, { description: e instanceof Error ? e.message : undefined });
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-8 px-8 pt-6 pb-16" data-testid="schedules-page">
      <div className="flex flex-col gap-3">
        <Button size="sm" variant="ghost" icon={<ChevronLeft />} className="-ml-2 w-fit" onClick={() => void navigate("/flows")}>
          {s.schedules.back}
        </Button>
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex max-w-xl flex-col gap-1.5">
            <h1 className="text-2xl text-fg">{s.schedules.title}</h1>
            <p className="text-sm text-fg-muted">{s.schedules.subtitle}</p>
          </div>
          <Button variant="primary" icon={<Plus />} disabled={!workspaceId} onClick={() => openEditor(null)} data-testid="new-schedule">
            {s.schedules.new}
          </Button>
        </header>
      </div>

      {!workspaceId ? (
        <EmptyState icon={<CalendarClock />} title={s.noWorkspace} />
      ) : schedules.isPending ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={92} className="rounded-xl" />
          ))}
        </div>
      ) : schedules.isError ? (
        <EmptyState
          icon={<CircleAlert />}
          title={s.schedules.loadError}
          description={errorText(schedules.error)}
          action={
            <Button size="sm" onClick={() => void schedules.refetch()}>
              {s.retry}
            </Button>
          }
        />
      ) : list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong">
          <EmptyState
            icon={<CalendarClock />}
            title={s.schedules.emptyTitle}
            description={s.schedules.emptyBody}
            action={
              <Button size="sm" variant="primary" icon={<Plus />} onClick={() => openEditor(null)}>
                {s.schedules.new}
              </Button>
            }
          />
        </div>
      ) : (
        <motion.ul className="flex flex-col gap-3" data-testid="schedule-list">
          <AnimatePresence mode="popLayout">
            {list.map((sch, i) => (
              <ScheduleRow key={sch.id} index={i} schedule={sch} now={now} flowName={sch.template.flow_id ? (flowNames.get(sch.template.flow_id) ?? null) : null} onEdit={openEditor} onDelete={setToDelete} />
            ))}
          </AnimatePresence>
        </motion.ul>
      )}

      {workspaceId && dialog.key > 0 && (
        <ScheduleDialog key={dialog.key} open={dialog.open} onOpenChange={(o) => setDialog((d) => ({ ...d, open: o }))} schedule={dialog.schedule} workspaceId={workspaceId} />
      )}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={toDelete ? s.schedules.deleteTitle(toDelete.name) : ""}
        description={s.schedules.deleteBody}
        confirmLabel={s.delete}
        destructive
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
