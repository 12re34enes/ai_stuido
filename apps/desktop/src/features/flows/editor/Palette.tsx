/**
 * Left node palette: kinds grouped with Turkish names, icons and one-line descriptions. Drag onto
 * the canvas, double-click or press Enter to add at the center. Collapses to an icon rail.
 */
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useMemo, useState, type DragEvent } from "react";

import { readPref, writePref } from "@/lib/storage";
import { foldTurkish } from "@/lib/fuzzy";
import { spring, transition } from "@/motion/tokens";
import { cn, IconButton, Input, ScrollArea, Tooltip } from "@/ui";

import { kindInfo, PALETTE_GROUPS, type KindInfo } from "../model/kinds";
import { s } from "../strings";
import { NODE_DRAG_TYPE } from "./Canvas";
import { useEditor } from "./store";
import { useEditorActions } from "./useEditorActions";

function startDrag(e: DragEvent, info: KindInfo) {
  e.dataTransfer.setData(NODE_DRAG_TYPE, info.kind);
  e.dataTransfer.setData("text/plain", info.label);
  e.dataTransfer.effectAllowed = "copy";
}

function PaletteItem({ info, disabled }: { info: KindInfo; disabled: boolean }) {
  const actions = useEditorActions();
  const Icon = info.icon;
  return (
    <motion.li layout="position" transition={spring.layout} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: transition.exit }}>
      <button
        type="button"
        draggable={!disabled}
        disabled={disabled}
        onDragStart={(e) => startDrag(e, info)}
        onDoubleClick={() => actions.addNodeAtCenter(info.kind)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            actions.addNodeAtCenter(info.kind);
          }
        }}
        data-testid={`palette-${info.kind}`}
        aria-label={`${info.label}: ${info.description}`}
        className={cn(
          "group/item flex w-full cursor-grab items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none active:cursor-grabbing",
          "transition-[background-color,box-shadow] duration-150 hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-45",
        )}
      >
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md border border-line-subtle bg-surface-sunken text-fg-muted transition-[color,background-color,transform] duration-150",
            "group-hover/item:scale-105 group-hover/item:text-fg [&_svg]:size-3.5",
            info.kind === "gate" && "bg-accent-soft text-accent group-hover/item:text-accent",
          )}
        >
          <Icon aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm leading-[18px] text-fg">{info.label}</span>
          <span className="truncate text-2xs text-fg-muted">{info.description}</span>
        </span>
      </button>
    </motion.li>
  );
}

export function Palette() {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(() => readPref("flows.paletteCollapsed", false));
  const readOnly = useEditor((st) => st.preview !== null);
  const actions = useEditorActions();

  const groups = useMemo(() => {
    const q = foldTurkish(query.trim());
    return PALETTE_GROUPS.map((g) => ({
      id: g.id,
      items: g.kinds.map(kindInfo).filter((k) => !q || foldTurkish(`${k.label} ${k.description}`).includes(q)),
    })).filter((g) => g.items.length);
  }, [query]);

  const toggle = (next: boolean) => {
    setCollapsed(next);
    writePref("flows.paletteCollapsed", next);
  };

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {collapsed ? (
        <motion.nav
          key="rail"
          aria-label={s.palette.title}
          className="pointer-events-auto flex flex-col items-center gap-0.5 rounded-xl border border-line bg-surface/92 p-1 shadow-2 backdrop-blur-md"
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0, transition: spring.smooth }}
          exit={{ opacity: 0, x: -12, transition: transition.exit }}
        >
          <IconButton size="md" label={s.palette.expand} icon={<PanelLeftOpen />} tooltipSide="right" onClick={() => toggle(false)} />
          <span className="my-0.5 h-px w-5 bg-line" aria-hidden />
          {PALETTE_GROUPS.flatMap((g) => g.kinds).map((kind) => {
            const info = kindInfo(kind);
            const Icon = info.icon;
            return (
              <Tooltip key={kind} content={`${info.label} · ${info.description}`} side="right">
                <button
                  type="button"
                  draggable={!readOnly}
                  disabled={readOnly}
                  onDragStart={(e) => startDrag(e, info)}
                  onDoubleClick={() => actions.addNodeAtCenter(kind)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") actions.addNodeAtCenter(kind);
                  }}
                  aria-label={info.label}
                  className="grid size-7 cursor-grab place-items-center rounded-md text-fg-muted outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)] disabled:opacity-45 [&_svg]:size-4"
                >
                  <Icon aria-hidden />
                </button>
              </Tooltip>
            );
          })}
        </motion.nav>
      ) : (
        <motion.nav
          key="panel"
          aria-label={s.palette.title}
          data-testid="flow-palette"
          className="pointer-events-auto flex max-h-full w-[232px] flex-col overflow-hidden rounded-xl border border-line bg-surface/92 shadow-2 backdrop-blur-md"
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0, transition: spring.smooth }}
          exit={{ opacity: 0, x: -16, transition: transition.exit }}
        >
          <div className="flex items-center justify-between gap-2 pt-2.5 pr-1.5 pl-3">
            <div className="flex min-w-0 flex-col">
              <h2 className="font-sans text-sm font-medium tracking-normal text-fg">{s.palette.title}</h2>
              <p className="truncate text-2xs text-fg-muted">{s.palette.hint}</p>
            </div>
            <IconButton size="sm" label={s.palette.collapse} icon={<PanelLeftClose />} tooltipSide="right" onClick={() => toggle(true)} />
          </div>
          <div className="px-2 pt-2 pb-1">
            <Input size="sm" icon={<Search />} placeholder={s.palette.search} aria-label={s.palette.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <ScrollArea className="min-h-0 flex-1" viewportClassName="px-1.5 pb-2">
            <LayoutGroup>
              <AnimatePresence initial={false}>
                {groups.map((g) => (
                  <motion.section key={g.id} layout="position" transition={spring.layout} className="pt-2" aria-label={s.palette.groups[g.id]}>
                    <h3 className="px-2 pb-1 font-sans text-2xs font-medium tracking-wide text-fg-faint uppercase">{s.palette.groups[g.id]}</h3>
                    <ul className="flex flex-col">
                      <AnimatePresence initial={false}>
                        {g.items.map((info) => (
                          <PaletteItem key={info.kind} info={info} disabled={readOnly} />
                        ))}
                      </AnimatePresence>
                    </ul>
                  </motion.section>
                ))}
              </AnimatePresence>
            </LayoutGroup>
          </ScrollArea>
        </motion.nav>
      )}
    </AnimatePresence>
  );
}
