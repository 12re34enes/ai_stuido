import { FilePlus2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import { Button, Dialog, Field, Input, toast } from "@/ui";

import { useWriteDoc } from "../api";
import { docHref } from "../links";
import { memoryStrings as s } from "../strings";
import { decisionPath, isoDate } from "../tree";

/** Creates `decisions/YYYY-MM-DD-<slug>.md` from the ADR template and opens it in the editor. */
export function NewDecisionDialog({ ws, open, onOpenChange, existing }: { ws: string; open: boolean; onOpenChange: (open: boolean) => void; existing: string[] }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const write = useWriteDoc(ws);
  const error = submitted && !title.trim() ? s.titleRequired : null;
  const date = isoDate(new Date());
  const path = decisionPath(title.trim() || "karar", date, existing);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitted(true);
    const t = title.trim();
    if (!t || write.isPending) return;
    write.mutate(
      { path, content: s.decisionTemplate(t, date), message: `Karar kaydı eklendi: ${t}` },
      {
        onSuccess: (res) => {
          toast.success(s.decisionCreated, { description: res.doc.path });
          onOpenChange(false);
          setTitle("");
          setSubmitted(false);
          void navigate(docHref(res.doc.path, "edit"));
        },
        onError: (err) => toast.error(s.saveFailed, { description: err instanceof ApiError ? err.message : undefined }),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={s.newDecisionTitle}
      description={s.newDecisionDescription}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.cancel}
          </Button>
          <Button variant="primary" type="submit" form="memory-new-decision" icon={<FilePlus2 />} loading={write.isPending}>
            {s.create}
          </Button>
        </>
      }
    >
      <form id="memory-new-decision" onSubmit={submit} className="flex flex-col gap-2 p-0.5">
        <Field label={s.decisionTitle} htmlFor="memory-decision-title" required error={error} hint={<span className="font-mono">{path}</span>}>
          <Input id="memory-decision-title" autoFocus value={title} invalid={!!error} placeholder={s.decisionTitlePlaceholder} onChange={(e) => setTitle(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
