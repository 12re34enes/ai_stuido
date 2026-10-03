import { commandGroups, type StudioCommand } from "@/lib/commands";

const GROUP_ORDER: string[] = [
  commandGroups.recent,
  commandGroups.navigation,
  commandGroups.actions,
  commandGroups.workspace,
  commandGroups.view,
  commandGroups.developer,
];

export interface PaletteEntry {
  /** cmdk item value (unique: recent items are prefixed). */
  value: string;
  cmd: StudioCommand;
}

/** Group visible commands in palette order; with an empty query, recent commands come first. */
export function paletteSections(commands: StudioCommand[], recent: string[], query: string): { group: string; entries: PaletteEntry[] }[] {
  const visible = commands.filter((c) => c.visible !== false);
  const groups = new Map<string, PaletteEntry[]>();
  if (!query.trim()) {
    const recentEntries = recent
      .map((id) => visible.find((c) => c.id === id))
      .filter((c): c is StudioCommand => Boolean(c))
      .map((cmd) => ({ value: `recent:${cmd.id}`, cmd }));
    if (recentEntries.length) groups.set(commandGroups.recent, recentEntries);
  }
  for (const cmd of [...visible].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))) {
    const g = cmd.group ?? commandGroups.actions;
    groups.set(g, [...(groups.get(g) ?? []), { value: cmd.id, cmd }]);
  }
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...groups.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([group, entries]) => ({ group, entries }));
}
