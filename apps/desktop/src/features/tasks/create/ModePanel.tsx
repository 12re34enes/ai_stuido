/**
 * Mode picker (Tek / İkili / Yarış / Hat / Kurul / Ekip) with a live preview of the selected flow
 * or, for Ekip, the chosen team's org chart. A selected studio or saved flow overrides the mode:
 * the control dims and the preview shows that graph instead.
 */
import { AnimatePresence, motion } from "motion/react";

import { variants } from "@/motion/tokens";
import { SegmentedControl, Skeleton, cn, type SegmentedOption } from "@/ui";

import { s as teamStrings } from "../../teams/strings";
import { MODES, type FlowGraph } from "../list/types";
import type { ComposerMode } from "./composerStore";
import { FlowDiagram } from "./FlowDiagram";
import { useModeGraphs, useModes } from "./queries";
import { createStrings as s } from "./strings";
import { TeamModePreview } from "./TeamModePreview";
import type { SavedFlow, Studio } from "./types";

export interface ModePanelProps {
  workspaceId: string;
  mode: ComposerMode;
  onModeChange: (mode: ComposerMode) => void;
  studio: Studio | null;
  flow: SavedFlow | null;
  /** Validation message for Ekip mode (no team chosen). */
  teamError?: string;
  onTeamPicked?: () => void;
}

function DiagramSkeleton() {
  return (
    <div className="flex h-[88px] items-center justify-between px-[4%]" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex flex-col items-center gap-2">
          <Skeleton circle width={24} height={24} />
          <Skeleton width={44} height={8} />
        </div>
      ))}
    </div>
  );
}

export function ModePanel({ workspaceId, mode, onModeChange, studio, flow, teamError, onTeamPicked }: ModePanelProps) {
  const modes = useModes();
  const graphs = useModeGraphs(workspaceId);
  const info = new Map((modes.data ?? []).map((m) => [m.mode as string, m]));
  const overridden = studio ? s.mode.overriddenByStudio : flow ? s.mode.overriddenByFlow : null;

  const options: SegmentedOption<ComposerMode>[] = [
    ...MODES.map((m) => ({ value: m as ComposerMode, label: info.get(m)?.label ?? s.mode.labels[m], hint: info.get(m)?.description })),
    { value: "team", label: info.get("team")?.label ?? teamStrings.composer.mode, hint: info.get("team")?.description ?? teamStrings.composer.modeHint },
  ];

  let key: string;
  let graph: FlowGraph | undefined;
  let description: string | undefined;
  let loading = false;
  let failed = false;
  const team = !studio && !flow && mode === "team";
  if (studio) {
    key = `studio:${studio.id}`;
    graph = studio.graph;
    description = studio.description;
  } else if (flow) {
    key = `flow:${flow.id}:${flow.version}`;
    graph = flow.graph;
    description = flow.description || flow.name;
  } else if (mode === "team") {
    key = "team";
    description = info.get("team")?.description ?? teamStrings.composer.modeHint;
  } else {
    key = `mode:${mode}`;
    const q = graphs[mode];
    graph = q.data;
    loading = q.isPending && q.fetchStatus !== "idle";
    failed = q.isError;
    description = info.get(mode)?.description;
  }

  return (
    <section aria-label={s.mode.label} className="flex flex-col gap-3">
      <div className="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-2">
        <div className={cn("transition-opacity duration-200", overridden && "pointer-events-none opacity-45")} aria-disabled={overridden ? true : undefined}>
          <SegmentedControl<ComposerMode> aria-label={s.mode.label} value={mode} onValueChange={onModeChange} options={options} />
        </div>
        <div className="relative min-w-0 flex-1">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.p key={`${key}:${overridden ?? ""}`} {...variants.fade} className="line-clamp-2 text-xs leading-4 text-fg-muted">
              {overridden && <span className="font-medium text-fg">{overridden}. </span>}
              {description}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
      <div className="relative min-h-[88px]" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          {team ? (
            <motion.div key="team" {...variants.fade}>
              <TeamModePreview workspaceId={workspaceId} error={teamError} onPicked={onTeamPicked} />
            </motion.div>
          ) : graph && graph.nodes.length > 0 ? (
            <motion.div key={key} {...variants.fade}>
              <FlowDiagram graph={graph} aria-label={`${s.mode.preview}: ${graph.nodes.map((n) => n.label).join(", ")}`} />
            </motion.div>
          ) : loading ? (
            <motion.div key="loading" {...variants.fade}>
              <DiagramSkeleton />
            </motion.div>
          ) : failed ? (
            <motion.p key="failed" {...variants.fade} className="flex h-[88px] items-center justify-center text-xs text-fg-faint">
              {s.mode.unavailable}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}
