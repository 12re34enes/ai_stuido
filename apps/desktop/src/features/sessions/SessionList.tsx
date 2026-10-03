/** Sessions list: filters in one row, active sessions first as live AgentCards. */
import { PanelRightOpen, Plus, Search, TerminalSquare } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { readPref, writePref } from "@/lib/storage";
import { useWorkspaces } from "@/lib/queries";
import { spring, transition, variants } from "@/motion/tokens";
import { AgentCard, Badge, Button, EmptyState, IconButton, Input, ProviderMark, SegmentedControl, Select, Skeleton, uiStrings } from "@/ui";

import { useSessions, type SessionView } from "./api";
import { openSessionDrawer } from "./drawer";
import { DEFAULT_FILTERS, filterSessions, hasActiveFilters, splitActive, type ProviderFilter, type SessionFilters, type StateFilter } from "./filters";
import { ErrorState, FilterRow, SectionLabel } from "./kit/Page";
import { useLastLines, useSessionListLive } from "./live";
import { sessionStrings as t } from "./strings";
import { sessionTitle, shortPath } from "./format";

const ALL = "__all";

function CardGrid({ items, lines }: { items: SessionView[]; lines: Record<string, string> }) {
  const navigate = useNavigate();
  return (
    <motion.ul layout className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3" transition={spring.layout}>
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((s) => (
          <motion.li
            key={s.id}
            layoutId={`session-card-${s.id}`}
            variants={variants.listItem}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={spring.layout}
            className="list-none"
          >
            <AgentCard
              provider={s.provider}
              title={sessionTitle(s)}
              model={s.model}
              role={s.role}
              state={s.state}
              usage={s.last_usage}
              lastLine={lines[s.id] ?? (s.title && s.title !== s.label ? s.title : shortPath(s.cwd, 3))}
              onClick={() => void navigate(`/sessions/${s.id}`)}
              actions={
                <>
                  {s.origin !== "created" && (
                    <Badge tone={s.provider === "claude" ? "claude" : "codex"} variant="outline">
                      {t.origin[s.origin]}
                    </Badge>
                  )}
                  <IconButton
                    label={t.openDrawer}
                    icon={<PanelRightOpen />}
                    size="sm"
                    className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      openSessionDrawer(s);
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </>
              }
            />
          </motion.li>
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3" aria-busy>
      <span className="sr-only">{t.stream.loading}</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-[150px] flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            <Skeleton width={28} height={28} className="rounded-[8px]" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton height={11} width="58%" />
              <Skeleton height={8} width="36%" />
            </div>
          </div>
          <Skeleton height={28} />
          <Skeleton height={8} width="44%" />
        </div>
      ))}
    </div>
  );
}

export function SessionList({ onNew }: { onNew: () => void }) {
  const sessions = useSessions();
  const workspaces = useWorkspaces();
  const lines = useLastLines((s) => s.lines);
  const [filters, setFiltersState] = useState<SessionFilters>(() => ({
    ...DEFAULT_FILTERS,
    ...readPref<Partial<SessionFilters>>("sessions.filters", {}),
    q: "",
  }));
  useSessionListLive();

  const setFilters = (patch: Partial<SessionFilters>) => {
    setFiltersState((prev) => {
      const next = { ...prev, ...patch };
      writePref("sessions.filters", { state: next.state, provider: next.provider, workspaceId: next.workspaceId });
      return next;
    });
  };

  const { active, recent } = useMemo(() => splitActive(filterSessions(sessions.data ?? [], filters)), [filters, sessions.data]);
  const total = sessions.data?.length ?? 0;
  const filtered = hasActiveFilters(filters);

  return (
    <div className="flex flex-col gap-6 pb-10">
      <FilterRow>
        <Input
          icon={<Search />}
          value={filters.q}
          onChange={(e) => setFilters({ q: e.target.value })}
          placeholder={t.filters.search}
          aria-label={t.filters.search}
          wrapperClassName="w-60"
        />
        <SegmentedControl<StateFilter>
          aria-label={t.filters.state}
          value={filters.state}
          onValueChange={(state) => setFilters({ state })}
          options={[
            { value: "all", label: t.filters.allStates },
            { value: "active", label: t.filters.active },
            { value: "finished", label: t.filters.finished },
          ]}
        />
        <SegmentedControl<ProviderFilter>
          aria-label={t.filters.provider}
          value={filters.provider}
          onValueChange={(provider) => setFilters({ provider })}
          options={[
            { value: "all", label: t.filters.allProviders },
            { value: "claude", label: uiStrings.providers.claude, icon: <ProviderMark provider="claude" size={13} label="" /> },
            { value: "codex", label: uiStrings.providers.codex, icon: <ProviderMark provider="codex" size={13} label="" /> },
          ]}
        />
        {(workspaces.data?.length ?? 0) > 1 && (
          <Select
            aria-label={t.filters.workspace}
            value={filters.workspaceId ?? ALL}
            onValueChange={(v) => setFilters({ workspaceId: v === ALL ? null : v })}
            options={[{ value: ALL, label: t.filters.allWorkspaces }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))]}
            className="w-52"
          />
        )}
        {total > 0 && <span className="ml-auto text-xs text-fg-faint tabular">{t.count(active.length + recent.length)}</span>}
      </FilterRow>

      {sessions.isLoading ? (
        <GridSkeleton />
      ) : sessions.isError ? (
        <ErrorState title={t.loadError} error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : total === 0 ? (
        <EmptyState
          icon={<TerminalSquare />}
          title={t.empty.title}
          description={t.empty.description}
          action={
            <Button variant="primary" icon={<Plus />} onClick={onNew}>
              {t.newSession}
            </Button>
          }
        />
      ) : active.length + recent.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title={t.empty.filtered}
          description={t.empty.filteredHint}
          action={
            filtered && (
              <Button size="sm" onClick={() => setFiltersState(DEFAULT_FILTERS)}>
                {t.empty.clear}
              </Button>
            )
          }
        />
      ) : (
        <LayoutGroup id="sessions-list">
          <motion.div layout transition={spring.layout} className="flex flex-col gap-7">
            <AnimatePresence initial={false}>
              {active.length > 0 && (
                <motion.section
                  key="active"
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: transition.standard }}
                  exit={{ opacity: 0, transition: transition.exit }}
                  className="flex flex-col gap-3"
                  aria-label={t.sections.active}
                >
                  <SectionLabel count={active.length}>{t.sections.active}</SectionLabel>
                  <CardGrid items={active} lines={lines} />
                </motion.section>
              )}
              {recent.length > 0 && (
                <motion.section
                  key="recent"
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: transition.standard }}
                  exit={{ opacity: 0, transition: transition.exit }}
                  className="flex flex-col gap-3"
                  aria-label={t.sections.recent}
                >
                  <SectionLabel count={recent.length}>{t.sections.recent}</SectionLabel>
                  <CardGrid items={recent} lines={lines} />
                </motion.section>
              )}
            </AnimatePresence>
          </motion.div>
        </LayoutGroup>
      )}
    </div>
  );
}
