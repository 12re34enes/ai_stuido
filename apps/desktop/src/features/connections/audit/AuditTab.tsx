import { Download, FileDown, ScrollText, Search, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { useSearchParams } from "react-router";

import { backendInfo } from "@/lib/backend";
import { stagger } from "@/motion/tokens";
import { Button, Checkbox, EmptyState, IconButton, Input, Menu, MenuItem, SegmentedControl, Select, toast } from "@/ui";

import { fetchAuditPage, useAudit } from "../api";
import { ErrorState, ListSkeleton, useDebounced } from "../kit";
import { connStrings as s } from "../strings";
import type { AuditEntry, AuditQuery, CommandClass, Environment } from "../types";
import { AuditRow } from "./AuditRow";

const a = s.audit;

async function downloadAudit(format: "csv" | "json", q: AuditQuery) {
  const info = await backendInfo();
  const params = new URLSearchParams({ format });
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "" && k !== "limit") params.set(k, String(v));
  const res = await fetch(`${info.url}/api/remote/audit/export?${params.toString()}`, {
    headers: info.token ? { Authorization: `Bearer ${info.token}` } : {},
  });
  if (!res.ok) throw new Error(`${a.exportFailed} (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `aistudio-remote-audit.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Full remote audit log: filters, expandable records, paging and CSV/JSON export (spec §12 "Kayıt"). */
export function AuditTab() {
  const [params, setParams] = useSearchParams();
  const target = params.get("target") ?? undefined;
  const [kind, setKind] = useState<"all" | "host" | "db">("all");
  const [env, setEnv] = useState<"" | Environment>("");
  const [klass, setKlass] = useState<"" | CommandClass>("");
  const [denied, setDenied] = useState(false);
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const query: AuditQuery = {
    kind,
    target_id: target,
    environment: env || undefined,
    klass: klass || undefined,
    denied: denied || undefined,
    q: q || undefined,
    limit: 100,
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Input
          size="md"
          icon={<Search />}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={a.search}
          aria-label={a.search}
          wrapperClassName="min-w-48 flex-1"
          trailing={text ? <IconButton size="xs" label="Temizle" icon={<X />} tooltip={false} onClick={() => setText("")} /> : undefined}
        />
        <SegmentedControl
          aria-label="Kayıt türü"
          value={kind}
          onValueChange={setKind}
          options={(["all", "host", "db"] as const).map((k) => ({ value: k, label: a.filters.kind[k] }))}
        />
        <Select<"" | Environment>
          aria-label={a.filters.env}
          className="w-36"
          value={env}
          onValueChange={setEnv}
          options={[
            { value: "", label: a.filters.envAll },
            { value: "production", label: s.environment.group.production },
            { value: "test", label: s.environment.group.test },
            { value: "local", label: s.environment.group.local },
          ]}
        />
        <Select<"" | CommandClass>
          aria-label={a.filters.klass}
          className="w-32"
          value={klass}
          onValueChange={setKlass}
          options={[
            { value: "", label: a.filters.klassAll },
            { value: "read", label: s.classification.read },
            { value: "write", label: s.classification.write },
            { value: "unknown", label: s.classification.unknown },
          ]}
        />
        <Checkbox checked={denied} onCheckedChange={setDenied} label={<span className="text-xs">{a.filters.deniedOnly}</span>} className="ml-1" />
        <Menu
          align="end"
          trigger={
            <Button size="md" icon={<Download />}>
              {a.export}
            </Button>
          }
        >
          {(["csv", "json"] as const).map((fmt) => (
            <MenuItem
              key={fmt}
              icon={<FileDown />}
              onSelect={() => void downloadAudit(fmt, query).catch((e: unknown) => toast.error(a.exportFailed, { description: e instanceof Error ? e.message : undefined }))}
            >
              {fmt === "csv" ? a.exportCsv : a.exportJson}
            </MenuItem>
          ))}
        </Menu>
      </div>
      {target && (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <span>Hedef filtresi: <code className="font-mono text-fg">{target}</code></span>
          <Button size="sm" variant="ghost" icon={<X />} onClick={() => setParams({})}>
            Kaldır
          </Button>
        </div>
      )}
      <AuditList key={JSON.stringify(query)} query={query} />
    </div>
  );
}

function AuditList({ query }: { query: AuditQuery }) {
  const audit = useAudit(query);
  const [older, setOlder] = useState<{ entries: AuditEntry[]; next: number | null; hasMore: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  if (audit.isPending) return <ListSkeleton rows={5} />;
  if (audit.isError) return <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />;
  const first = audit.data;
  const entries = [...first.entries, ...(older?.entries ?? [])];
  const hasMore = older ? older.hasMore : first.has_more;
  const next = older ? older.next : first.next_before_id;
  if (entries.length === 0) return <EmptyState icon={<ScrollText />} title={a.emptyTitle} description={a.emptyHint} />;

  const loadMore = async () => {
    if (next === null) return;
    setLoading(true);
    try {
      const page = await fetchAuditPage(query, next);
      setOlder((o) => ({ entries: [...(o?.entries ?? []), ...page.entries], next: page.next_before_id, hasMore: page.has_more }));
    } catch (e) {
      toast.error(s.common.loadError, { description: e instanceof Error ? e.message : undefined });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-1">
        <div
          aria-hidden
          className="grid grid-cols-[92px_minmax(120px,170px)_minmax(0,1fr)_88px_150px_14px] gap-3 border-b border-line-subtle bg-canvas-subtle px-4 py-2 text-2xs font-medium tracking-wide text-fg-faint uppercase"
        >
          <span>{a.columns.time}</span>
          <span>{a.columns.target}</span>
          <span>{a.columns.command}</span>
          <span>{a.columns.klass}</span>
          <span>{a.columns.outcome}</span>
          <span />
        </div>
        <motion.ul initial="initial" animate="animate" variants={stagger(0.015)} className="divide-y divide-line-subtle" aria-label={a.title}>
          {entries.map((e) => (
            <AuditRow key={e.event_id} entry={e} expanded={open === e.event_id} onToggle={() => setOpen((o) => (o === e.event_id ? null : e.event_id))} />
          ))}
        </motion.ul>
      </div>
      {hasMore && (
        <div className="flex justify-center">
          <Button variant="ghost" loading={loading} onClick={() => void loadMore()}>
            {a.loadMore}
          </Button>
        </div>
      )}
    </div>
  );
}
