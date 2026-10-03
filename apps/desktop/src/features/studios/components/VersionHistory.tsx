import { useQuery } from "@tanstack/react-query";
import { ArrowRight, FileInput, History, RotateCcw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { formatDateTime, relativeTime } from "@/i18n/format";
import { spring, stagger, variants } from "@/motion/tokens";
import { Badge, Button, cn, Dialog, DiffView, EmptyState, Select, Skeleton, SkeletonText, Tooltip } from "@/ui";

import { fetchStudioVersion, studioKeys, useStudioVersions } from "../api";
import { studioStrings as s } from "../strings";
import { studioToYaml } from "../studioYaml";
import type { Studio } from "../types";
import { LoadError } from "./Page";

function useVersionYaml(studioId: string, version: number | null) {
  return useQuery({
    queryKey: studioKeys.detail(studioId, version ?? 0),
    queryFn: () => fetchStudioVersion(studioId, version!),
    enabled: version !== null,
    staleTime: Infinity,
    select: (studio: Studio) => ({ studio, yaml: studioToYaml(studio) }),
  });
}

export interface VersionHistoryProps {
  studioId: string;
  /** Called with the chosen version's studio; the parent saves it as a new version. */
  onRestore: (studio: Studio, version: number) => Promise<unknown>;
  onLoad: (yaml: string, version: number) => void;
}

export function VersionHistory({ studioId, onRestore, onLoad }: VersionHistoryProps) {
  const versions = useStudioVersions(studioId);
  const now = useNow(60_000);
  const list = useMemo(() => [...(versions.data ?? [])].sort((a, b) => b.version - a.version), [versions.data]);
  const latest = list[0]?.version ?? null;
  const [selected, setSelected] = useState<number | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const base = selected ?? (list.length > 1 ? list[1]!.version : null);
  const target = head ?? latest;
  const a = useVersionYaml(studioId, base);
  const b = useVersionYaml(studioId, target !== base ? target : null);

  if (versions.isPending)
    return (
      <div className="flex flex-col gap-3 p-4" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={44} className="rounded-lg" />
        ))}
      </div>
    );
  if (versions.isError) return <LoadError title={s.versionsLoadError} error={versions.error} onRetry={() => void versions.refetch()} />;
  if (list.length === 0) return <EmptyState size="sm" icon={<History />} title={s.versionsEmpty} />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <motion.ol className="flex flex-col gap-1" initial="initial" animate="animate" variants={stagger(0.03)} aria-label={s.versions}>
        {list.map((v) => {
          const active = base === v.version;
          return (
            <motion.li key={v.version} variants={variants.listItem} className="relative list-none">
              {active && <motion.span layoutId="studio-version-active" transition={spring.layout} className="absolute inset-0 rounded-lg border border-accent/40 bg-accent-soft/50" />}
              <button
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setSelected(v.version);
                  if (head === v.version) setHead(null);
                }}
                className="relative flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left outline-none transition-colors duration-150 hover:bg-surface-hover/60 focus-visible:shadow-[var(--focus-ring)]"
              >
                <span className={cn("mt-px font-mono text-xs font-medium tabular", active ? "text-accent" : "text-fg-muted")}>{s.version(v.version)}</span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={cn("truncate text-xs", v.note ? "text-fg" : "text-fg-faint")}>{v.note || (v.builtin ? s.builtinOriginal : "—")}</span>
                  {v.created_at && (
                    <Tooltip content={formatDateTime(v.created_at)} side="left">
                      <span className="w-fit text-2xs text-fg-faint">{relativeTime(v.created_at, new Date(now))}</span>
                    </Tooltip>
                  )}
                </span>
                {v.version === latest && <Badge tone="success">{s.current}</Badge>}
                {v.builtin && v.version !== latest && <Badge tone="neutral">{s.builtin}</Badge>}
              </button>
            </motion.li>
          );
        })}
      </motion.ol>

      {list.length > 1 && base !== null && (
        <motion.section layout {...variants.fadeUp} className="flex flex-col gap-3 border-t border-line-subtle pt-4" aria-label={s.compareWith}>
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-md bg-surface-sunken px-2 py-1 font-mono text-fg">{s.version(base)}</span>
            <ArrowRight className="size-3.5 text-fg-faint" aria-hidden />
            <Select
              size="sm"
              aria-label={s.compareWith}
              value={String(target)}
              onValueChange={(v) => setHead(Number(v))}
              options={list.filter((v) => v.version !== base).map((v) => ({ value: String(v.version), label: `${s.versionLong(v.version)}${v.version === latest ? ` · ${s.current}` : ""}` }))}
              className="w-44"
            />
          </div>
          <AnimatePresence mode="popLayout" initial={false}>
            {a.data && (target === base || b.data) ? (
              <motion.div key={`${base}-${target}`} {...variants.fadeUp}>
                {a.data.yaml === (b.data?.yaml ?? a.data.yaml) ? (
                  <p className="rounded-lg bg-surface-sunken px-3 py-4 text-center text-xs text-fg-muted">{s.noDiff}</p>
                ) : (
                  <DiffView original={a.data.yaml} modified={b.data!.yaml} filename={`${studioId}.yaml`} language="yaml" allowModeSwitch={false} maxHeight={360} />
                )}
              </motion.div>
            ) : (
              <motion.div key="loading" {...variants.fade}>
                <SkeletonText lines={6} />
              </motion.div>
            )}
          </AnimatePresence>
          <div className="flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" icon={<FileInput />} disabled={!a.data} onClick={() => a.data && onLoad(a.data.yaml, base)}>
              {s.loadIntoEditor}
            </Button>
            <Button size="sm" variant="secondary" icon={<RotateCcw />} disabled={!a.data || base === latest} onClick={() => setConfirm(true)}>
              {s.restore}
            </Button>
          </div>
        </motion.section>
      )}

      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={s.restoreTitle(base ?? 0)}
        description={s.restoreDescription(base ?? 0, (latest ?? 0) + 1)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {s.cancel}
            </Button>
            <Button
              variant="primary"
              icon={<RotateCcw />}
              loading={restoring}
              onClick={async () => {
                if (!a.data || base === null) return;
                setRestoring(true);
                try {
                  await onRestore(a.data.studio, base);
                  setConfirm(false);
                  setSelected(null);
                  setHead(null);
                } finally {
                  setRestoring(false);
                }
              }}
            >
              {s.restore}
            </Button>
          </>
        }
      />
    </div>
  );
}
