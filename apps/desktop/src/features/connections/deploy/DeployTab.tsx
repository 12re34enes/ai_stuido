import { MoreHorizontal, Pencil, Plus, Rocket, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { Badge, Button, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, toast, Tooltip } from "@/ui";

import { useDeleteDeployProfile, useDeployProfiles, useDeployRuns, useHosts } from "../api";
import { ConfirmDialog, EnvGroups, errorMessage, ErrorState, ListSkeleton, RunStatusBadge, TargetRow } from "../kit";
import { deployKindIcon, latestRuns } from "../format";
import { deploySummary, groupByEnvironment } from "../logic";
import { useConnectionsUi } from "../store";
import { connStrings as s } from "../strings";
import type { DeployProfile } from "../types";
import { DeployFormSheet } from "./DeployForm";
import { RunDialog } from "./RunDialog";

export function DeployTab() {
  const profiles = useDeployProfiles();
  const runs = useDeployRuns();
  const hosts = useHosts();
  const dialog = useConnectionsUi((st) => st.dialog);
  const seq = useConnectionsUi((st) => st.seq);
  const openDialog = useConnectionsUi((st) => st.open);
  const closeDialog = useConnectionsUi((st) => st.close);
  const navigate = useNavigate();
  const del = useDeleteDeployProfile();
  const now = useNow(30_000);
  const [edit, setEdit] = useState<{ open: boolean; key: number; profile?: DeployProfile }>({ open: false, key: 0 });
  const [deleting, setDeleting] = useState<DeployProfile | null>(null);
  const [running, setRunning] = useState<DeployProfile | null>(null);
  const latest = latestRuns(runs.data);
  const list = profiles.data ?? [];
  const hostList = hosts.data ?? [];

  let body;
  if (profiles.isPending) body = <ListSkeleton rows={3} />;
  else if (profiles.isError) body = <ErrorState error={profiles.error} onRetry={() => void profiles.refetch()} />;
  else if (list.length === 0)
    body = (
      <EmptyState
        icon={<Rocket />}
        title={s.deploy.emptyTitle}
        description={s.deploy.emptyHint}
        action={
          <Button variant="primary" icon={<Plus />} onClick={() => openDialog("deploy.new")}>
            {s.deploy.add}
          </Button>
        }
      />
    );
  else
    body = (
      <EnvGroups
        label={s.tabs.deploy}
        groups={groupByEnvironment(list)}
        render={(p) => {
          const Icon = deployKindIcon[p.kind];
          const last = latest.get(p.id);
          return (
            <TargetRow
              key={p.id}
              to={`/connections/deploy/${encodeURIComponent(p.id)}`}
              environment={p.environment}
              icon={<Icon />}
              title={p.name}
              subtitle={deploySummary(p)}
              badges={
                <Badge tone="neutral" size="sm">
                  {s.deploy.kind[p.kind]}
                </Badge>
              }
              meta={
                last ? (
                  <Tooltip content={`${s.deploy.lastRun} · ${relativeTime(last.started_at, new Date(now))}`} side="top">
                    <span className="inline-flex items-center gap-2">
                      <span className="text-2xs text-fg-faint">{relativeTime(last.started_at, new Date(now))}</span>
                      <RunStatusBadge status={last.status} />
                    </span>
                  </Tooltip>
                ) : (
                  <span className="text-2xs text-fg-faint">{s.deploy.never}</span>
                )
              }
              actions={
                <>
                  <Button size="sm" variant="ghost" icon={<Rocket />} onClick={() => setRunning(p)}>
                    {s.deploy.run}
                  </Button>
                  <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} tooltip={false} />}>
                    <MenuItem icon={<Pencil />} onSelect={() => setEdit((e) => ({ open: true, key: e.key + 1, profile: p }))}>
                      {s.common.edit}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => setDeleting(p)}>
                      {s.common.delete}
                    </MenuItem>
                  </Menu>
                </>
              }
            />
          );
        }}
      />
    );

  return (
    <>
      {body}
      <DeployFormSheet key={`new-${seq}`} open={dialog === "deploy.new"} onOpenChange={(o) => !o && closeDialog()} hosts={hostList} />
      <DeployFormSheet key={`edit-${edit.key}`} open={edit.open} onOpenChange={(o) => setEdit((e) => ({ ...e, open: o }))} profile={edit.profile} hosts={hostList} />
      <RunDialog
        profile={running}
        open={running !== null}
        onOpenChange={(o) => !o && setRunning(null)}
        onStarted={(run) => void navigate(`/connections/deploy/${encodeURIComponent(run.profile_id)}?run=${encodeURIComponent(run.id)}`)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? s.deploy.deleteTitle(deleting.name) : ""}
        description={s.deploy.deleteBody}
        confirmLabel={s.common.delete}
        loading={del.isPending}
        requireText={deleting?.environment === "production" ? deleting.name : undefined}
        onConfirm={() => {
          const p = deleting;
          if (!p) return;
          del.mutate(p.id, {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: p.name });
              setDeleting(null);
            },
            onError: (err) => toast.error(s.common.deleteFailed, { description: errorMessage(err) }),
          });
        }}
      />
    </>
  );
}
