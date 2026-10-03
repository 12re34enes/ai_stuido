/**
 * Global quick palette window (#/palette, ⌃⌥Space while the app is in the background; spec §18):
 * Raycast-like search with instant results — new task (with mode), approvals, recent tasks and
 * pages. Results run in the main window (`showMainWindow(route)`), then the palette dismisses.
 * ↑/↓ move, ↵ runs, ⇥ cycles the task mode, Esc closes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CornerDownLeft, Inbox, ListPlus, Search, ShieldAlert, SquareCheckBig } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, useAnimate } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { features } from "@/app/routes";
import { api } from "@/lib/api";
import { usePendingApprovals } from "@/lib/queries";
import { useCurrentWorkspace } from "@/lib/workspace";
import { useReducedMotionPref } from "@/motion/hooks";
import { spring, transition, variants } from "@/motion/tokens";
import { hideCurrentWindow, isTauri, onWindowShown, resizeCurrentWindow, showMainWindow, windowKind } from "@/native";
import { cn, errorMessage, Kbd, Spinner } from "@/ui";


import { featurePath } from "../route";
import { shellStrings } from "../strings";
import { useAppearanceSync } from "../useAppearanceSync";
import { buildPaletteSections, flatItems, moveSelection, nextMode, taskTitle, TASK_MODES, type PaletteItem, type TaskMode, type TaskSummary } from "./quickPalette";
import { windowStrings } from "./strings";
import { WindowSurface } from "./WindowSurface";

const p = windowStrings.palette;
const WIDTH = 640;

const pages = features
  .filter((f) => f.section !== "hidden" || f.id === "approvals")
  .map((f) => ({ id: f.id, label: f.label, path: featurePath(f), keywords: f.keywords }));
const pageIcon = Object.fromEntries(features.map((f) => [f.id, f.icon]));

function ItemIcon({ item }: { item: PaletteItem }) {
  if (item.kind === "new-task") return <ListPlus />;
  if (item.kind === "approval") return item.production ? <ShieldAlert className="text-env-production" /> : <Inbox />;
  if (item.kind === "task") return <SquareCheckBig />;
  const Icon = pageIcon[item.pageId] ?? ArrowRight;
  return <Icon />;
}

export default function QuickPaletteWindow() {
  useAppearanceSync();
  const qc = useQueryClient();
  const reduced = useReducedMotionPref();
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scope, animate] = useAnimate<HTMLDivElement>();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<TaskMode>("duo");
  const [selected, setSelected] = useState<string | null>("new-task");
  const { workspace } = useCurrentWorkspace();
  const approvalsData = usePendingApprovals().data;
  const tasks = useQuery({
    queryKey: ["palette", "tasks", workspace?.id ?? ""],
    queryFn: () => api.get<TaskSummary[]>("/engine/tasks", { workspace_id: workspace?.id, limit: 8 }),
    retry: false,
    staleTime: 15_000,
  });
  const create = useMutation({
    mutationFn: (prompt: string) =>
      api.post<{ id: string; task?: { id: string } }>("/engine/tasks", { workspace_id: workspace?.id, title: taskTitle(prompt), prompt, mode, start: true }),
  });

  const { reset: resetCreate } = create;
  const sections = useMemo(
    () => buildPaletteSections({ query, approvals: approvalsData ?? [], tasks: tasks.data ?? [], pages, kindLabel: (a) => shellStrings.approvals.kinds[a.kind] ?? a.kind }),
    [approvalsData, query, tasks.data],
  );
  const items = flatItems(sections);
  const active = items.some((i) => i.id === selected) ? selected : (items[0]?.id ?? null);

  const dismiss = () => void hideCurrentWindow();
  const go = async (route?: string) => {
    await showMainWindow(route);
    dismiss();
  };

  const run = (item: PaletteItem) => {
    if (item.kind !== "new-task") return void go(item.route);
    if (!item.prompt) return void go("/?new=1");
    if (!workspace) return;
    create.mutate(item.prompt, {
      onSuccess: (t) => {
        setQuery("");
        void go(`/tasks/${encodeURIComponent(t.task?.id ?? t.id)}`);
      },
    });
  };

  // Native window-shown: reset, refresh, focus and replay the opening spring.
  useEffect(
    () =>
      onWindowShown(() => {
        setQuery("");
        setSelected("new-task");
        resetCreate();
        void qc.invalidateQueries();
        inputRef.current?.focus();
        if (scope.current && !reduced) void animate(scope.current, { opacity: [0, 1], scale: [0.97, 1], y: [-6, 0] }, { ...spring.smooth, opacity: transition.micro });
      }),
    [animate, qc, reduced, resetCreate, scope],
  );

  // Grow / shrink the native window with the results.
  useLayoutEffect(() => {
    if (!isTauri() || windowKind() !== "palette" || !bodyRef.current) return;
    const el = bodyRef.current;
    const ro = new ResizeObserver(() => void resizeCurrentWindow(WIDTH, Math.ceil(el.getBoundingClientRect().height)).catch(() => undefined));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else dismiss();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(moveSelection(items, active, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Tab") {
      e.preventDefault();
      setMode((m) => nextMode(m, e.shiftKey ? -1 : 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items.find((i) => i.id === active);
      if (item) run(item);
    }
  };

  return (
    <WindowSurface className="rounded-xl">
      <motion.div ref={scope} initial={reduced ? false : { opacity: 0, scale: 0.97, y: -6 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={spring.smooth} className="flex h-full flex-col">
        <div ref={bodyRef} className="flex flex-col" onKeyDown={onKeyDown}>
          <div data-tauri-drag-region className="flex items-center gap-3 border-b border-line-subtle pr-3 pl-4">
            <Search className="size-[18px] shrink-0 text-fg-faint" aria-hidden />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(null);
                if (create.isError) resetCreate();
              }}
              placeholder={p.placeholder}
              aria-label={p.label}
              aria-controls="quick-palette-results"
              aria-activedescendant={active ? `qp-${active}` : undefined}
              spellCheck={false}
              className="h-14 min-w-0 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-faint focus-visible:shadow-none"
            />
            <ModePill mode={mode} onChange={setMode} />
          </div>

          <div id="quick-palette-results" role="listbox" aria-label={p.label} className="max-h-[360px] overflow-y-auto overscroll-contain p-2">
            <LayoutGroup id="quick-palette">
              {items.length === 0 ? (
                <p className="py-10 text-center text-sm text-fg-muted">{p.empty}</p>
              ) : (
                sections.map((sec) => (
                  <div key={sec.group} role="group" aria-label={p.groups[sec.group]} className="pb-1">
                    <div className="px-2.5 pt-1.5 pb-1 text-2xs font-medium tracking-wide text-fg-faint uppercase">{p.groups[sec.group]}</div>
                    {sec.items.map((item) => (
                      <Row key={item.id} item={item} active={item.id === active} mode={mode} busy={create.isPending && item.kind === "new-task"} onHover={() => setSelected(item.id)} onRun={() => run(item)} />
                    ))}
                  </div>
                ))
              )}
            </LayoutGroup>
            <AnimatePresence initial={false}>
              {(create.isError || (query && !workspace)) && (
                <motion.p key="err" {...variants.fadeUp} role="alert" className="mx-2.5 mt-1 rounded-md bg-danger-soft px-2.5 py-1.5 text-xs text-danger">
                  {!workspace ? p.noWorkspace : `${p.createFailed}: ${errorMessage(create.error)}`}
                </motion.p>
              )}
            </AnimatePresence>
          </div>

          <footer className="flex h-9 shrink-0 items-center gap-4 border-t border-line-subtle px-4 text-2xs text-fg-faint">
            <span className="flex items-center gap-1.5">
              <Kbd keys={["↑", "↓"]} /> {p.hints.navigate}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd keys={["↵"]} /> {p.hints.run}
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd keys={["⇥"]} /> {p.hints.mode}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <Kbd keys={["Esc"]} /> {p.hints.close}
            </span>
          </footer>
        </div>
      </motion.div>
    </WindowSurface>
  );
}

function ModePill({ mode, onChange }: { mode: TaskMode; onChange: (m: TaskMode) => void }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      title={p.modeHints[mode]}
      onClick={() => onChange(nextMode(mode))}
      aria-label={`${p.mode}: ${p.modes[mode]}`}
      className="relative flex h-7 shrink-0 items-center gap-1.5 overflow-hidden rounded-full border border-line bg-surface pr-2.5 pl-2 text-xs text-fg-muted outline-none transition-colors hover:border-line-strong hover:text-fg"
    >
      <span className="flex gap-[3px]" aria-hidden>
        {TASK_MODES.map((m) => (
          <motion.span key={m} className="size-1 rounded-full bg-current" animate={{ opacity: m === mode ? 1 : 0.25, scale: m === mode ? 1.25 : 1 }} transition={spring.snappy} />
        ))}
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={mode} initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -8, opacity: 0 }} transition={spring.snappy} className="font-medium text-fg">
          {p.modes[mode]}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}

function Row({ item, active, mode, busy, onHover, onRun }: { item: PaletteItem; active: boolean; mode: TaskMode; busy: boolean; onHover: () => void; onRun: () => void }) {
  return (
    <div
      id={`qp-${item.id}`}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onClick={onRun}
      className="relative flex h-10 cursor-default items-center gap-3 rounded-lg px-2.5 text-sm text-fg select-none"
    >
      {active && <motion.span layoutId="qp-highlight" className="absolute inset-0 rounded-lg bg-surface-hover" transition={spring.snappy} />}
      <span className={cn("relative grid size-6 shrink-0 place-items-center rounded-md text-fg-muted [&_svg]:size-4", item.kind === "new-task" && "bg-accent text-fg-on-accent")}>
        {busy ? <Spinner size={14} label="" /> : <ItemIcon item={item} />}
      </span>
      <span className="relative min-w-0 flex-1 truncate">
        {item.title}
        {item.kind === "new-task" && <span className="ml-2 text-xs text-fg-muted">{busy ? p.creating : `${p.modes[mode]} · ${p.modeHints[mode]}`}</span>}
        {(item.kind === "approval" || item.kind === "task") && <span className="ml-2 text-xs text-fg-muted">{item.subtitle}</span>}
      </span>
      {item.kind === "approval" && item.production && (
        <span className="relative rounded-full bg-env-production px-1.5 py-px text-[10px] font-semibold text-fg-on-accent">{p.production}</span>
      )}
      {active && (
        <motion.span initial={{ opacity: 0, x: -4 }} animate={{ opacity: 1, x: 0 }} className="relative flex text-fg-faint">
          <CornerDownLeft className="size-3.5" aria-hidden />
        </motion.span>
      )}
    </div>
  );
}
