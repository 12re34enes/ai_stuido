/**
 * Approvals inbox: pending / decided tabs, filters in one row, production requests first and
 * apart. Keyboard: J/K move, A approve, R reject, Enter opens the detail page.
 */
import { CheckCheck, Inbox, ListFilter, SearchX } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { useWorkspaces } from "@/lib/queries";
import type { Approval, ApprovalKind, Severity } from "@/lib/types";
import { spring, variants } from "@/motion/tokens";
import { Button, CountBadge, EmptyState, isTypingTarget, Kbd, Select, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@/ui";

import { ErrorState, FilterRow, PageColumn, PageHeader, SectionLabel } from "../sessions/kit/Page";
import { useDecidedApprovals, usePendingApprovalList, type ApprovalRecord } from "./api";
import { ApprovalCard } from "./ApprovalCard";
import { filterApprovals, hasFilters, kindsIn, NO_FILTERS, sortPending, splitProduction, type ApprovalFilters } from "./filters";
import { approvalStrings as s } from "./strings";

const ALL = "__all";
const SEVERITIES: Severity[] = ["critical", "high", "normal", "info"];
const DECIDED_PAGE = 60;

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy>
      <span className="sr-only">{s.title}</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
          <div className="flex gap-3">
            <Skeleton width={32} height={32} className="rounded-lg" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton height={9} width={120} />
              <Skeleton height={12} width={`${70 - i * 10}%`} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Skeleton width={64} height={28} />
            <Skeleton width={72} height={28} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Filters({ value, onChange, list }: { value: ApprovalFilters; onChange: (f: ApprovalFilters) => void; list: ApprovalRecord[] }) {
  const workspaces = useWorkspaces();
  const kinds = useMemo(() => {
    const present = new Set(kindsIn(list));
    if (value.kind) present.add(value.kind);
    return (Object.keys(s.kinds) as ApprovalKind[]).filter((k) => present.has(k));
  }, [list, value.kind]);
  return (
    <FilterRow>
      <ListFilter className="mr-0.5 size-4 text-fg-faint" aria-hidden />
      <Select
        aria-label={s.filters.kind}
        value={value.kind ?? ALL}
        onValueChange={(v) => onChange({ ...value, kind: v === ALL ? null : (v as ApprovalKind) })}
        options={[{ value: ALL, label: s.filters.allKinds }, ...kinds.map((k) => ({ value: k, label: s.kinds[k] }))]}
        className="w-44"
      />
      {(workspaces.data?.length ?? 0) > 1 && (
        <Select
          aria-label={s.filters.workspace}
          value={value.workspaceId ?? ALL}
          onValueChange={(v) => onChange({ ...value, workspaceId: v === ALL ? null : v })}
          options={[{ value: ALL, label: s.filters.allWorkspaces }, ...(workspaces.data ?? []).map((w) => ({ value: w.id, label: w.name }))]}
          className="w-48"
        />
      )}
      <Select
        aria-label={s.filters.severity}
        value={value.severity ?? ALL}
        onValueChange={(v) => onChange({ ...value, severity: v === ALL ? null : (v as Severity) })}
        options={[{ value: ALL, label: s.filters.allSeverities }, ...SEVERITIES.map((x) => ({ value: x, label: s.severity[x] }))]}
        className="w-44"
      />
      <AnimatePresence initial={false}>
        {hasFilters(value) && (
          <motion.span key="clear" {...variants.fade}>
            <Button size="sm" variant="ghost" onClick={() => onChange(NO_FILTERS)}>
              {s.empty.clear}
            </Button>
          </motion.span>
        )}
      </AnimatePresence>
    </FilterRow>
  );
}

function CardList({
  items,
  selectedId,
  onSelect,
  onDecided,
}: {
  items: ApprovalRecord[];
  selectedId: string | null;
  onSelect?: (id: string) => void;
  onDecided?: (a: Approval) => void;
}) {
  return (
    <ul className="flex flex-col gap-3">
      <AnimatePresence initial={false} mode="popLayout">
        {items.map((a) => (
          <motion.li
            key={a.id}
            layout
            variants={variants.dismissRight}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={spring.layout}
            data-approval-id={a.id}
            className="list-none"
            onFocusCapture={() => onSelect?.(a.id)}
            onPointerDown={() => onSelect?.(a.id)}
          >
            <ApprovalCard approval={a} selected={selectedId === a.id} announce={false} onDecided={onDecided} />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

function Pending({ filters }: { filters: ApprovalFilters }) {
  const navigate = useNavigate();
  const pending = usePendingApprovalList();
  const sorted = useMemo(() => sortPending(filterApprovals(pending.data ?? [], filters)), [filters, pending.data]);
  const { production, other } = useMemo(() => splitProduction(sorted), [sorted]);
  const flat = useMemo(() => [...production, ...other], [other, production]);
  // The index survives a decided card leaving: the next one takes its place.
  const [sel, setSel] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const [announcement, setAnnouncement] = useState("");
  const flatRef = useRef(flat);
  useEffect(() => {
    flatRef.current = flat;
  });
  const current = flat.some((a) => a.id === sel.id) ? sel.id : (flat[Math.min(sel.index, flat.length - 1)]?.id ?? null);
  const setSelected = useCallback((id: string | null) => {
    setSel({
      id,
      index: Math.max(
        0,
        flatRef.current.findIndex((a) => a.id === id),
      ),
    });
  }, []);

  const move = useCallback(
    (delta: number) => {
      const list = flatRef.current;
      if (!list.length) return;
      const i = Math.max(
        0,
        list.findIndex((a) => a.id === current),
      );
      const next = list[Math.min(list.length - 1, Math.max(0, i + delta))];
      if (!next) return;
      setSelected(next.id);
      document.querySelector(`[data-approval-id="${next.id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    [current, setSelected],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const k = e.key.toLocaleLowerCase("tr-TR");
      if (k === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (k === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter" && current && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
        e.preventDefault();
        void navigate(`/approvals/${current}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, move, navigate]);

  const onDecided = useCallback((a: Approval) => {
    setAnnouncement(`${a.status === "rejected" ? s.actions.rejected : s.actions.approved}: ${a.title}`);
  }, []);

  if (pending.isLoading) return <ListSkeleton />;
  if (pending.isError) return <ErrorState title={s.loadError} error={pending.error} onRetry={() => void pending.refetch()} />;
  const total = pending.data?.length ?? 0;
  return (
    <>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      {flat.length === 0 ? (
        total === 0 ? (
          <EmptyState icon={<CheckCheck />} title={s.empty.pending} description={s.empty.pendingHint} />
        ) : (
          <EmptyState icon={<SearchX />} title={s.empty.filtered} />
        )
      ) : (
        <LayoutGroup id="approvals-pending">
          <div className="flex flex-col gap-7">
            {production.length > 0 && (
              <motion.section layout transition={spring.layout} className="flex flex-col gap-3" aria-label={s.sections.production}>
                <SectionLabel count={production.length} className="text-env-production">
                  {s.sections.production}
                </SectionLabel>
                <CardList items={production} selectedId={current} onSelect={setSelected} onDecided={onDecided} />
              </motion.section>
            )}
            {other.length > 0 && (
              <motion.section
                layout
                transition={spring.layout}
                className="flex flex-col gap-3"
                aria-label={production.length ? s.sections.other : s.tabs.pending}
              >
                {production.length > 0 && <SectionLabel count={other.length}>{s.sections.other}</SectionLabel>}
                <CardList items={other} selectedId={current} onSelect={setSelected} onDecided={onDecided} />
              </motion.section>
            )}
          </div>
        </LayoutGroup>
      )}
      <div className="mt-8 flex items-center justify-center gap-4 text-2xs text-fg-faint" aria-label={s.keyboard.hint}>
        <span className="flex items-center gap-1.5">
          <Kbd keys={["J"]} />
          <Kbd keys={["K"]} /> {s.keyboard.move}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd keys={["A"]} /> {s.keyboard.approve}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd keys={["R"]} /> {s.keyboard.reject}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd shortcut="↵" /> {s.keyboard.open}
        </span>
      </div>
    </>
  );
}

function Decided({ filters }: { filters: ApprovalFilters }) {
  const decided = useDecidedApprovals();
  const [limit, setLimit] = useState(DECIDED_PAGE);
  const items = useMemo(() => filterApprovals(decided.data ?? [], filters), [decided.data, filters]);
  if (decided.isLoading) return <ListSkeleton />;
  if (decided.isError) return <ErrorState title={s.loadError} error={decided.error} onRetry={() => void decided.refetch()} />;
  if (items.length === 0) return <EmptyState icon={<Inbox />} title={(decided.data?.length ?? 0) === 0 ? s.empty.decided : s.empty.filtered} />;
  return (
    <div className="flex flex-col gap-4">
      <CardList items={items.slice(0, limit)} selectedId={null} />
      {items.length > limit && (
        <Button variant="ghost" className="self-center" onClick={() => setLimit((l) => l + DECIDED_PAGE)}>
          {s.more(items.length - limit)}
        </Button>
      )}
    </div>
  );
}

export function ApprovalsInbox({ tab }: { tab: "pending" | "decided" }) {
  const navigate = useNavigate();
  const pending = usePendingApprovalList();
  const [filters, setFilters] = useState<ApprovalFilters>(NO_FILTERS);
  const list = pending.data ?? [];
  const hasProduction = list.some((a) => a.production);
  return (
    <PageColumn size="narrow">
      <PageHeader title={s.title} description={s.description} />
      <Tabs value={tab} onValueChange={(v) => void navigate(v === "decided" ? "/approvals/decided" : "/approvals")}>
        <TabsList aria-label={s.title} className="mb-4">
          <TabsTrigger value="pending" trailing={<CountBadge count={list.length} tone={hasProduction ? "danger" : "accent"} aria-label={s.tabs.pending} />}>
            {s.tabs.pending}
          </TabsTrigger>
          <TabsTrigger value="decided">{s.tabs.decided}</TabsTrigger>
        </TabsList>
        <Filters value={filters} onChange={setFilters} list={list} />
        <div className="pt-5 pb-10">
          <TabsContent value="pending">
            <Pending filters={filters} />
          </TabsContent>
          <TabsContent value="decided">
            <Decided filters={filters} />
          </TabsContent>
        </div>
      </Tabs>
    </PageColumn>
  );
}
