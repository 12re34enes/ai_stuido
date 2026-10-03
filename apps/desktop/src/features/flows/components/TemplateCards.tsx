/** Cards for starting a flow: mode templates (with live previews), studios and a blank canvas. */
import { Plus, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { spring, variants } from "@/motion/tokens";
import { Badge, cn, Skeleton } from "@/ui";

import { useModeGraph } from "../api";
import { s } from "../strings";
import type { FlowGraph, FlowMode, ModeInfo, Studio } from "../types";
import { MiniGraph } from "./MiniGraph";

export type TemplatePick = { type: "mode"; mode: FlowMode } | { type: "studio"; id: string } | { type: "blank" };

export function TemplateCard({
  title,
  description,
  preview,
  badge,
  onClick,
  testId,
  className,
}: {
  title: string;
  description: string;
  preview: ReactNode;
  badge?: ReactNode;
  onClick: () => void;
  testId?: string;
  className?: string;
}) {
  return (
    <motion.button
      type="button"
      variants={variants.listItem}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.985 }}
      transition={spring.snappy}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "group/card flex flex-col overflow-hidden rounded-xl border border-line bg-surface text-left shadow-1 outline-none",
        "transition-[box-shadow,border-color] duration-200 hover:border-line-strong hover:shadow-2 focus-visible:shadow-[var(--focus-ring)]",
        className,
      )}
    >
      <div className="relative h-[104px] border-b border-line-subtle bg-canvas-subtle px-3 py-2">{preview}</div>
      <div className="flex flex-col gap-1 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <span className="truncate font-serif text-md leading-6 text-fg">{title}</span>
          {badge}
        </div>
        <p className="line-clamp-2 text-xs text-fg-muted">{description}</p>
      </div>
    </motion.button>
  );
}

function ModePreview({ mode, workspaceId, delay }: { mode: FlowMode; workspaceId: string | null; delay: number }) {
  const graph = useModeGraph(mode, workspaceId);
  if (graph.isPending) return <Skeleton className="size-full" />;
  if (graph.isError || !graph.data) return <div className="size-full" />;
  return <MiniGraph graph={graph.data} relayout delay={delay} className="size-full" aria-label={`${mode} önizleme`} />;
}

export function ModeCard({ info, workspaceId, index, onPick }: { info: ModeInfo; workspaceId: string | null; index: number; onPick: (p: TemplatePick) => void }) {
  return (
    <TemplateCard
      testId={`mode-${info.mode}`}
      title={info.label}
      description={info.description}
      preview={<ModePreview mode={info.mode} workspaceId={workspaceId} delay={0.08 + index * 0.05} />}
      onClick={() => onPick({ type: "mode", mode: info.mode })}
    />
  );
}

export function StudioCard({ studio, index, onPick }: { studio: Studio; index: number; onPick: (p: TemplatePick) => void }) {
  return (
    <TemplateCard
      testId={`studio-${studio.id}`}
      title={studio.name}
      description={studio.description}
      badge={<Badge icon={<Sparkles />}>{s.version(studio.version)}</Badge>}
      preview={<MiniGraph graph={studio.graph as FlowGraph} relayout delay={0.08 + index * 0.05} className="size-full" aria-label={`${studio.name} önizleme`} />}
      onClick={() => onPick({ type: "studio", id: studio.id })}
    />
  );
}

export function BlankCard({ onPick }: { onPick: (p: TemplatePick) => void }) {
  return (
    <TemplateCard
      testId="blank-flow"
      title={s.blankFlow}
      description={s.blankFlowHint}
      preview={
        <div className="grid size-full place-items-center">
          <span className="grid size-10 place-items-center rounded-lg border border-dashed border-line-strong text-fg-faint transition-colors group-hover/card:border-accent group-hover/card:text-accent [&_svg]:size-4">
            <Plus aria-hidden />
          </span>
        </div>
      }
      onClick={() => onPick({ type: "blank" })}
    />
  );
}
