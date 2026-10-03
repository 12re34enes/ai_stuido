import { Activity, ArrowRightLeft, Database, MoreHorizontal, Pencil, Plus, SquareCode, Trash2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { Badge, Button, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, StatusDot, toast, Tooltip } from "@/ui";

import { useDbProfiles, useDeleteDbProfile, useHosts } from "../api";
import { ConfirmDialog, EnvGroups, errorMessage, ErrorState, ListSkeleton, PermissionBadge, TargetRow } from "../kit";
import { dbTarget } from "../format";
import { groupByEnvironment } from "../logic";
import { useConnectionsUi } from "../store";
import { connStrings as s } from "../strings";
import type { DbProfile } from "../types";
import { DbFormSheet } from "./DbForm";
import { useDbTest } from "./useDbTest";

export function DatabasesTab() {
  const dbs = useDbProfiles();
  const hosts = useHosts();
  const dialog = useConnectionsUi((st) => st.dialog);
  const seq = useConnectionsUi((st) => st.seq);
  const openDialog = useConnectionsUi((st) => st.open);
  const closeDialog = useConnectionsUi((st) => st.close);
  const navigate = useNavigate();
  const del = useDeleteDbProfile();
  const { test, testingId, results } = useDbTest();
  const [edit, setEdit] = useState<{ open: boolean; key: number; db?: DbProfile }>({ open: false, key: 0 });
  const [deleting, setDeleting] = useState<DbProfile | null>(null);
  const hostList = hosts.data ?? [];
  const list = dbs.data ?? [];

  let body;
  if (dbs.isPending) body = <ListSkeleton rows={3} />;
  else if (dbs.isError) body = <ErrorState error={dbs.error} onRetry={() => void dbs.refetch()} />;
  else if (list.length === 0)
    body = (
      <EmptyState
        icon={<Database />}
        title={s.databases.emptyTitle}
        description={s.databases.emptyHint}
        action={
          <Button variant="primary" icon={<Plus />} onClick={() => openDialog("db.new")}>
            {s.databases.add}
          </Button>
        }
      />
    );
  else
    body = (
      <EnvGroups
        label={s.tabs.databases}
        groups={groupByEnvironment(list)}
        render={(db) => {
          const via = db.via_host_id ? hostList.find((h) => h.id === db.via_host_id) : undefined;
          const result = results[db.id];
          const path = `/connections/databases/${encodeURIComponent(db.id)}`;
          return (
            <TargetRow
              key={db.id}
              to={path}
              environment={db.environment}
              icon={<Database />}
              title={db.name}
              subtitle={dbTarget(db)}
              badges={
                <>
                  <Badge tone="neutral" size="sm">
                    {s.databases.kind[db.kind]}
                  </Badge>
                  {result && (
                    <Tooltip content={result.ok ? s.hosts.detail.testOk : result.message} side="top">
                      <span className="inline-flex">
                        <StatusDot status={result.ok ? "success" : "error"} size={14} label={result.ok ? s.hosts.detail.testOk : result.message} />
                      </span>
                    </Tooltip>
                  )}
                </>
              }
              meta={
                <>
                  {via && (
                    <Badge tone="neutral" size="sm" icon={<ArrowRightLeft aria-hidden />}>
                      {s.databases.tunnel(via.name)}
                    </Badge>
                  )}
                  <PermissionBadge level={db.permission_level} environment={db.environment} />
                </>
              }
              actions={
                <>
                  <Button size="sm" variant="ghost" icon={<Activity />} loading={testingId === db.id} onClick={() => test(db)}>
                    Test
                  </Button>
                  <IconButton label={s.databases.console} icon={<SquareCode />} onClick={() => void navigate(path)} />
                  <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} tooltip={false} />}>
                    <MenuItem icon={<Pencil />} onSelect={() => setEdit((e) => ({ open: true, key: e.key + 1, db }))}>
                      {s.common.edit}
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => setDeleting(db)}>
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
      <DbFormSheet key={`new-${seq}`} open={dialog === "db.new"} onOpenChange={(o) => !o && closeDialog()} hosts={hostList} />
      <DbFormSheet key={`edit-${edit.key}`} open={edit.open} onOpenChange={(o) => setEdit((e) => ({ ...e, open: o }))} db={edit.db} hosts={hostList} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? s.databases.deleteTitle(deleting.name) : ""}
        description={s.databases.deleteBody}
        confirmLabel={s.common.delete}
        loading={del.isPending}
        requireText={deleting?.environment === "production" ? deleting.name : undefined}
        onConfirm={() => {
          const db = deleting;
          if (!db) return;
          del.mutate(db.id, {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: db.name });
              setDeleting(null);
            },
            onError: (err) => toast.error(s.common.deleteFailed, { description: errorMessage(err) }),
          });
        }}
      />
    </>
  );
}
