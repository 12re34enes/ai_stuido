import * as RDialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { CornerDownLeft, Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

import { useCommandStore, type StudioCommand } from "@/lib/commands";
import { fuzzyScore } from "@/lib/fuzzy";
import { useShell } from "@/lib/shell";
import { spring, variants } from "@/motion/tokens";
import { Kbd } from "@/ui";

import { paletteSections } from "./palette";
import { shellStrings as s } from "./strings";

function PaletteBody({ onClose }: { onClose: () => void }) {
  const commands = useCommandStore((st) => st.commands);
  const recent = useCommandStore((st) => st.recent);
  const markRecent = useCommandStore((st) => st.markRecent);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const sections = useMemo(() => paletteSections(commands, recent, query), [commands, recent, query]);

  const run = (cmd: StudioCommand) => {
    markRecent(cmd.id);
    onClose();
    // Let the palette start closing before heavy work (navigation, dialogs) begins.
    requestAnimationFrame(() => void cmd.run());
  };

  return (
    <Command
      label={s.palette.label}
      value={selected}
      onValueChange={setSelected}
      loop
      filter={(_value, search, keywords) => fuzzyScore(search, keywords ?? [])}
      className="flex flex-col"
    >
      <div className="flex items-center gap-3 border-b border-line-subtle px-4">
        <Search className="size-4 shrink-0 text-fg-faint" aria-hidden />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={s.palette.placeholder}
          className="h-12 min-w-0 flex-1 bg-transparent text-base text-fg outline-none focus-visible:shadow-none placeholder:text-fg-faint"
        />
        <Kbd keys={["Esc"]} />
      </div>
      <Command.List className="max-h-[min(440px,58vh)] scroll-py-2 overflow-y-auto overscroll-contain px-2 pb-2 transition-[height] duration-150 ease-out [height:var(--cmdk-list-height)]">
        <Command.Empty className="py-12 text-center text-sm text-fg-muted">{s.palette.empty}</Command.Empty>
        {sections.map(({ group, entries }) => (
          <Command.Group
            key={group}
            heading={group}
            className="pt-2 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-1 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-faint [&_[cmdk-group-heading]]:uppercase"
          >
            {entries.map(({ value, cmd }) => {
              const Icon = cmd.icon;
              const active = selected === value;
              return (
                <Command.Item
                  key={value}
                  value={value}
                  keywords={[cmd.title, cmd.subtitle ?? "", ...(cmd.keywords ?? []), group]}
                  onSelect={() => run(cmd)}
                  className="relative flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-sm text-fg outline-none select-none data-[disabled=true]:opacity-45"
                >
                  {active && (
                    <motion.span layoutId="palette-highlight" className="absolute inset-0 rounded-lg bg-surface-hover" transition={spring.snappy} />
                  )}
                  <span className="relative grid size-5 shrink-0 place-items-center text-fg-muted [&_svg]:size-4">
                    {Icon ? <Icon strokeWidth={1.75} /> : <CornerDownLeft />}
                  </span>
                  <span className="relative min-w-0 flex-1 truncate">
                    {cmd.title}
                    {cmd.subtitle && <span className="ml-2 text-xs text-fg-muted">{cmd.subtitle}</span>}
                  </span>
                  {cmd.shortcut && <Kbd shortcut={cmd.shortcut} className="relative" />}
                </Command.Item>
              );
            })}
          </Command.Group>
        ))}
      </Command.List>
      <footer className="flex h-9 items-center gap-4 border-t border-line-subtle px-4 text-2xs text-fg-faint">
        <span className="flex items-center gap-1.5">
          <Kbd keys={["↑", "↓"]} /> {s.palette.navigateHint}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd keys={["↵"]} /> {s.palette.runHint}
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd keys={["Esc"]} /> {s.palette.closeHint}
        </span>
      </footer>
    </Command>
  );
}

/** ⌘K command palette: navigation, registered actions and recent items, fuzzy and Turkish-aware. */
export function CommandPalette() {
  const open = useShell((st) => st.paletteOpen);
  const setOpen = useShell((st) => st.setPaletteOpen);
  return (
    <RDialog.Root open={open} onOpenChange={setOpen}>
      <AnimatePresence>
        {open && (
          <RDialog.Portal forceMount>
            <RDialog.Overlay forceMount asChild>
              <motion.div variants={variants.overlay} initial="initial" animate="animate" exit="exit" className="fixed inset-0 z-(--z-palette) bg-overlay" />
            </RDialog.Overlay>
            <div className="pointer-events-none fixed inset-0 z-(--z-palette) flex justify-center px-6 pt-[12vh]">
              <RDialog.Content forceMount asChild aria-describedby={undefined}>
                <motion.div
                  variants={variants.dialog}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  data-testid="command-palette"
                  className="pointer-events-auto h-fit w-full max-w-[640px] overflow-hidden rounded-xl border border-line bg-surface-raised text-fg shadow-3 outline-none"
                >
                  <RDialog.Title className="sr-only">{s.palette.label}</RDialog.Title>
                  <PaletteBody onClose={() => setOpen(false)} />
                </motion.div>
              </RDialog.Content>
            </div>
          </RDialog.Portal>
        )}
      </AnimatePresence>
    </RDialog.Root>
  );
}
