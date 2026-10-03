/** "Bu akışla görev başlat": a small dialog that saves (when needed) and POSTs /engine/tasks with flow_id. */
import { Play } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import { useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import { transition, variants } from "@/motion/tokens";
import { Button, Dialog, Field, Input, Textarea, toast } from "@/ui";

import { useStartTask } from "../api";
import { reportFromErrorDetails } from "../model/issues";
import { s } from "../strings";
import { useEditor, useEditorStore } from "./store";
import { useEditorActions } from "./useEditorActions";

function titleFrom(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

export function StartTaskDialog({ open, onOpenChange, workspaceId }: { open: boolean; onOpenChange: (open: boolean) => void; workspaceId: string | null }) {
  const store = useEditorStore();
  const actions = useEditorActions();
  const navigate = useNavigate();
  const start = useStartTask();
  const dirty = useEditor((st) => st.dirty || st.flowId === null);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { title: useId(), prompt: useId() };

  const submit = async () => {
    if (!prompt.trim() || !workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      let flowId = store.getState().flowId;
      if (dirty || !flowId) {
        const saved = await actions.save();
        if (!saved) return;
        flowId = saved.id;
      }
      const detail = await start.mutateAsync({ workspace_id: workspaceId, title: title.trim() || titleFrom(prompt), prompt, mode: "custom", flow_id: flowId, start: true });
      onOpenChange(false);
      setPrompt("");
      setTitle("");
      toast.success(s.start.started, {
        description: detail.task.title,
        action: { label: s.start.open, onClick: () => void navigate(`/tasks/${encodeURIComponent(detail.task.id)}`) },
      });
    } catch (e) {
      const msg = e instanceof ApiError || e instanceof Error ? e.message : s.start.failed;
      setError(msg);
      if (e instanceof ApiError) {
        const report = reportFromErrorDetails(e.details);
        if (report) store.getState().setReport(report, { explicit: true });
      }
    } finally {
      setBusy(false);
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
          <Button variant="primary" icon={<Play />} loading={busy} disabled={!prompt.trim()} onClick={() => void submit()} data-testid="start-submit">
            {dirty ? s.start.submitSave : s.start.submit}
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
          {dirty && (
            <motion.p key="dirty" {...variants.fade} className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
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
