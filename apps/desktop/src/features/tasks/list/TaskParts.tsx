/** Small task presentation pieces shared by the home screen and the task list. */
import { Sparkles, Workflow } from "lucide-react";
import { createElement } from "react";

import { AnimatedNumber, Badge, StatusDot, Tooltip } from "@/ui";

import { studioIcon } from "../create/icons";
import { useStudios } from "../create/queries";
import { modeLabel, qualityTone, sourceLabel, statusLabel, taskDot } from "./status";
import { taskStrings as s } from "./strings";
import type { Task } from "./types";

export function TaskStatusDot({ task, size = 12 }: { task: Pick<Task, "status">; size?: number }) {
  return <StatusDot status={taskDot(task.status)} size={size} label={statusLabel(task.status)} />;
}

/** Mode, studio or saved-flow badge. */
export function TaskKindBadge({ task }: { task: Pick<Task, "mode" | "studio_id" | "flow_id"> }) {
  const studios = useStudios();
  if (task.studio_id) {
    const studio = studios.data?.find((st) => st.id === task.studio_id);
    return (
      <Badge tone="claude" icon={createElement(studio ? studioIcon(studio.icon) : Sparkles)} className="max-w-[160px]">
        <span className="truncate">{studio?.name ?? s.sources.studio}</span>
      </Badge>
    );
  }
  if (task.flow_id) {
    return (
      <Badge icon={<Workflow />} className="max-w-[160px]">
        <span className="truncate">{s.savedFlow}</span>
      </Badge>
    );
  }
  return <Badge>{modeLabel(task.mode)}</Badge>;
}

export function SourceBadge({ source }: { source: string }) {
  if (source === "user" || source === "studio") return null;
  return (
    <Badge variant="outline" tone="info">
      {sourceLabel(source)}
    </Badge>
  );
}

export function QualityPill({ score }: { score: number | null }) {
  if (score === null || score === undefined) return null;
  const value = Math.round(score);
  return (
    <Tooltip content={s.qualityScore(value)} side="top">
      <span tabIndex={0} aria-label={s.qualityScore(value)} className="inline-flex outline-none">
        <Badge tone={qualityTone(value)} className="min-w-[28px] justify-center tabular">
          <AnimatedNumber value={value} />
        </Badge>
      </span>
    </Tooltip>
  );
}
