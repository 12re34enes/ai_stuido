import { FileInput } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import type { Environment } from "@/lib/types";
import { useCurrentWorkspace } from "@/lib/workspace";
import { stagger, variants } from "@/motion/tokens";
import { Badge, Button, Checkbox, cn, Dialog, EmptyState, Skeleton, toast } from "@/ui";

import { useImportSshConfig, useSshConfig } from "../api";
import { Callout, EnvironmentPicker, errorMessage, ErrorState, FormGroupLabel, PermissionPicker } from "../kit";
import { connStrings as s } from "../strings";
import type { PermissionLevel, SshConfigEntry } from "../types";

const t = s.hosts.importDialog;

/** Preview ~/.ssh/config Host entries and import the selected ones as explicit host records. */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title={t.title} description={t.description}>
      {open && <ImportBody onDone={() => onOpenChange(false)} />}
    </Dialog>
  );
}

function ImportBody({ onDone }: { onDone: () => void }) {
  const config = useSshConfig(true);
  const importMut = useImportSshConfig();
  const { workspace } = useCurrentWorkspace();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [environment, setEnvironment] = useState<Environment>("test");
  const [permission, setPermission] = useState<PermissionLevel>("read");

  const entries = config.data ?? [];
  const importable = entries.filter((e) => !e.exists);
  // Default: everything importable is selected (until the user changes the selection).
  const chosen = selected ?? new Set(importable.map((e) => e.alias));
  const toggle = (alias: string, on: boolean) => {
    const next = new Set(chosen);
    if (on) next.add(alias);
    else next.delete(alias);
    setSelected(next);
  };
  const allOn = importable.length > 0 && importable.every((e) => chosen.has(e.alias));

  const submit = () =>
    importMut.mutate(
      { aliases: [...chosen], environment, permission_level: permission, workspace_id: workspace?.id ?? null },
      {
        onSuccess: (r) => {
          toast.success(t.result(r.created.length, r.skipped.length), {
            description: r.skipped.length ? r.skipped.map((x) => `${x.alias}: ${x.reason}`).join(" · ") : undefined,
          });
          onDone();
        },
      },
    );

  if (config.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy aria-label={t.loading}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={40} />
        ))}
      </div>
    );
  }
  if (config.isError) return <ErrorState error={config.error} onRetry={() => void config.refetch()} size="sm" />;
  if (entries.length === 0) return <EmptyState size="sm" icon={<FileInput />} title={t.empty} />;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-0.5">
          <Checkbox
            checked={allOn ? true : chosen.size > 0 ? "indeterminate" : false}
            onCheckedChange={(on) => setSelected(new Set(on ? importable.map((e) => e.alias) : []))}
            label={<span className="text-xs text-fg-muted">{t.selectAll}</span>}
            disabled={importable.length === 0}
          />
          <span className="text-xs text-fg-muted tabular">{t.selected(chosen.size)}</span>
        </div>
        <motion.ul
          initial="initial"
          animate="animate"
          variants={stagger(0.03)}
          className="max-h-64 divide-y divide-line-subtle overflow-y-auto rounded-lg border border-line bg-surface"
        >
          {entries.map((e) => (
            <EntryRow key={e.alias} entry={e} checked={chosen.has(e.alias)} onChange={(on) => toggle(e.alias, on)} />
          ))}
        </motion.ul>
      </div>
      <div className="flex flex-col gap-3">
        <FormGroupLabel>{t.defaults}</FormGroupLabel>
        <EnvironmentPicker value={environment} onChange={setEnvironment} />
        <PermissionPicker value={permission} onChange={setPermission} environment={environment} />
      </div>
      {importMut.isError && (
        <Callout tone="danger" title={s.common.saveFailed}>
          {errorMessage(importMut.error)}
        </Callout>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {s.common.cancel}
        </Button>
        <Button variant="primary" disabled={chosen.size === 0} loading={importMut.isPending} onClick={submit}>
          {t.submit(chosen.size)}
        </Button>
      </div>
    </div>
  );
}

function EntryRow({ entry, checked, onChange }: { entry: SshConfigEntry; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <motion.li variants={variants.listItem} className={cn("flex items-center gap-3 px-3 py-2.5", entry.exists && "opacity-60")}>
      <Checkbox checked={checked && !entry.exists} disabled={entry.exists} onCheckedChange={onChange} aria-label={entry.alias} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-fg">{entry.alias}</span>
        <span className="truncate font-mono text-2xs text-fg-muted">
          {entry.user ? `${entry.user}@` : ""}
          {entry.hostname}:{entry.port}
          {entry.identity_file ? ` · ${entry.identity_file}` : ""}
        </span>
      </div>
      {entry.proxy_jump && (
        <Badge tone="neutral" size="sm">
          {s.hosts.via(entry.proxy_jump)}
        </Badge>
      )}
      {entry.exists && (
        <Badge tone="neutral" variant="outline" size="sm">
          {t.exists}
        </Badge>
      )}
    </motion.li>
  );
}
