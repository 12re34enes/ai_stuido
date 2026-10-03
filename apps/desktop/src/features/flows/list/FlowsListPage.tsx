/** /flows — saved flows (mini previews, version, last update), mode templates and "Yeni akış". */
import { CalendarClock, CircleAlert, Copy, Ellipsis, ExternalLink, Plus, Search, Trash2, Workflow } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { foldTurkish } from "@/lib/fuzzy";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, stagger, transition } from "@/motion/tokens";
import { Badge, Button, ConfirmDialog, EmptyState, IconButton, Input, Menu, MenuItem, MenuSeparator, Skeleton, toast } from "@/ui";

import { useCreateFlow, useDeleteFlow, useFlows, useModes } from "../api";
import { MiniGraph } from "../components/MiniGraph";
import { BlankCard, ModeCard, type TemplatePick } from "../components/TemplateCards";
import { s } from "../strings";
import { errorText } from "../util";
import type { SavedFlow } from "../types";

function FlowCard({ flow, index, now, onDuplicate, onDelete }: { flow: SavedFlow; index: number; now: number; onDuplicate: (f: SavedFlow) => void; onDelete: (f: SavedFlow) => void }) {
  const navigate = useNavigate();
  const open = () => void navigate(`/flows/${encodeURIComponent(flow.id)}`);
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { ...spring.smooth, delay: Math.min(index, 8) * 0.04 } }}
      exit={{ opacity: 0, scale: 0.96, transition: transition.exit }}
      transition={spring.layout}
      whileHover={{ y: -2 }}
      className="group/card relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-1 transition-[box-shadow,border-color] duration-200 hover:border-line-strong hover:shadow-2"
      data-testid={`flow-card-${flow.id}`}
    >
      <button type="button" onClick={open} aria-label={`${flow.name} — ${s.open}`} className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:shadow-[var(--focus-ring)]" />
      <div className="pointer-events-none relative h-[124px] border-b border-line-subtle bg-canvas-subtle px-4 py-3">
        <MiniGraph graph={flow.graph} delay={0.06 + index * 0.04} className="size-full" aria-label={`${flow.name} önizleme`} />
      </div>
      <div className="pointer-events-none relative flex flex-1 flex-col gap-1 px-4 pt-3 pb-3.5">
        <div className="flex items-center gap-2 pr-7">
          <h3 className="truncate text-md leading-6 text-fg">{flow.name}</h3>
          {flow.is_template && <Badge tone="accent">{s.template}</Badge>}
        </div>
        <p className="line-clamp-2 min-h-8 text-xs text-fg-muted">{flow.description || " "}</p>
        <div className="mt-1.5 flex items-center gap-2 text-2xs text-fg-muted">
          <Badge variant="outline">{s.version(flow.version)}</Badge>
          <span>{s.nodeCount(flow.graph.nodes.length)}</span>
          <span aria-hidden className="text-fg-faint">
            ·
          </span>
          <span className="truncate">{s.updated(relativeTime(flow.created_at, new Date(now)))}</span>
        </div>
      </div>
      <div className="absolute top-[132px] right-2.5 z-10 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
        <Menu align="end" trigger={<IconButton size="sm" label={s.more} icon={<Ellipsis />} />}>
          <MenuItem icon={<ExternalLink />} onSelect={open}>
            {s.open}
          </MenuItem>
          <MenuItem icon={<Copy />} onSelect={() => onDuplicate(flow)}>
            {s.duplicate}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => onDelete(flow)}>
            {s.delete}
          </MenuItem>
        </Menu>
      </div>
    </motion.article>
  );
}

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-1">
      <Skeleton className="h-[124px] rounded-none" />
      <div className="flex flex-col gap-2 px-4 py-3.5">
        <Skeleton height={14} width="60%" />
        <Skeleton height={10} width="85%" />
        <Skeleton height={10} width="40%" />
      </div>
    </div>
  );
}

export function FlowsListPage() {
  const navigate = useNavigate();
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const flows = useFlows(workspaceId);
  const modes = useModes();
  const create = useCreateFlow();
  const remove = useDeleteFlow();
  const now = useNow(60_000);
  const [query, setQuery] = useState("");
  const [toDelete, setToDelete] = useState<SavedFlow | null>(null);

  const list = useMemo(() => {
    const q = foldTurkish(query.trim());
    const sorted = [...(flows.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return q ? sorted.filter((f) => foldTurkish(`${f.name} ${f.description}`).includes(q)) : sorted;
  }, [flows.data, query]);
  const modeList = useMemo(() => (modes.data ?? []).filter((m) => m.mode !== "custom"), [modes.data]);

  const pick = (p: TemplatePick) => {
    if (p.type === "mode") void navigate(`/flows/new?mode=${p.mode}`);
    else if (p.type === "studio") void navigate(`/flows/new?studio=${encodeURIComponent(p.id)}`);
    else void navigate("/flows/new?blank=1");
  };

  const duplicate = async (f: SavedFlow) => {
    try {
      const copy = await create.mutateAsync({ workspace_id: f.workspace_id ?? workspaceId, name: `${f.name}${s.copySuffix}`, description: f.description, graph: f.graph, is_template: f.is_template });
      toast.success(s.duplicated, { description: copy.name, action: { label: s.open, onClick: () => void navigate(`/flows/${copy.id}`) } });
    } catch (e) {
      toast.error(s.editor.saveFailed, { description: e instanceof Error ? e.message : undefined });
    }
  };

  const confirmDelete = async () => {
    const f = toDelete;
    if (!f) return;
    setToDelete(null);
    try {
      await remove.mutateAsync(f.id);
      toast.success(s.deleted, { description: f.name });
    } catch (e) {
      toast.error(s.editor.saveFailed, { description: e instanceof Error ? e.message : undefined });
    }
  };

  const commands = useMemo<StudioCommand[]>(
    () => [
      { id: "flows.new", title: s.newFlow, group: commandGroups.actions, icon: Plus, order: 2, keywords: ["flow", "akış", "yeni", "canvas"], run: () => void navigate("/flows/new") },
      { id: "flows.schedules", title: s.schedulesLink, group: commandGroups.navigation, icon: CalendarClock, order: 30, keywords: ["schedule", "cron", "zamanla"], run: () => void navigate("/flows/schedules") },
      ...modeList.map((m, i) => ({
        id: `flows.new.${m.mode}`,
        title: `${s.newFlow}: ${m.label}`,
        subtitle: m.description,
        group: commandGroups.actions,
        icon: Workflow,
        order: 3 + i,
        keywords: ["flow", "mode", m.mode],
        run: () => void navigate(`/flows/new?mode=${m.mode}`),
      })),
    ],
    [modeList, navigate],
  );
  useRegisterCommands(commands);

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-10 px-8 pt-8 pb-16" data-testid="flows-list">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-xl flex-col gap-1.5">
          <h1 className="text-2xl text-fg">{s.pageTitle}</h1>
          <p className="text-sm text-fg-muted">{s.pageSubtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<CalendarClock />} onClick={() => void navigate("/flows/schedules")}>
            {s.schedulesLink}
          </Button>
          <Button variant="primary" icon={<Plus />} onClick={() => void navigate("/flows/new")} data-testid="new-flow">
            {s.newFlow}
          </Button>
        </div>
      </header>

      <section className="flex flex-col gap-4" aria-labelledby="saved-flows">
        <div className="flex items-center justify-between gap-4">
          <h2 id="saved-flows" className="text-lg text-fg">
            {s.savedFlows}
            {flows.data && flows.data.length > 0 && <span className="ml-2 font-sans text-sm text-fg-faint tabular">{flows.data.length}</span>}
          </h2>
          {(flows.data?.length ?? 0) > 3 && (
            <Input size="sm" icon={<Search />} placeholder={s.searchFlows} aria-label={s.searchFlows} value={query} onChange={(e) => setQuery(e.target.value)} wrapperClassName="w-64" />
          )}
        </div>
        {!workspaceId ? (
          <EmptyState icon={<Workflow />} title={s.noWorkspace} />
        ) : flows.isPending ? (
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        ) : flows.isError ? (
          <EmptyState
            icon={<CircleAlert />}
            title={s.loadError}
            description={errorText(flows.error)}
            action={
              <Button size="sm" onClick={() => void flows.refetch()}>
                {s.retry}
              </Button>
            }
          />
        ) : flows.data.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong">
            <EmptyState
              icon={<Workflow />}
              title={s.emptyFlowsTitle}
              description={s.emptyFlowsBody}
              action={
                <Button size="sm" variant="primary" icon={<Plus />} onClick={() => void navigate("/flows/new")}>
                  {s.newFlow}
                </Button>
              }
            />
          </div>
        ) : list.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted">{s.noMatches}</p>
        ) : (
          <motion.div className="grid grid-cols-3 gap-4" data-testid="flow-grid">
            <AnimatePresence mode="popLayout">
              {list.map((f, i) => (
                <FlowCard key={f.id} flow={f} index={i} now={now} onDuplicate={(x) => void duplicate(x)} onDelete={setToDelete} />
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="mode-templates">
        <div className="flex flex-col gap-1">
          <h2 id="mode-templates" className="text-lg text-fg">
            {s.modeTemplates}
          </h2>
          <p className="text-sm text-fg-muted">{s.modeTemplatesHint}</p>
        </div>
        {modes.isPending ? (
          <div className="grid grid-cols-3 gap-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={172} className="rounded-xl" />
            ))}
          </div>
        ) : modes.isError ? (
          <EmptyState size="sm" icon={<CircleAlert />} title={s.modesError} description={errorText(modes.error)} />
        ) : (
          <motion.div className="grid grid-cols-3 gap-4" initial="initial" animate="animate" variants={stagger(0.04, 0.08)} data-testid="mode-grid">
            {modeList.map((m, i) => (
              <ModeCard key={m.mode} info={m} index={i} workspaceId={workspaceId} onPick={pick} />
            ))}
            <BlankCard onPick={pick} />
          </motion.div>
        )}
      </section>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={toDelete ? s.deleteTitle(toDelete.name) : ""}
        description={s.deleteBody}
        confirmLabel={s.delete}
        tone="danger"
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
