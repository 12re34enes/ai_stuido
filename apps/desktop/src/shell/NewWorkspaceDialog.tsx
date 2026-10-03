import { useState, type FormEvent } from "react";

import { ApiError } from "@/lib/api";
import { useCreateWorkspace } from "@/lib/queries";
import { useShell } from "@/lib/shell";
import { useWorkspaceStore } from "@/lib/workspace";
import { Button, Dialog, Field, Input, toast } from "@/ui";

import { shellStrings as s } from "./strings";

/** "Yeni çalışma alanı" dialog, opened from the switcher or the palette. */
export function NewWorkspaceDialog() {
  const open = useShell((st) => st.newWorkspaceOpen);
  const setOpen = useShell((st) => st.setNewWorkspaceOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen} title={s.workspaceDialog.title} description={s.workspaceDialog.description}>
      {open && <NewWorkspaceForm onDone={() => setOpen(false)} />}
    </Dialog>
  );
}

function NewWorkspaceForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateWorkspace();
  const setCurrent = useWorkspaceStore((st) => st.setCurrentId);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError(s.workspaceDialog.empty);
      return;
    }
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (ws) => {
          setCurrent(ws.id);
          toast.success(s.workspaceDialog.created(ws.name));
          onDone();
        },
        onError: (err) => setError(err instanceof ApiError ? err.message : String(err)),
      },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <Field label={s.workspaceDialog.name} htmlFor="new-workspace-name" error={error}>
        <Input
          id="new-workspace-name"
          autoFocus
          size="lg"
          value={name}
          invalid={Boolean(error)}
          placeholder={s.workspaceDialog.placeholder}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          {s.approvals.cancel}
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          {s.workspaceDialog.create}
        </Button>
      </div>
    </form>
  );
}
