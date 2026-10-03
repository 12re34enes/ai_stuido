import { ChevronRight, History, Inbox, Plus, ScrollText, ShieldHalf, type LucideIcon } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { createElement, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";

import { readPref, writePref } from "@/lib/storage";
import { spring, stagger, transition, variants } from "@/motion/tokens";
import { cn, CountBadge, IconButton, ScrollArea, Skeleton } from "@/ui";

import { docHref, docPathFrom, layerIcons } from "../links";
import { memoryStrings as s } from "../strings";
import type { LayerGroup, TreeItem } from "../tree";

const dayFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short" });

function Row({
  to,
  active,
  icon,
  label,
  trailing,
  depth = 0,
  muted,
}: {
  to: string;
  active: boolean;
  icon?: LucideIcon;
  label: ReactNode;
  trailing?: ReactNode;
  depth?: number;
  muted?: boolean;
}) {
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-7 items-center gap-2 rounded-md pr-2 text-sm outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
        depth ? "pl-8" : "pl-2",
        active ? "text-fg" : muted ? "text-fg-faint hover:text-fg" : "text-fg-muted hover:text-fg",
      )}
    >
      {active && <motion.span layoutId="memory-nav-active" transition={spring.layout} className="absolute inset-0 rounded-md bg-surface shadow-1" />}
      {!active && <span className="absolute inset-0 rounded-md opacity-0 transition-opacity duration-150 group-hover:bg-surface-hover group-hover:opacity-100" />}
      {icon && <span className="relative flex text-fg-faint [&_svg]:size-4">{createElement(icon)}</span>}
      <span className="relative min-w-0 flex-1 truncate">{label}</span>
      {trailing && <span className="relative flex shrink-0 items-center">{trailing}</span>}
    </Link>
  );
}

function ItemLabel({ item }: { item: TreeItem }) {
  if (item.guide) return <span className="italic">{item.title}</span>;
  return <span>{item.title}</span>;
}

function GroupView({ group, activePath, onNewDecision }: { group: LayerGroup; activePath: string | null; onNewDecision?: () => void }) {
  const single = group.layer === "facts" || group.layer === "boundaries";
  const [open, setOpen] = useState(() => readPref<boolean>(`memory.tree.${group.layer}`, true));
  const toggle = () => {
    setOpen((o) => {
      writePref(`memory.tree.${group.layer}`, !o);
      return !o;
    });
  };
  const Icon = layerIcons[group.layer];
  const count = <span className="text-2xs text-fg-faint tabular">{group.count}</span>;

  if (single) {
    const item = group.items[0];
    return (
      <motion.li layout="position" transition={spring.layout} className="list-none">
        <Row
          to={item ? docHref(item.path) : docHref(`${group.layer}.md`)}
          active={!!item && activePath === item.path}
          icon={Icon}
          label={group.label}
          trailing={count}
        />
      </motion.li>
    );
  }

  return (
    <motion.li layout="position" transition={spring.layout} className="list-none">
      <div className="group/header relative flex h-7 items-center">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md pr-2 pl-2 text-sm text-fg-muted outline-none transition-colors duration-150 hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
        >
          <span className="relative flex text-fg-faint [&_svg]:size-4">
            <Icon />
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
          {count}
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={spring.snappy} className="flex text-fg-faint">
            <ChevronRight className="size-3.5" />
          </motion.span>
        </button>
        {onNewDecision && (
          <IconButton
            size="xs"
            label={s.newDecision}
            icon={<Plus />}
            onClick={onNewDecision}
            className="absolute right-7 opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100"
          />
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            key="items"
            initial="initial"
            animate="animate"
            exit={{ opacity: 0, transition: transition.exit }}
            variants={stagger(0.02)}
            className="flex flex-col gap-px pt-px"
          >
            {group.items.length === 0 ? (
              <motion.li variants={variants.fadeUp} className="flex h-7 list-none items-center pl-8 text-xs text-fg-faint">
                {s.emptyLayer}
              </motion.li>
            ) : (
              group.items.map((item) => (
                <motion.li key={item.path} variants={variants.fadeUp} className="list-none">
                  <Row
                    to={docHref(item.path)}
                    active={activePath === item.path}
                    depth={1}
                    muted={item.guide}
                    label={<ItemLabel item={item} />}
                    trailing={item.date ? <span className="text-2xs text-fg-faint tabular">{dayFmt.format(new Date(`${item.date}T12:00:00`))}</span> : undefined}
                  />
                </motion.li>
              ))
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <span className="px-2 pt-4 pb-1 text-2xs font-medium tracking-wide text-fg-faint uppercase">{children}</span>;
}

export function MemoryNav({
  workspaceName,
  groups,
  loading,
  pending,
  onNewDecision,
}: {
  workspaceName: string;
  groups: LayerGroup[];
  loading: boolean;
  pending: number;
  onNewDecision: () => void;
}) {
  const location = useLocation();
  const path = location.pathname;
  const activeDoc = docPathFrom(path);

  return (
    <nav aria-label={s.title} className="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-canvas-subtle">
      <div className="flex flex-col gap-0.5 px-5 pt-6 pb-2">
        <h1 className="text-xl text-fg">{s.title}</h1>
        <p className="truncate text-xs text-fg-muted">{workspaceName}</p>
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-3 pb-6">
        <LayoutGroup id="memory-nav">
          <div className="flex flex-col">
            <SectionLabel>{s.navInbox}</SectionLabel>
            <Row
              to="/memory/proposals"
              active={path.startsWith("/memory/proposals")}
              icon={Inbox}
              label={s.proposals}
              trailing={<CountBadge count={pending} aria-label={`${pending} bekleyen öneri`} />}
            />
            <SectionLabel>{s.navDocs}</SectionLabel>
            {loading ? (
              <div className="flex flex-col gap-2 px-2 py-1" aria-busy>
                {[70, 55, 62, 48].map((w) => (
                  <Skeleton key={w} height={12} width={`${w}%`} />
                ))}
              </div>
            ) : (
              <ul className="flex flex-col gap-px">
                {groups.map((g) => (
                  <GroupView key={g.layer} group={g} activePath={activeDoc} onNewDecision={g.layer === "decisions" ? onNewDecision : undefined} />
                ))}
              </ul>
            )}
            <SectionLabel>{s.navTools}</SectionLabel>
            <Row to="/memory/boundaries" active={path.startsWith("/memory/boundaries")} icon={ShieldHalf} label={s.boundariesMap} />
            <Row to="/memory/context" active={path.startsWith("/memory/context")} icon={ScrollText} label={s.context} />
            <Row to="/memory/history" active={path.startsWith("/memory/history")} icon={History} label={s.history} />
          </div>
        </LayoutGroup>
      </ScrollArea>
    </nav>
  );
}
