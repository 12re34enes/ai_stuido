/**
 * Command registry for the ⌘K palette and global keyboard shortcuts.
 *
 * Features register actions while mounted:
 *
 *   useRegisterCommands(useMemo(() => [
 *     { id: "tasks.new", title: "Yeni görev", group: commandGroups.actions, shortcut: "⌘N", global: true, run: openNewTask },
 *   ], [openNewTask]));
 *
 * or imperatively: `const off = registerCommand({...}); off();`
 */
import type { LucideIcon } from "lucide-react";
import { useEffect } from "react";
import { create } from "zustand";

import { readPref, writePref } from "./storage";

export const commandGroups = {
  recent: "Son kullanılanlar",
  navigation: "Gezinme",
  actions: "Eylemler",
  workspace: "Çalışma alanı",
  view: "Görünüm",
  developer: "Geliştirici",
} as const;

export interface StudioCommand {
  id: string;
  /** Turkish label shown in the palette. */
  title: string;
  subtitle?: string;
  /** Palette section; defaults to "Eylemler". Use `commandGroups`. */
  group?: string;
  icon?: LucideIcon;
  /** Display + binding, e.g. "⌘N", "⌘⇧K", "⌘,". */
  shortcut?: string;
  /** When true, `shortcut` triggers the command anywhere in the app (not only in the palette). */
  global?: boolean;
  /** Extra search terms (synonyms, English names). */
  keywords?: string[];
  /** Hidden from the palette when false (still bound if global). */
  visible?: boolean;
  /** Sort order inside the group (lower first). */
  order?: number;
  run: () => void | Promise<void>;
}

const MAX_RECENT = 5;

interface CommandState {
  commands: StudioCommand[];
  recent: string[];
  register: (cmds: StudioCommand[]) => () => void;
  markRecent: (id: string) => void;
}

export const useCommandStore = create<CommandState>()((set, get) => ({
  commands: [],
  recent: readPref<string[]>("palette.recent", []),
  register: (cmds) => {
    const ids = new Set(cmds.map((c) => c.id));
    set((s) => ({ commands: [...s.commands.filter((c) => !ids.has(c.id)), ...cmds] }));
    return () => {
      // Only remove the exact objects we added (a later registration may own the id now).
      const mine = new Set(cmds);
      set((s) => ({ commands: s.commands.filter((c) => !mine.has(c)) }));
    };
  },
  markRecent: (id) => {
    const recent = [id, ...get().recent.filter((r) => r !== id)].slice(0, MAX_RECENT);
    writePref("palette.recent", recent);
    set({ recent });
  },
}));

export function registerCommand(cmd: StudioCommand): () => void {
  return useCommandStore.getState().register([cmd]);
}

export function registerCommands(cmds: StudioCommand[]): () => void {
  return useCommandStore.getState().register(cmds);
}

/** Register commands for the lifetime of the component. Memoize the array (useMemo). */
export function useRegisterCommands(cmds: StudioCommand[]): void {
  useEffect(() => registerCommands(cmds), [cmds]);
}

export function useCommands(): StudioCommand[] {
  return useCommandStore((s) => s.commands);
}

/** Run a command by id (records it as recent). Returns false when not registered. */
export async function runCommand(id: string): Promise<boolean> {
  const cmd = useCommandStore.getState().commands.find((c) => c.id === id);
  if (!cmd) return false;
  useCommandStore.getState().markRecent(id);
  await cmd.run();
  return true;
}
