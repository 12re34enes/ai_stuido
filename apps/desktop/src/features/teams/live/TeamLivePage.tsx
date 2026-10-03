/** /teams/live/:runId[?node=] — the live team view on its own page, with a way back to the task. */
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router";

import { api } from "@/lib/api";
import { Button, IconButton } from "@/ui";

import { retry, useTeamRun } from "../api";
import { s } from "../strings";
import { TeamLiveView } from "./TeamLiveView";

export function TeamLivePage({ runId, nodeId }: { runId: string; nodeId: string | null }) {
  const navigate = useNavigate();
  const run = useQuery({
    queryKey: ["engine", "teams", "runInfo", runId],
    queryFn: () => api.get<{ id: string; task_id: string }>(`/engine/runs/${encodeURIComponent(runId)}`),
    retry,
    staleTime: Infinity,
  });
  const taskId = run.data?.task_id;
  const teamName = useTeamRun(runId, nodeId).data?.team_name;
  return (
    <div className="flex h-full flex-col" data-testid="team-live-page">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line-subtle bg-canvas px-4">
        <IconButton size="md" label={s.live.back} icon={<ChevronLeft />} onClick={() => (window.history.length > 1 ? void navigate(-1) : void navigate("/teams"))} />
        <h1 className="font-serif text-lg text-fg">{s.live.pageTitle}</h1>
        {teamName && <span className="truncate text-sm text-fg-muted">{teamName}</span>}
        <span className="font-mono text-[11px] text-fg-faint">{runId}</span>
        {taskId && (
          <Button size="sm" variant="ghost" icon={<ExternalLink />} className="ml-auto" onClick={() => void navigate(`/tasks/${encodeURIComponent(taskId)}`)}>
            {s.live.openTask}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1">
        <TeamLiveView runId={runId} nodeId={nodeId} variant="page" />
      </div>
    </div>
  );
}
