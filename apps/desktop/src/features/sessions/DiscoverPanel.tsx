/**
 * "Mevcut oturumlar" (spec §6): CLI sessions found on this Mac or on an SSH host, grouped by
 * project directory, each importable as a studio session (already-imported ones open directly).
 */
import { Check, FolderOpen, GitBranch, Laptop, Plus, RotateCw, Search, Server } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { ApiError } from "@/lib/api";
import { isMissingEndpoint } from "@/lib/connection";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, stagger, transition, variants } from "@/motion/tokens";
import { Badge, Button, cn, EmptyState, EnvBadge, Input, ProviderMark, Skeleton, toast, uiStrings } from "@/ui";

import { useDiscover, useImportSession, useRemoteHosts, type DiscoveredSession, type RemoteHost } from "./api";
import { groupByProject, guessHome, type ProjectGroup } from "./filters";
import { HealthChips } from "./HealthChips";
import { ErrorState } from "./kit/Page";
import { sessionStrings as t } from "./strings";

const d = t.discover;

function LocationButton({
  active,
  onClick,
  icon,
  label,
  hint,
  trailing,
  groupId,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  hint?: string;
  trailing?: React.ReactNode;
  groupId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
        active ? "text-fg" : "text-fg-muted hover:bg-surface-hover hover:text-fg",
      )}
    >
      {active && (
        <motion.span layoutId={`${groupId}-loc`} className="absolute inset-0 rounded-lg border border-line bg-surface shadow-1" transition={spring.layout} />
      )}
      <span className="relative flex shrink-0 text-fg-muted [&_svg]:size-4">{icon}</span>
      <span className="relative flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{label}</span>
        {hint && <span className="truncate font-mono text-2xs text-fg-faint">{hint}</span>}
      </span>
      {trailing && <span className="relative shrink-0">{trailing}</span>}
    </button>
  );
}

function SessionRow({ s, now, onImport, importing }: { s: DiscoveredSession; now: number; onImport: () => void; importing: boolean }) {
  const navigate = useNavigate();
  const when = s.updated_at ?? s.created_at;
  const claude = s.provider === "claude";
  return (
    <motion.li
      layout="position"
      variants={variants.listItem}
      className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 hover:bg-surface-hover"
    >
      <ProviderMark provider={s.provider} variant="tile" size={24} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("min-w-0 truncate text-sm text-fg", claude ? "font-serif" : "font-mono text-xs font-medium")}>{s.title || d.untitled}</span>
          {s.running && (
            <Badge tone="accent" dot>
              {d.running}
            </Badge>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-2xs text-fg-muted">
          {s.model && <span className="truncate font-mono">{s.model}</span>}
          {s.model && <span className="text-fg-faint">·</span>}
          {s.message_count !== null && <span className="shrink-0 tabular">{d.messages(s.message_count)}</span>}
          {s.branch && (
            <>
              <span className="text-fg-faint">·</span>
              <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                <GitBranch className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{s.branch}</span>
              </span>
            </>
          )}
          {when && (
            <>
              <span className="text-fg-faint">·</span>
              <time dateTime={when} className="shrink-0">
                {relativeTime(when, new Date(now))}
              </time>
            </>
          )}
        </div>
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        {s.imported_session_id ? (
          <motion.span
            key="open"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1, transition: spring.bouncy }}
            exit={{ opacity: 0, transition: transition.exit }}
            className="flex items-center gap-2"
          >
            <span className="inline-flex items-center gap-1 text-2xs font-medium text-success">
              <Check className="size-3.5" aria-hidden />
              {d.imported}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void navigate(`/sessions/${s.imported_session_id}`)}>
              {d.open}
            </Button>
          </motion.span>
        ) : (
          <motion.span key="import" {...variants.fade} className="flex">
            <Button size="sm" variant="secondary" icon={<Plus />} loading={importing} onClick={onImport} aria-label={`${d.import}: ${s.title || d.untitled}`}>
              {d.import}
            </Button>
          </motion.span>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function Group({ group, now, importing, onImport }: { group: ProjectGroup; now: number; importing: string | null; onImport: (s: DiscoveredSession) => void }) {
  return (
    <motion.section variants={variants.fadeUp} className="flex flex-col gap-1" aria-label={group.cwd || d.untitled}>
      <header className="flex items-baseline gap-2 px-3 pb-1">
        <FolderOpen className="size-3.5 shrink-0 translate-y-[2px] text-fg-faint" aria-hidden />
        <span className="font-mono text-xs font-medium text-fg">{group.name || "/"}</span>
        <span className="min-w-0 truncate font-mono text-2xs text-fg-faint" title={group.cwd}>
          {group.parent}
        </span>
        <span className="ml-auto shrink-0 text-2xs text-fg-faint tabular">{d.group(group.items.length)}</span>
      </header>
      <motion.ul initial="initial" animate="animate" variants={stagger(0.025)} className="flex flex-col">
        {group.items.map((s) => (
          <SessionRow
            key={`${s.provider}:${s.native_id}`}
            s={s}
            now={now}
            importing={importing === `${s.provider}:${s.native_id}`}
            onImport={() => onImport(s)}
          />
        ))}
      </motion.ul>
    </motion.section>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <span className="sr-only">{d.scanning}</span>
      {[0, 1].map((g) => (
        <div key={g} className="flex flex-col gap-2 px-3">
          <Skeleton height={10} width={180} />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <Skeleton width={24} height={24} className="rounded-[7px]" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton height={10} width={`${60 - i * 12}%`} />
                <Skeleton height={8} width="34%" />
              </div>
              <Skeleton width={56} height={26} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function DiscoverPanel() {
  const groupId = useId();
  const now = useNow(60_000);
  const { workspace } = useCurrentWorkspace();
  const hosts = useRemoteHosts();
  const [hostId, setHostId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [filter, setFilter] = useState("");
  const discover = useDiscover(hostId, cwd);
  const importer = useImportSession();
  const [importing, setImporting] = useState<string | null>(null);
  const groups = useMemo(() => {
    const list = discover.data ?? [];
    const q = filter.trim().toLocaleLowerCase("tr-TR");
    const shown = q ? list.filter((s) => [s.title, s.cwd, s.branch, s.model].some((v) => v?.toLocaleLowerCase("tr-TR").includes(q))) : list;
    return groupByProject(shown, guessHome(list));
  }, [discover.data, filter]);

  const onImport = (s: DiscoveredSession) => {
    if (!workspace) {
      toast.error(d.importFailed, { description: d.noWorkspace });
      return;
    }
    setImporting(`${s.provider}:${s.native_id}`);
    importer.mutate(
      { workspace_id: workspace.id, session: s },
      {
        onSuccess: (rec) => toast.success(d.importDone, { description: rec.label ?? s.title ?? undefined }),
        onError: (err) => toast.error(d.importFailed, { description: err instanceof ApiError ? err.message : undefined }),
        onSettled: () => setImporting(null),
      },
    );
  };

  const hostList: RemoteHost[] = hosts.data ?? [];
  const selectedHost = hostList.find((h) => h.id === hostId);
  return (
    <div className="grid grid-cols-[232px_minmax(0,1fr)] gap-6 pb-10">
      <aside className="flex flex-col gap-3">
        <span className="px-2.5 text-2xs font-medium tracking-[0.06em] text-fg-faint uppercase">{d.location}</span>
        <LayoutGroup id={groupId}>
          <div role="radiogroup" aria-label={d.location} className="flex flex-col gap-0.5">
            <LocationButton groupId={groupId} active={hostId === null} onClick={() => setHostId(null)} icon={<Laptop />} label={d.thisMac} />
            {hostList.map((h) => (
              <LocationButton
                key={h.id}
                groupId={groupId}
                active={hostId === h.id}
                onClick={() => setHostId(h.id)}
                icon={<Server />}
                label={h.name}
                hint={`${h.username}@${h.hostname}`}
                trailing={
                  h.environment !== "local" ? (
                    <span
                      role="img"
                      aria-label={uiStrings.environment[h.environment]}
                      className={cn("block size-1.5 rounded-full", h.environment === "production" ? "bg-env-production" : "bg-env-test")}
                    />
                  ) : undefined
                }
              />
            ))}
          </div>
        </LayoutGroup>
        {hosts.isError && !isMissingEndpoint(hosts.error) && <p className="px-2.5 text-2xs text-fg-faint">{d.hostsError}</p>}
      </aside>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="md"
            icon={<Search />}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t.filters.search}
            aria-label={t.filters.search}
            wrapperClassName="w-52"
          />
          <Input
            size="md"
            icon={<FolderOpen />}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder={d.cwdPlaceholder}
            aria-label={d.cwdFilter}
            className="font-mono text-xs"
            wrapperClassName="w-56"
            spellCheck={false}
          />
          {selectedHost && <EnvBadge environment={selectedHost.environment} label={selectedHost.name} />}
          <div className="ml-auto flex items-center gap-2">
            {hostId && <HealthChips hostId={hostId} />}
            <Button size="md" variant="ghost" icon={<RotateCw />} loading={discover.isFetching} onClick={() => void discover.refetch()}>
              {d.refresh}
            </Button>
          </div>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={`${hostId ?? "local"}:${cwd}`} {...variants.fade}>
            {discover.isLoading ? (
              <ListSkeleton />
            ) : discover.isError ? (
              <ErrorState title={d.loadError} error={discover.error} onRetry={() => void discover.refetch()} />
            ) : groups.length === 0 ? (
              <EmptyState icon={<FolderOpen />} title={d.empty} description={d.emptyHint} />
            ) : (
              <motion.div initial="initial" animate="animate" variants={stagger(0.05)} className="flex flex-col gap-6">
                {groups.map((g) => (
                  <Group key={g.cwd} group={g} now={now} importing={importing} onImport={onImport} />
                ))}
              </motion.div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
