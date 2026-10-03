import { Activity, CheckCircle2, Database, MoreHorizontal, Pencil, ScrollText, Trash2, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";

import { useEnvironmentScope } from "@/lib/environment";
import { variants } from "@/motion/tokens";
import { Badge, Button, EmptyState, EnvBadge, IconButton, Menu, MenuItem, MenuSeparator, Skeleton, toast } from "@/ui";

import { useDbProfile, useDeleteDbProfile, useHosts } from "../api";
import { AuditPreview } from "../audit/AuditPreview";
import { BackLink, Callout, ConfirmDialog, errorMessage, ErrorState, PageBody, PageHeader, PermissionBadge, Section, TargetIcon, useScrollTopOnMount } from "../kit";
import { dbTarget } from "../format";
import { connStrings as s } from "../strings";
import type { DbProfile } from "../types";
import { useDbTest } from "./useDbTest";
import { DbFormSheet } from "./DbForm";
import { QueryConsole } from "./QueryConsole";

const d = s.databases.detail;

export function DbDetailPage() {
  const { id = "" } = useParams();
  const db = useDbProfile(id);
  const scrollTop = useScrollTopOnMount();
  if (db.isPending)
    return (
      <PageBody>
        <Skeleton height={14} width={90} />
        <Skeleton height={28} width={260} />
        <Skeleton height={220} />
      </PageBody>
    );
  if (db.isError || !db.data)
    return (
      <PageBody>
        <BackLink to="/connections/databases">{s.tabs.databases}</BackLink>
        <ErrorState error={db.error} title={s.common.notFound} onRetry={() => void db.refetch()} />
      </PageBody>
    );
  return (
    <div ref={scrollTop}>
      <DbDetail db={db.data} />
    </div>
  );
}

function DbDetail({ db }: { db: DbProfile }) {
  useEnvironmentScope(db.environment, db.name);
  const navigate = useNavigate();
  const hosts = useHosts();
  const del = useDeleteDbProfile();
  const { test, testingId, results } = useDbTest();
  const [edit, setEdit] = useState({ open: false, key: 0 });
  const [deleting, setDeleting] = useState(false);
  const via = db.via_host_id ? hosts.data?.find((h) => h.id === db.via_host_id) : undefined;
  const production = db.environment === "production";
  const result = results[db.id];
  const readonlyTx = production || db.permission_level === "read";

  return (
    <PageBody>
      <PageHeader
        back={<BackLink to="/connections/databases">{s.tabs.databases}</BackLink>}
        title={
          <span className="flex items-center gap-3">
            <TargetIcon environment={db.environment} icon={<Database />} size={34} />
            {db.name}
          </span>
        }
        badges={
          <>
            <EnvBadge environment={db.environment} size="md" />
            <PermissionBadge level={db.permission_level} environment={db.environment} size="md" />
          </>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral" size="sm">
              {s.databases.kind[db.kind]}
            </Badge>
            <span className="font-mono text-xs">{dbTarget(db)}</span>
            {via && <span className="text-xs">· {s.databases.tunnel(via.name)}</span>}
          </span>
        }
        actions={
          <>
            <Button icon={<Activity />} loading={testingId === db.id} onClick={() => test(db, true)}>
              {s.common.test}
            </Button>
            <Menu align="end" trigger={<IconButton label={s.common.more} icon={<MoreHorizontal />} variant="secondary" tooltip={false} size="lg" />}>
              <MenuItem icon={<Pencil />} onSelect={() => setEdit((e) => ({ open: true, key: e.key + 1 }))}>
                {s.common.edit}
              </MenuItem>
              <MenuItem icon={<ScrollText />} onSelect={() => void navigate(`/connections/audit?target=${encodeURIComponent(db.id)}`)}>
                {s.hosts.detail.viewAudit}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => setDeleting(true)}>
                {s.common.delete}
              </MenuItem>
            </Menu>
          </>
        }
      />

      <AnimatePresence initial={false}>
        {result && (
          <motion.div key={result.ok ? "ok" : "fail"} {...variants.fadeUp}>
            <Callout tone={result.ok ? "success" : "danger"} icon={result.ok ? <CheckCircle2 /> : <XCircle />} title={result.ok ? s.hosts.detail.testOk : result.message}>
              {result.ok ? [result.server_version, result.latency_ms !== null ? `${result.latency_ms} ms` : null].filter(Boolean).join(" · ") : undefined}
            </Callout>
          </motion.div>
        )}
      </AnimatePresence>

      {production ? (
        <Callout tone="production" title={s.environment.group.production}>
          {s.environment.productionNote} {d.readonlyNote}
        </Callout>
      ) : (
        readonlyTx && <Callout tone="neutral">{d.readonlyNote}</Callout>
      )}

      <QueryConsole db={db} />

      <Section title={d.history}>
        <AuditPreview query={{ kind: "db", target_id: db.id, limit: 8 }} empty={<EmptyState size="sm" icon={<ScrollText />} title={d.historyEmpty} />} />
      </Section>

      <DbFormSheet key={edit.key} open={edit.open} onOpenChange={(o) => setEdit((e) => ({ ...e, open: o }))} db={db} hosts={hosts.data ?? []} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={s.databases.deleteTitle(db.name)}
        description={s.databases.deleteBody}
        confirmLabel={s.common.delete}
        loading={del.isPending}
        requireText={production ? db.name : undefined}
        onConfirm={() =>
          del.mutate(db.id, {
            onSuccess: () => {
              toast.success(s.common.deleted, { description: db.name });
              void navigate("/connections/databases");
            },
            onError: (err) => toast.error(s.common.deleteFailed, { description: errorMessage(err) }),
          })
        }
      />
    </PageBody>
  );
}
