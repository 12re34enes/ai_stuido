import { ArrowRight, FilePen, ShieldHalf } from "lucide-react";
import { motion } from "motion/react";
import { useMemo } from "react";
import { Link } from "react-router";

import { variants } from "@/motion/tokens";
import { Badge, Button, EmptyState, MarkdownView, type BadgeTone } from "@/ui";

import { splitDocument } from "@/features/studios/document";

import { displayMarkdown } from "../markdown";
import { memoryStrings as s } from "../strings";
import type { MemoryDoc } from "../types";

const longDate = new Intl.DateTimeFormat("tr-TR", { dateStyle: "long" });

const statusTone: Record<string, BadgeTone> = {
  "kabul edildi": "success",
  önerildi: "info",
  "yerini aldı": "neutral",
  reddedildi: "danger",
};

/** Reading typography for memory documents (a little roomier than the UI default). */
const prose =
  "gap-4! text-[14px]! leading-[1.7]! [&_h1]:mt-8 [&_h2]:mt-8 [&_h2]:text-[1.2rem] [&_h3]:mt-6 [&>h2:first-child]:mt-0 [&>h1:first-child]:mt-0 [&_em]:text-fg-faint";

export function DocView({ doc, onEdit }: { doc: MemoryDoc; onEdit: () => void }) {
  const parts = useMemo(() => splitDocument(doc.content), [doc.content]);
  const body = useMemo(() => displayMarkdown(parts.body, s.emptySection), [parts.body]);
  const isBoundaries = doc.layer === "boundaries";
  const meta = isBoundaries ? {} : parts.meta;
  const hasMeta = !!(meta.status || meta.date || meta.summary);
  const empty = !body.replace(/_Henüz yazılmamış\._/g, "").trim() && !hasMeta;

  return (
    <motion.div {...variants.fadeUp} className="flex flex-col gap-6">
      {isBoundaries && (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <span className="grid size-8 place-items-center rounded-md bg-accent-soft text-accent">
            <ShieldHalf className="size-4" />
          </span>
          <p className="flex-1 text-sm text-fg-muted">{s.boundariesNote}</p>
          <Link
            to="/memory/boundaries"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-accent outline-none transition-colors hover:bg-accent-soft focus-visible:shadow-[var(--focus-ring)]"
          >
            {s.openMap}
            <ArrowRight className="size-3.5" />
          </Link>
        </div>
      )}
      {hasMeta && (
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-5 py-4 text-sm">
          {meta.status && (
            <>
              <dt className="text-xs text-fg-muted">{s.status}</dt>
              <dd>
                <Badge tone={statusTone[meta.status.toLocaleLowerCase("tr-TR")] ?? "neutral"} size="md">
                  {meta.status}
                </Badge>
              </dd>
            </>
          )}
          {meta.date && (
            <>
              <dt className="text-xs text-fg-muted">{s.date}</dt>
              <dd className="text-fg tabular">{/^\d{4}-\d{2}-\d{2}$/.test(meta.date) ? longDate.format(new Date(`${meta.date}T12:00:00`)) : meta.date}</dd>
            </>
          )}
          {meta.summary && (
            <>
              <dt className="text-xs text-fg-muted">{s.summary}</dt>
              <dd className="font-serif text-[15px] leading-[1.5] text-fg">{meta.summary}</dd>
            </>
          )}
        </dl>
      )}
      {empty ? (
        <EmptyState
          icon={<FilePen />}
          title={s.emptyDoc}
          description={s.emptyDocHint}
          action={
            <Button size="sm" variant="primary" icon={<FilePen />} onClick={onEdit}>
              {s.edit}
            </Button>
          }
        />
      ) : (
        <article className="max-w-[72ch]">
          <MarkdownView source={body} className={prose} />
        </article>
      )}
    </motion.div>
  );
}
