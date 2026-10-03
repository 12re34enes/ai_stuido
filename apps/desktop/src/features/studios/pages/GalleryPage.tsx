import { Plus, Search, SearchX, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState } from "react";

import { foldTurkish } from "@/lib/fuzzy";
import { spring, stagger, variants } from "@/motion/tokens";
import { Button, EmptyState, IconButton, Input, Kbd, Skeleton } from "@/ui";

import { useStudios } from "../api";
import { LoadError, Page, SectionHeader } from "../components/Page";
import { StudioCard } from "../components/StudioCard";
import { useShortcut } from "../hooks";
import { groupStudios } from "../model";
import { studioStrings as s } from "../strings";
import type { Studio } from "../types";
import { NewStudioDialog } from "./NewStudioDialog";

function matches(studio: Studio, query: string): boolean {
  if (!query) return true;
  const hay = foldTurkish(`${studio.name} ${studio.description} ${studio.id}`);
  return foldTurkish(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

function CardSkeleton() {
  return (
    <li className="flex h-[188px] list-none flex-col gap-3 rounded-xl border border-line bg-surface p-4 shadow-1">
      <div className="flex items-start justify-between">
        <Skeleton className="size-9 rounded-[10px]" />
        <Skeleton width={56} height={16} className="rounded-full" />
      </div>
      <Skeleton width="55%" height={14} />
      <div className="flex flex-col gap-1.5">
        <Skeleton height={9} />
        <Skeleton height={9} />
        <Skeleton height={9} width="70%" />
      </div>
      <div className="mt-auto flex justify-between border-t border-line-subtle pt-3">
        <Skeleton width={80} height={18} className="rounded-full" />
        <Skeleton width={96} height={18} className="rounded-full" />
      </div>
    </li>
  );
}

const grid = "grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4";

function NewStudioTile({ onClick, label, hint }: { onClick: () => void; label: string; hint?: string }) {
  return (
    <motion.li variants={variants.listItem} className="list-none">
      <motion.button
        type="button"
        onClick={onClick}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.985 }}
        transition={spring.snappy}
        className="group flex h-full min-h-[188px] w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong bg-transparent p-6 text-center outline-none transition-colors duration-200 hover:border-accent/60 hover:bg-accent-soft/25 focus-visible:shadow-[var(--focus-ring)]"
      >
        <span className="grid size-10 place-items-center rounded-full bg-surface-sunken text-fg-muted transition-colors duration-200 group-hover:bg-accent-soft group-hover:text-accent">
          <Plus className="size-5" />
        </span>
        <span className="flex flex-col gap-1">
          <span className="font-serif text-md text-fg">{label}</span>
          {hint && <span className="max-w-[260px] text-xs text-fg-muted">{hint}</span>}
        </span>
      </motion.button>
    </motion.li>
  );
}

export function GalleryPage({ newOpen, onNewOpenChange, returningFrom }: { newOpen: boolean; onNewOpenChange: (open: boolean) => void; returningFrom?: string | null }) {
  const { data, isPending, isError, error, refetch } = useStudios();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useShortcut("/", () => searchRef.current?.focus());
  const studios = useMemo(() => data ?? [], [data]);
  const { builtin, custom } = useMemo(() => groupStudios(studios.filter((st) => matches(st, query))), [studios, query]);
  const noMatch = query && builtin.length === 0 && custom.length === 0;

  return (
    <Page>
      <motion.header {...variants.fadeUp} className="flex items-end justify-between gap-6 pb-8">
        <div className="flex max-w-[640px] flex-col gap-1.5">
          <h1 className="text-2xl text-fg">{s.title}</h1>
          <p className="text-sm text-fg-muted">{s.subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            ref={searchRef}
            size="md"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                setQuery("");
              }
            }}
            placeholder={s.search}
            aria-label={s.search}
            icon={<Search />}
            wrapperClassName="w-56"
            trailing={
              query ? (
                <IconButton size="xs" label="Temizle" icon={<X />} tooltip={false} onClick={() => setQuery("")} />
              ) : (
                <Kbd shortcut="/" />
              )
            }
          />
          <Button variant="primary" icon={<Plus />} onClick={() => onNewOpenChange(true)} disabled={!data}>
            {s.newStudio}
          </Button>
        </div>
      </motion.header>

      {isError && !data ? (
        <LoadError title={s.loadError} error={error} onRetry={() => void refetch()} className="mt-10" />
      ) : isPending ? (
        <section aria-busy className="flex flex-col gap-4">
          <SectionHeader title={s.builtinSection} />
          <ul className={grid}>
            {Array.from({ length: 8 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </ul>
        </section>
      ) : noMatch ? (
        <EmptyState icon={<SearchX />} title={s.noMatch} className="mt-10" />
      ) : (
        <div className="flex flex-col gap-12">
          <AnimatePresence initial={false}>
            {builtin.length > 0 && (
              <motion.section key="builtin" aria-labelledby="studios-builtin" className="flex flex-col gap-4" {...variants.fade}>
                <SectionHeader id="studios-builtin" title={s.builtinSection} count={builtin.length} />
                <motion.ul className={grid} initial="initial" animate="animate" variants={stagger(0.03, returningFrom ? 0.1 : 0)}>
                  {builtin.map((st) => (
                    <StudioCard key={st.id} studio={st} returning={st.id === returningFrom} />
                  ))}
                </motion.ul>
              </motion.section>
            )}
          </AnimatePresence>
          <section aria-labelledby="studios-custom" className="flex flex-col gap-4">
            <SectionHeader id="studios-custom" title={s.customSection} count={custom.length} />
            <motion.ul className={grid} initial="initial" animate="animate" variants={stagger(0.03, 0.08)}>
              {custom.map((st) => (
                <StudioCard key={st.id} studio={st} custom returning={st.id === returningFrom} />
              ))}
              {!query && (
                <NewStudioTile
                  onClick={() => onNewOpenChange(true)}
                  label={custom.length ? s.newStudio : s.customEmpty}
                  hint={custom.length ? undefined : s.customEmptyHint}
                />
              )}
            </motion.ul>
          </section>
        </div>
      )}
      <NewStudioDialog open={newOpen} onOpenChange={onNewOpenChange} studios={studios} />
    </Page>
  );
}
