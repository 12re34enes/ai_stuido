import { ArrowUpRight, Clock3, Download, FileQuestion, Info, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion, useScroll, useSpring } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { formatDateTime } from "@/i18n/format";
import { useCurrentWorkspace } from "@/lib/workspace";
import { useReducedMotionPref } from "@/motion/hooks";
import { spring, stagger, variants } from "@/motion/tokens";
import { Button, cn, CopyButton, EmptyState, MarkdownView, Skeleton, SkeletonText, toast, Tooltip } from "@/ui";

import { useRunEvidence, useStudio, useTaskDetail, useTaskDocument } from "../api";
import { BackLink, LoadError } from "../components/Page";
import { StudioIcon } from "../components/StudioIcon";
import { buildStudioDocument, documentHeadings, exportFileName, fromServerDocument, readingStats, splitDocument, type Heading } from "../document";
import { studioStrings as s } from "../strings";

/** Reader typography: serif headings, comfortable measure and rhythm (overrides MarkdownView's UI density). */
const readerProse = cn(
  "gap-5! text-[15px]! leading-[1.75]! text-fg",
  "[&_h1]:mt-12 [&_h1]:text-[1.875rem] [&_h1]:leading-[1.2] [&_h1]:tracking-[-0.015em]",
  "[&_h2]:mt-11 [&_h2]:border-b [&_h2]:border-line-subtle [&_h2]:pb-2 [&_h2]:text-[1.4rem] [&_h2]:leading-[1.3]",
  "[&_h3]:mt-8 [&_h3]:text-[1.15rem] [&_h3]:leading-[1.4]",
  "[&_h4]:mt-6 [&_h4]:text-[15px]",
  "[&>h1:first-child]:mt-0 [&>h2:first-child]:mt-0",
  "[&_li]:leading-[1.7] [&_ol]:gap-1.5 [&_ul]:gap-1.5",
  "[&_blockquote]:border-l-accent/50 [&_blockquote]:font-serif [&_blockquote]:text-[16px] [&_blockquote]:italic",
  "[&_table]:text-[13px] [&_hr]:my-6",
);

function Banner({ tone, icon, title, children }: { tone: "info" | "warning"; icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <motion.div
      {...variants.fadeUp}
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
        tone === "info" ? "border-info/25 bg-info-soft/60 text-fg" : "border-warning/30 bg-warning-soft/60 text-fg",
      )}
    >
      <span className={cn("mt-0.5 [&_svg]:size-4", tone === "info" ? "text-info" : "text-warning")}>{icon}</span>
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        {children && <span className="text-xs text-fg-muted">{children}</span>}
      </div>
    </motion.div>
  );
}

function Toc({ headings, active, onJump }: { headings: Heading[]; active: number; onJump: (i: number) => void }) {
  return (
    <nav aria-label={s.toc} className="flex flex-col gap-2">
      <span className="text-2xs font-medium tracking-wide text-fg-faint uppercase">{s.toc}</span>
      <ol className="relative flex flex-col border-l border-line">
        {headings.map((h, i) => (
          <li key={`${i}-${h.text}`} className="relative">
            {active === i && <motion.span layoutId="reader-toc-active" transition={spring.layout} className="absolute inset-y-0.5 -left-px w-0.5 rounded-full bg-accent" />}
            <button
              type="button"
              onClick={() => onJump(i)}
              className={cn(
                "block w-full truncate py-1 text-left text-xs outline-none transition-colors duration-150 focus-visible:text-fg",
                h.level >= 3 ? "pl-6" : "pl-3",
                active === i ? "text-fg" : "text-fg-muted hover:text-fg",
              )}
              title={h.text}
            >
              {h.text}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function ReaderSkeleton() {
  return (
    <div className="mx-auto flex max-w-[70ch] flex-col gap-5 pt-6" aria-busy>
      <Skeleton width={160} height={12} />
      <Skeleton width="80%" height={30} />
      <Skeleton width={220} height={12} />
      <div className="h-6" />
      <SkeletonText lines={5} />
      <SkeletonText lines={4} />
      <SkeletonText lines={6} />
    </div>
  );
}

export function OutputPage({ studioId, taskId }: { studioId: string; taskId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotionPref();
  const detail = useTaskDetail(taskId);
  const task = detail.data?.task;
  const refVersion = typeof task?.source_ref?.version === "number" ? (task.source_ref.version as number) : undefined;
  const studio = useStudio(studioId, refVersion);
  const latest = useStudio(studioId);
  const template = studio.data?.output_template ?? latest.data?.output_template;
  // studiod renders the document with the real (sandboxed) Jinja; the client subset only steps in
  // when that endpoint is unavailable (older studiod, transient error).
  const server = useTaskDocument(taskId);
  const clientRender = server.isError && !server.data;
  const needsEvidence = clientRender && !!template?.includes("gate.");
  const evidence = useRunEvidence(needsEvidence ? (detail.data?.current_run?.id ?? undefined) : undefined);
  const { workspace } = useCurrentWorkspace();

  const doc = useMemo(() => {
    if (!detail.data) return null;
    if (server.data) return fromServerDocument(server.data);
    if (!clientRender) return null;
    return buildStudioDocument(studio.data ?? latest.data, detail.data, { workspaceName: workspace?.name, evidence: evidence.data });
  }, [clientRender, detail.data, evidence.data, latest.data, server.data, studio.data, workspace?.name]);
  const parts = useMemo(() => splitDocument(doc?.markdown ?? ""), [doc?.markdown]);
  const headings = useMemo(() => documentHeadings(parts.body).filter((h) => h.level <= 3), [parts.body]);
  const stats = useMemo(() => readingStats(doc?.markdown ?? ""), [doc?.markdown]);

  const { scrollYProgress } = useScroll({ container: scrollRef });
  const progress = useSpring(scrollYProgress, { stiffness: 260, damping: 40, mass: 0.6 });
  const [active, setActive] = useState(0);

  const headingElements = () => {
    const els = Array.from(articleRef.current?.querySelectorAll<HTMLElement>("h1, h2, h3") ?? []);
    const texts = headings.map((h) => h.text);
    // Match TOC entries to rendered headings in order (rendered text has no Markdown marks).
    const out: HTMLElement[] = [];
    let j = 0;
    for (const el of els) {
      if (j < texts.length && el.textContent?.trim() === texts[j]) {
        out.push(el);
        j++;
      }
    }
    return out;
  };

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || headings.length < 2) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const top = root.getBoundingClientRect().top + 120;
        const els = headingElements();
        let idx = 0;
        els.forEach((el, i) => {
          if (el.getBoundingClientRect().top <= top) idx = i;
        });
        setActive(idx);
      });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", onScroll);
    };
    // headingElements reads refs; re-bind when the heading list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headings]);

  const jump = (i: number) => {
    const el = headingElements()[i];
    const root = scrollRef.current;
    if (!el || !root) return;
    const y = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 72;
    root.scrollTo({ top: y, behavior: reduced ? "auto" : "smooth" });
    setActive(i);
  };

  const download = () => {
    if (!doc?.markdown || !task) return;
    const url = URL.createObjectURL(new Blob([doc.markdown], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileName(task.title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast.success(s.exportMd, { description: a.download });
  };

  const run = detail.data?.current_run;
  const finishedAt = run?.finished_at ?? (task?.status === "completed" ? task.updated_at : null);
  const studioName = studio.data?.name ?? latest.data?.name ?? studioId;

  return (
    <div ref={scrollRef} className="absolute inset-0 overflow-y-auto overscroll-contain" data-reader>
      <div className="sticky top-0 z-10 border-b border-line-subtle bg-canvas/85 backdrop-blur-xl">
        <div className="mx-auto flex h-12 max-w-[1180px] items-center gap-3 px-8">
          <BackLink to={`/studios/${encodeURIComponent(studioId)}`}>{studioName}</BackLink>
          <div className="flex-1" />
          {doc?.markdown && (
            <motion.div {...variants.fade} className="flex items-center gap-1">
              <CopyButton value={doc.markdown} size="md" label={s.copyMarkdown} copiedLabel={s.copied} />
              <Tooltip content={s.exportMd}>
                <Button size="sm" variant="ghost" icon={<Download />} onClick={download} aria-label={s.exportMd}>
                  .md
                </Button>
              </Tooltip>
            </motion.div>
          )}
          <Link
            to={`/tasks/${encodeURIComponent(taskId)}`}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2.5 text-xs font-medium text-fg outline-none transition-colors hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]"
          >
            {s.openTask}
            <ArrowUpRight className="size-3.5 text-fg-muted" aria-hidden />
          </Link>
        </div>
        <motion.div aria-hidden className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-accent/70" style={{ scaleX: progress }} />
      </div>

      <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-12 px-8 pt-10 pb-28 xl:grid-cols-[minmax(0,1fr)_220px]">
        <div className="min-w-0">
          {detail.isError && !detail.data ? (
            <LoadError title={s.outputLoadError} error={detail.error} onRetry={() => void detail.refetch()} className="mt-10" />
          ) : !detail.data || !doc || !task ? (
            <ReaderSkeleton />
          ) : (
            <motion.article
              className="mx-auto flex max-w-[70ch] flex-col gap-6"
              initial="initial"
              animate="animate"
              variants={stagger(0.05)}
              aria-labelledby="reader-title"
            >
              <motion.header variants={variants.fadeUp} className="flex flex-col gap-3">
                <span className="flex items-center gap-2 text-xs text-fg-muted">
                  <StudioIcon name={studio.data?.icon ?? latest.data?.icon} size="sm" />
                  <span className="font-medium text-fg">{studioName}</span>
                  <span className="text-fg-faint">·</span>
                  <span>{s.outputTitle}</span>
                </span>
                <h1 id="reader-title" className="text-[2.125rem] leading-[1.18] tracking-[-0.02em] text-balance text-fg">
                  {parts.title ?? task.title}
                </h1>
                {parts.summary && <p className="font-serif text-lg leading-[1.5] text-fg-muted">{parts.summary}</p>}
                {parts.title && parts.title !== task.title && (
                  <p className="text-sm text-fg-muted">
                    <span className="text-fg-faint">{s.taskLabel}</span> {task.title}
                  </p>
                )}
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
                  {finishedAt && <span>{formatDateTime(finishedAt)}</span>}
                  {doc.markdown && (
                    <>
                      <span className="text-fg-faint">·</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="size-3" aria-hidden />
                        {s.readingTime(stats.minutes)}
                      </span>
                      <span className="text-fg-faint">·</span>
                      <span className="tabular">{s.words(stats.words)}</span>
                    </>
                  )}
                </span>
              </motion.header>

              <AnimatePresence initial={false}>
                {(task.status === "running" || task.status === "waiting" || task.status === "queued") && (
                  <Banner key="running" tone="info" icon={<Info />} title={s.notFinished}>
                    {s.notFinishedHint}
                  </Banner>
                )}
                {task.status === "failed" && (
                  <Banner key="failed" tone="warning" icon={<TriangleAlert />} title={s.failedTask}>
                    {detail.data.error ?? s.failedTaskHint}
                  </Banner>
                )}
                {doc.error && (
                  <Banner key="fallback" tone="warning" icon={<TriangleAlert />} title={s.templateFallback}>
                    {doc.error}
                  </Banner>
                )}
              </AnimatePresence>

              {doc.source === "empty" ? (
                <EmptyState icon={<FileQuestion />} title={s.noOutput} description={s.noOutputHint} />
              ) : (
                <motion.div variants={variants.fadeUp} ref={articleRef} className="border-t border-line-subtle pt-8">
                  <MarkdownView source={parts.body} className={readerProse} />
                </motion.div>
              )}
            </motion.article>
          )}
        </div>
        {headings.length >= 2 && (
          <aside className="hidden xl:block">
            <motion.div {...variants.fadeUp} className="sticky top-20">
              <Toc headings={headings} active={active} onJump={jump} />
            </motion.div>
          </aside>
        )}
      </div>
    </div>
  );
}
