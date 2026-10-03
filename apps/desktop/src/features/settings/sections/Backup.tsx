import { Archive, ArchiveRestore, CheckCircle2, FolderOpen, HardDriveDownload, Power } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { useNow } from "@/hooks/useNow";
import { formatDateTime, relativeTime } from "@/i18n/format";
import { stagger, variants } from "@/motion/tokens";
import { isTauri, restartBackend, revealInFinder } from "@/native";
import { Badge, Button, Callout, Checkbox, ConfirmDialog, EmptyState, errorMessage, ErrorState, IconButton, Input, Section, Select, SettingRow, Skeleton, toast } from "@/ui";


import { useBackups, useBackupSettings, useCreateBackup, useRestoreBackup, useSaveBackupSettings } from "../api";
import { CommitNumber, SectionPage } from "../kit";
import { BACKUP_INTERVALS, describeInterval, formatBytes } from "../logic";
import { setStrings as s } from "../strings";
import type { BackupInfo, RestoreResult } from "../types";

const b = s.backup;

function DirField({ value, resolved, onCommit }: { value: string | null; resolved: string; onCommit: (dir: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value ?? "";
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft.trim() !== (value ?? "")) onCommit(draft.trim());
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={b.dir}
        value={text}
        placeholder={resolved}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        wrapperClassName="w-72"
        className="font-mono text-xs"
      />
      {isTauri() && <IconButton label={b.reveal} icon={<FolderOpen />} variant="secondary" onClick={() => void revealInFinder(resolved)} />}
      {value && (
        <Button size="sm" variant="ghost" onClick={() => onCommit("")}>
          {b.dirReset}
        </Button>
      )}
    </div>
  );
}

export function BackupSection() {
  const backups = useBackups();
  const settings = useBackupSettings();
  const saveSettings = useSaveBackupSettings();
  const create = useCreateBackup();
  const restore = useRestoreBackup();
  const now = useNow(60_000);
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const [safety, setSafety] = useState(true);
  const [result, setResult] = useState<RestoreResult | null>(null);
  const cfg = settings.data;
  const save = (patch: Parameters<typeof saveSettings.mutate>[0]) =>
    saveSettings.mutate(patch, { onSuccess: () => toast.success(s.common.saved), onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }) });

  return (
    <SectionPage
      title={s.sections.backup.title}
      description={s.sections.backup.description}
      actions={
        <Button
          variant="primary"
          icon={<HardDriveDownload />}
          loading={create.isPending}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: (x) => toast.success(b.created, { description: `${x.name} · ${formatBytes(x.total_size)}` }),
              onError: (e) => toast.error(b.failed, { description: errorMessage(e) }),
            })
          }
        >
          {b.now}
        </Button>
      }
    >
      {result && (
        <Callout
          tone="success"
          icon={<CheckCircle2 />}
          title={b.restored}
          actions={
            isTauri() && (
              <Button size="sm" variant="primary" icon={<Power />} onClick={() => void restartBackend().then(() => toast.info(b.restarting))}>
                {b.restart}
              </Button>
            )
          }
        >
          {b.restartNeeded}
          {result.safety_backup && <span className="block font-mono text-xs">{result.safety_backup}</span>}
        </Callout>
      )}

      <Section title={b.schedule}>
        {settings.isPending ? (
          <div className="flex flex-col gap-3 p-4">
            <Skeleton height={28} />
            <Skeleton height={28} />
          </div>
        ) : settings.isError || !cfg ? (
          <ErrorState size="sm" error={settings.error} onRetry={() => void settings.refetch()} />
        ) : (
          <>
            <SettingRow
              label={b.interval}
              description={`${b.last}: ${cfg.last_backup_at ? relativeTime(cfg.last_backup_at, new Date(now)) : b.never}${cfg.next_backup_at ? ` · ${b.next}: ${formatDateTime(cfg.next_backup_at)}` : ""}`}
              control={
                <Select
                  aria-label={b.interval}
                  className="w-36"
                  value={String(cfg.interval_hours)}
                  onValueChange={(v) => save({ interval_hours: Number(v) })}
                  options={[...new Set([...BACKUP_INTERVALS, cfg.interval_hours])].map((h) => ({ value: String(h), label: describeInterval(h) }))}
                />
              }
            />
            <SettingRow label={b.keep} description={b.keepHint} control={<CommitNumber aria-label={b.keep} value={cfg.keep} min={1} max={1000} onCommit={(v) => save({ keep: v ?? 14 })} />} />
            <SettingRow label={b.dir} description={b.dirHint} control={<DirField value={cfg.dir} resolved={cfg.resolved_dir} onCommit={(dir) => save({ dir })} />} />
          </>
        )}
      </Section>

      <Section title={b.list}>
        {backups.isPending ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : backups.isError ? (
          <ErrorState size="sm" error={backups.error} onRetry={() => void backups.refetch()} />
        ) : (backups.data ?? []).length === 0 ? (
          <EmptyState size="sm" icon={<Archive />} title={b.empty} description={b.emptyHint} />
        ) : (
          <motion.ul initial="initial" animate="animate" variants={stagger(0.03)} className="divide-y divide-line-subtle" aria-label={b.list}>
            {(backups.data ?? []).map((x) => (
              <motion.li key={x.name} layout="position" variants={variants.listItem} className="flex items-center gap-3.5 px-4 py-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-surface-sunken text-fg-muted">
                  <Archive className="size-4" aria-hidden />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm text-fg">{formatDateTime(x.created_at)}</span>
                    <Badge tone={x.reason === "manual" ? "accent" : "neutral"} size="sm">
                      {b.reason[x.reason]}
                    </Badge>
                  </span>
                  <span className="truncate font-mono text-2xs text-fg-muted">
                    {x.name} · {formatBytes(x.total_size)} · {b.workspaces(x.workspaces.length)} · v{x.app_version}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ArchiveRestore />}
                  onClick={() => {
                    setSafety(true);
                    setRestoring(x);
                  }}
                >
                  {b.restore}
                </Button>
              </motion.li>
            ))}
          </motion.ul>
        )}
      </Section>

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(o) => !o && setRestoring(null)}
        size="md"
        title={restoring ? b.restoreTitle(formatDateTime(restoring.created_at)) : ""}
        description={b.restoreBody}
        confirmLabel={b.restore}
        loading={restore.isPending}
        requireText={restoring ? "geri yükle" : undefined}
        onConfirm={() => {
          const x = restoring;
          if (!x) return;
          restore.mutate(
            { name: x.name, safety },
            {
              onSuccess: (r) => {
                setRestoring(null);
                setResult(r);
                toast.success(b.restored, { description: b.restartNeeded });
              },
              onError: (e) => toast.error(s.common.saveFailed, { description: errorMessage(e) }),
            },
          );
        }}
      >
        <Checkbox checked={safety} onCheckedChange={setSafety} label={b.safety} description={b.safetyHint} />
      </ConfirmDialog>
    </SectionPage>
  );
}
