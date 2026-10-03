import { Activity, ArrowRightLeft, FileInput, MoreHorizontal, Pencil, Plus, Server, SquareTerminal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { Badge, Button, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, StatusDot, toast, Tooltip } from "@/ui";

import { useDeleteHost, useHosts } from "../api";
import { ConfirmDialog, EnvGroups, errorMessage, ErrorState, ListSkeleton, PermissionBadge, TargetRow } from "../kit";
import { hostAddress } from "../format";
import { groupByEnvironment } from "../logic";
import { useConnectionsUi } from "../store";
import { connStrings as s } from "../strings";
import type { Host, HostTestResult } from "../types";
import { HostFormSheet } from "./HostForm";
import { ImportDialog } from "./ImportDialog";
import { useHostTest } from "./useHostTest";

function TestDot({ result }: { result?: HostTestResult }) {
  if (!result) return null;
  return (
    <Tooltip content={result.ok ? `${s.hosts.detail.testOk}${result.latency_ms !== null ? ` · ${s.hosts.detail.latency(result.latency_ms)}` : ""}` : result.message} side="top">
      <span className="inline-flex">
        <StatusDot status={result.ok ? "success" : "error"} size={14} label={result.ok ? s.hosts.detail.testOk : result.message} />
      </span>
    </Tooltip>
  );
}

export function HostsTab() {
  const hosts = useHosts();
  const dialog = useConnectionsUi((st) => st.dialog);
  const seq = useConnectionsUi((st) => st.seq);
  const openDialog = useConnectionsUi((st) => st.open);
  const closeDialog = useConnectionsUi((st) => st.close);
  const navigate = useNavigate();
  const del = useDeleteHost();
  const { test, testingId, results, dialog: trustDialog } = useHostTest();
  const [edit, setEdit] = useState<{ open: boolean; key: number; host?: Host }>({ open: false, key: 0 });
  const [deleting, setDeleting] = useState<Host | null>(null);

  const list = hosts.data ?? [];
  const byId = new Map(list.map((h) => [h.id, h]));

  let body;
  if (hosts.isPending) body = <ListSkeleton rows={3} />;
  else if (hosts.isError) body = <ErrorState error={hosts.error} onRetry={() => void hosts.refetch()} />;
  else if (list.length === 0)
    body = (
      <EmptyState
        icon={<Server />}
        title={s.hosts.emptyTitle}
        description={s.hosts.emptyHint}
        action={
          <>
            <Button variant="primary" icon={<Plus />} onClick={() => openDialog("host.new")}>
              {s.hosts.add}
            </Button>
            <Button icon={<FileInput />} onClick={() => openDialog("host.import")}>
              {s.hosts.import}
            </Button>
          </>
        }
      />
    );
  else
    body = (
      <EnvGroups
        label={s.tabs.hosts}
        groups={groupByEnvironment(list)}
        render={(h) => {
          const jump = h.jump_host_id ? byId.get(h.jump_host_id) : undefined;
          return (
            <TargetRow
              key={h.id}
              to={`/connections/hosts/${encodeURIComponent(h.id)}`}
              environment={h.environment}
              icon={<Server />}
              title={h.name}
              subtitle={hostAddress(h)}
              badges={<TestDot result={results[h.id]} />}
              meta={
                <>
                  {jump && (
                    <Badge tone="neutral" size="sm" icon={<ArrowRightLeft aria-hidden />}>
                      {s.hosts.via(jump.name)}
                    </Badge>
                  )}
                  <Badge tone="neutral" variant="outline" size="sm">
                    {s.hosts.auth[h.auth]}
                  </Badge>
                  <PermissionBadge level={h.permission_level} environment={h.environment} />
                </>
              }
              actions={
                <>
                  <Button size="sm" variant="ghost" icon={<Activity />} loading={testingId === h.id} onClick={() => test(h)}>
                    Test
                  </Button>
                  <IconButton
                    label={h.environment === "production" ? s.hosts.terminalNeedsApproval : s.hosts.openTerminal}
                    icon={<SquareTerminal />}
                    onClick={() => void navigate(`/connections/hosts/${encodeURIComponent(h.id)}/terminal`)}
                  />
                  <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} tooltip={false} />}>
                    <MenuItem icon={<Pencil />} onSelect={() => setEdit((e) => ({ open: true, key: e.key + 1, host: h }))}>
                      {s.common.edit}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => setDeleting(h)}>
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
      <HostFormSheet
        key={`new-${seq}`}
        open={dialog === "host.new"}
        onOpenChange={(o) => !o && closeDialog()}
        hosts={list}
      />
      <HostFormSheet key={`edit-${edit.key}`} open={edit.open} onOpenChange={(o) => setEdit((e) => ({ ...e, open: o }))} host={edit.host} hosts={list} />
      <ImportDialog open={dialog === "host.import"} onOpenChange={(o) => !o && closeDialog()} />
      {trustDialog}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? s.hosts.deleteTitle(deleting.name) : ""}
        description={s.hosts.deleteBody}
        confirmLabel={s.common.delete}
        loading={del.isPending}
        requireText={deleting?.environment === "production" ? deleting.name : undefined}
        onConfirm={() => {
          const h = deleting;
          if (!h) return;
          del.mutate(h.id, {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: h.name });
              setDeleting(null);
            },
            onError: (err) => toast.error(s.common.deleteFailed, { description: errorMessage(err) }),
          });
        }}
      />
    </>
  );
}
