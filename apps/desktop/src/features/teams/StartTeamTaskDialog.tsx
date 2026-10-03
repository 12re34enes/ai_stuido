/** "Bu ekiple görev başlat": prompt + title, then POST /engine/tasks with mode "team" (team_id or inline team). */
import { Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import { transition, variants } from "@/motion/tokens";
import { Button, Dialog, Field, Input, Textarea, toast } from "@/ui";

import { useStartTeamTask } from "./api";
import { MiniOrgChart } from "./chart/MiniOrgChart";
import { summaryText } from "./model/spec";
import { s } from "./strings";
import type { TeamSpec } from "./types";

function titleFrom(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export interface StartTeamTaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  teamId: string | null;
  teamName: string;
  spec: TeamSpec;
  /** Send `spec` inline (unsaved edits); `teamId` is still sent for provenance. */
  inline?: boolean;
}

export function StartTeamTaskDialog({ open, onOpenChange, workspaceId, teamId, teamName, spec, inline = false }: StartTeamTaskDialogProps) {
  const navigate = useNavigate();
  const start = useStartTeamTask();
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ids = { title: useId(), prompt: useId() };

  const submit = async () => {
    if (!prompt.trim() || !workspaceId || start.isPending) return;
    setError(null);
    try {
      const detail = await start.mutateAsync({
        workspace_id: workspaceId,
        title: title.trim() || titleFrom(prompt),
        prompt,
        mode: "team",
        team_id: teamId,
        team: inline || !teamId ? spec : null,
        start: true,
      });
      onOpenChange(false);
      setPrompt("");
      setTitle("");
      toast.success(s.start.started, {
        description: detail.task.title,
        action: { label: s.start.openTask, onClick: () => void navigate(`/tasks/${encodeURIComponent(detail.task.id)}`) },
      });
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : s.start.failed);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
      size="md"
      title={s.start.title}
      description={s.start.description}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.cancel}
          </Button>
          <Button variant="primary" icon={<Play />} loading={start.isPending} disabled={!prompt.trim() || !workspaceId} onClick={() => void submit()} data-testid="team-start-submit">
            {s.start.submit}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4 p-px"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-center gap-3 rounded-lg border border-line-subtle bg-canvas-subtle px-3 py-2">
          <MiniOrgChart spec={spec} className="h-12 w-24 shrink-0" aria-label={s.preview(teamName)} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-fg">{teamName}</span>
            <span className="truncate text-xs text-fg-muted">{summaryText(spec)}</span>
          </div>
        </div>
        <Field label={s.start.prompt} htmlFor={ids.prompt} required>
          <Textarea
            id={ids.prompt}
            autoFocus
            minRows={4}
            maxRows={12}
            value={prompt}
            placeholder={s.start.promptPlaceholder}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
        <Field label={s.start.taskTitle} htmlFor={ids.title}>
          <Input id={ids.title} value={title} placeholder={titleFrom(prompt) || s.start.taskTitlePlaceholder} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <AnimatePresence initial={false}>
          {inline && (
            <motion.p key="inline" {...variants.fade} className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
              {s.start.unsavedNote}
            </motion.p>
          )}
          {error && (
            <motion.p key="error" role="alert" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: transition.exit }} className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
              {error}
            </motion.p>
          )}
        </AnimatePresence>
      </form>
    </Dialog>
  );
}
