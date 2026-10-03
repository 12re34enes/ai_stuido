/**
 * Palette commands for tasks, registered when the feature chunk loads (the shell prefetches every
 * feature chunk at startup), so they work from any page:
 *   - "Yeni görev: Tek / İkili / Yarış / Hat / Kurul" — opens the composer in that mode
 *   - "Görev kuyruğu", "Zamanlanmış görevler"
 *   - the five most recent tasks of the current workspace (kept in sync with the task caches)
 * ("Yeni görev" ⌘N and "Görevler" ⌘2 come from the shell.)
 */
import { CalendarClock, ListChecks, ListOrdered, UsersRound } from "lucide-react";

import { commandGroups, registerCommands, type StudioCommand } from "@/lib/commands";
import { queryClient } from "@/lib/queryClient";
import { useShell } from "@/lib/shell";
import { useWorkspaceStore } from "@/lib/workspace";

import { taskKeys } from "../list/queries";
import { modeLabel, statusLabel } from "../list/status";
import { taskStrings } from "../list/strings";
import { MODES, type BuiltinMode, type Task } from "../list/types";
import { s as teamStrings } from "../../teams/strings";
import { useComposer, type ComposerMode } from "./composerStore";
import { modeIcons } from "./icons";
import { createStrings as s } from "./strings";

/** Hash-router navigation usable outside React. */
export function goTo(path: string): void {
  if (typeof window !== "undefined") window.location.hash = `#${path}`;
}

/** Open the home composer (optionally in a mode) and focus it. */
export function openComposer(mode?: ComposerMode): void {
  if (mode) useComposer.getState().setMode(mode);
  goTo("/");
  useShell.getState().requestComposerFocus();
}

const MODE_KEYWORDS: Record<BuiltinMode, string[]> = {
  single: ["tek", "single", "tek ajan"],
  duo: ["ikili", "duo", "inceleme", "review"],
  race: ["yarış", "race", "paralel"],
  pipeline: ["hat", "pipeline", "planlayıcı"],
  council: ["kurul", "council", "danışma", "karar"],
};

function staticCommands(): StudioCommand[] {
  const modes = MODES.map(
    (mode, i): StudioCommand => ({
      id: `task.new.${mode}`,
      title: s.commands.newWithMode(s.mode.labels[mode]),
      group: commandGroups.actions,
      icon: modeIcons[mode],
      keywords: ["yeni görev", "new task", ...MODE_KEYWORDS[mode]],
      order: 1 + i,
      run: () => openComposer(mode),
    }),
  );
  return [
    ...modes,
    {
      id: "task.new.team",
      title: s.commands.newWithMode(teamStrings.composer.mode),
      group: commandGroups.actions,
      icon: UsersRound,
      keywords: ["yeni görev", "new task", "ekip", "team", "lider", "danışman"],
      order: 1 + modes.length,
      run: () => openComposer("team"),
    },
    {
      id: "tasks.queue",
      title: taskStrings.commands.queue,
      group: commandGroups.navigation,
      icon: ListOrdered,
      keywords: ["queue", "kuyruk", "bekleyen", "sıra"],
      order: 20,
      run: () => goTo("/tasks?view=queue"),
    },
    {
      id: "tasks.schedules",
      title: taskStrings.commands.schedules,
      group: commandGroups.navigation,
      icon: CalendarClock,
      keywords: ["schedule", "zamanlama", "cron"],
      order: 21,
      run: () => goTo("/flows/schedules"),
    },
  ];
}

// ----------------------------------------------------------------------------- recent tasks

type ListData = Task[] | { pages: Task[][] } | undefined;

/** The newest tasks of a workspace across every cached task list. */
export function recentFromCache(lists: ListData[], workspaceId: string | null, limit = 5): Task[] {
  const byId = new Map<string, Task>();
  for (const data of lists) {
    const list = Array.isArray(data) ? data : (data?.pages.flat() ?? []);
    for (const t of list) if (!workspaceId || t.workspace_id === workspaceId) byId.set(t.id, t);
  }
  return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

let recentOff: (() => void) | null = null;
let recentSig = "";
let pending: ReturnType<typeof setTimeout> | null = null;

function syncRecent(): void {
  pending = null;
  const lists = queryClient.getQueriesData<ListData>({ queryKey: taskKeys.all }).map(([, d]) => d);
  const recent = recentFromCache(lists, useWorkspaceStore.getState().currentId);
  const sig = recent.map((t) => `${t.id}:${t.status}:${t.title}`).join("|");
  if (sig === recentSig) return;
  recentSig = sig;
  recentOff?.();
  recentOff = registerCommands(
    recent.map(
      (t, i): StudioCommand => ({
        id: `task.open.${t.id}`,
        title: taskStrings.commands.openTask(t.title),
        subtitle: `${statusLabel(t.status)} · ${modeLabel(t.mode)}`,
        group: taskStrings.commands.recentGroup,
        icon: ListChecks,
        keywords: ["görev", "task", t.title],
        order: i,
        run: () => goTo(`/tasks/${encodeURIComponent(t.id)}`),
      }),
    ),
  );
}

function scheduleSync(): void {
  if (pending === null) pending = setTimeout(syncRecent, 120);
}

let installed = false;

/** Idempotent: registers the commands once per app session. */
export function installTaskCommands(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  registerCommands(staticCommands());
  queryClient.getQueryCache().subscribe((e) => {
    const key = e.query.queryKey;
    if (key[0] === "engine" && key[1] === "tasks") scheduleSync();
  });
  useWorkspaceStore.subscribe(scheduleSync);
  scheduleSync();
}
