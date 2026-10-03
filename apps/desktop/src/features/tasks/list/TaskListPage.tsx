/**
 * Task list (`/tasks`): filters (status, mode, source, search) in the URL, day-grouped virtualized
 * list with live status dots, bulk cancel, and the queue view. Schedules live under /flows.
 */
import { CalendarClock, ListChecks, Plus, RotateCw, SearchX } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";

import { isMissingEndpoint } from "@/lib/connection";
import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { useCurrentWorkspace } from "@/lib/workspace";
import { variants } from "@/motion/tokens";
import { AnimatedNumber, Button, EmptyState, ProgressBar, SegmentedControl, Skeleton, toast } from "@/ui";

import { openComposer } from "../create/commands";
import { BulkBar } from "./BulkBar";
import { FilterBar } from "./FilterBar";
import { EMPTY_FILTERS, filtersToParams, hasActiveFilters, parseFilters, type ListView, type TaskFilters } from "./filters";
import { useTaskLiveSync } from "./live";
import { useCancelTask, useTaskPages } from "./queries";
import { QueueView } from "./QueueView";
import { taskStrings as s } from "./strings";
import { TaskList } from "./TaskList";
import { CANCELLABLE, type Task } from "./types";

function ListSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col px-9 pt-3" aria-hidden>
      <Skeleton width={64} height={10} className="mb-4" />
      {[0.62, 0.48, 0.7, 0.4, 0.56, 0.66].map((w, i) => (
        <div key={i} className="flex h-11 items-center gap-3">
          <Skeleton circle width={10} height={10} />
          <Skeleton height={10} style={{ width: `${w * 70}%` }} />
          <span className="flex-1" />
          <Skeleton width={44} height={14} className="rounded-full" />
          <Skeleton width={36} height={10} />
        </div>
      ))}
    </div>
  );
}

export function TaskListPage() {
  const { workspace } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const searchRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const cancel = useCancelTask();
  useTaskLiveSync(workspace?.id);

  const setFilters = useCallback(
    (next: TaskFilters) => {
      setParams(filtersToParams(next), { replace: true });
      setSelected(new Set());
    },
    [setParams],
  );

  const query = useTaskPages(
    workspace ? { workspaceId: workspace.id, statuses: filters.statuses, mode: filters.mode, source: filters.source, q: filters.q } : null,
  );
  const tasks = useMemo<Task[]>(() => query.data?.pages.flat() ?? [], [query.data]);
  const { fetchNextPage } = query;
  const loadMore = useCallback(() => void fetchNextPage(), [fetchNextPage]);

  const selectedTasks = tasks.filter((t) => selected.has(t.id));
  const cancellable = selectedTasks.filter((t) => CANCELLABLE.includes(t.status));

  const bulkCancel = async () => {
    if (!cancellable.length) {
      toast({ title: s.select.nothingToCancel, tone: "warning" });
      return;
    }
    setBulkBusy(true);
    const results = await Promise.allSettled(cancellable.map((t) => cancel.mutateAsync(t.id)));
    setBulkBusy(false);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - ok;
    if (ok) toast({ title: s.select.cancelled(ok), tone: "success" });
    if (failed) toast({ title: s.select.cancelFailed(failed), tone: "danger" });
    setSelected(new Set());
  };

  useRegisterCommands(
    useMemo<StudioCommand[]>(
      () => [
        {
          id: "tasks.search",
          title: s.filters.search,
          group: commandGroups.actions,
          shortcut: "⌘F",
          global: true,
          keywords: ["ara", "search", "filtre"],
          run: () => {
            if (filters.view !== "list") setFilters({ ...filters, view: "list" });
            requestAnimationFrame(() => searchRef.current?.focus());
          },
        },
        ...(hasActiveFilters(filters)
          ? [{ id: "tasks.filters.clear", title: s.filters.clear, group: commandGroups.actions, run: () => setFilters({ ...EMPTY_FILTERS, view: filters.view }) }]
          : []),
      ],
      [filters, setFilters],
    ),
  );

  const view = filters.view;
  const filtered = hasActiveFilters(filters);

  return (
    <div className="relative flex h-full flex-col">
      <header className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-9 pt-8 pb-3">
        <div className="flex items-end gap-4">
          <div className="flex min-w-0 flex-1 items-baseline gap-3">
            <h1 className="text-xl text-fg">{s.title}</h1>
            <AnimatePresence initial={false}>
              {view === "list" && query.isSuccess && tasks.length > 0 && (
                <motion.span key="count" {...variants.fade} className="text-sm text-fg-muted tabular">
                  <AnimatedNumber value={tasks.length} />
                  {query.hasNextPage ? "+" : ""}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          <SegmentedControl<ListView>
            size="sm"
            aria-label={s.viewsLabel}
            value={view}
            onValueChange={(v) => setFilters({ ...filters, view: v })}
            options={[
              { value: "list", label: s.views.list },
              { value: "queue", label: s.views.queue },
            ]}
          />
          <Link
            to="/flows/schedules"
            title={s.schedulesHint}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-fg-muted outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)] [&_svg]:size-3.5"
          >
            <CalendarClock />
            {s.schedules}
          </Link>
          <Button variant="primary" size="sm" icon={<Plus />} onClick={() => openComposer()}>
            {s.newTask}
          </Button>
        </div>
        <AnimatePresence initial={false} mode="popLayout">
          {view === "list" && (
            <motion.div key="filters" {...variants.fadeUp}>
              <FilterBar filters={filters} onChange={setFilters} searchRef={searchRef} />
            </motion.div>
          )}
        </AnimatePresence>
        <div className="relative h-px">
          <AnimatePresence>
            {view === "list" && query.isPlaceholderData && (
              <motion.div key="refetch" className="absolute inset-x-0 -top-px" {...variants.fade}>
                <ProgressBar size="xs" tone="accent" aria-label={s.loadMore} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </header>

      <AnimatePresence mode="popLayout" initial={false}>
        {view === "queue" && workspace ? (
          <motion.div key="queue" className="flex min-h-0 flex-1 flex-col" {...variants.fadeUp}>
            <QueueView workspaceId={workspace.id} />
          </motion.div>
        ) : (
          <motion.div key="list" className="flex min-h-0 flex-1 flex-col" {...variants.fade}>
            {!workspace || query.isPending ? (
              <ListSkeleton />
            ) : query.isError ? (
              <EmptyState
                icon={<RotateCw />}
                title={s.error.title}
                description={isMissingEndpoint(query.error) ? s.error.missing : query.error instanceof Error ? query.error.message : undefined}
                action={
                  !isMissingEndpoint(query.error) && (
                    <Button variant="secondary" icon={<RotateCw />} onClick={() => void query.refetch()}>
                      {s.error.retry}
                    </Button>
                  )
                }
                className="pt-[12vh]"
              />
            ) : tasks.length === 0 ? (
              filtered ? (
                <EmptyState
                  icon={<SearchX />}
                  title={s.empty.filteredTitle}
                  description={s.empty.filteredDescription}
                  action={
                    <Button variant="secondary" onClick={() => setFilters({ ...EMPTY_FILTERS })}>
                      {s.filters.clear}
                    </Button>
                  }
                  className="pt-[12vh]"
                />
              ) : (
                <EmptyState
                  icon={<ListChecks />}
                  title={s.empty.title}
                  description={s.empty.description}
                  action={
                    <Button variant="primary" icon={<Plus />} onClick={() => openComposer()}>
                      {s.empty.action}
                    </Button>
                  }
                  className="pt-[12vh]"
                />
              )
            ) : (
              <TaskList
                tasks={tasks}
                selected={selected}
                onSelectedChange={setSelected}
                hasMore={!!query.hasNextPage}
                loadingMore={query.isFetchingNextPage}
                onLoadMore={loadMore}
              />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <BulkBar
        count={selectedTasks.length}
        cancellable={cancellable.length}
        busy={bulkBusy}
        onCancel={() => void bulkCancel()}
        onClear={() => setSelected(new Set())}
      />
    </div>
  );
}
