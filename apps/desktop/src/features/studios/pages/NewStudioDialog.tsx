import { FilePlus2 } from "lucide-react";
import { motion } from "motion/react";
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";

import { spring } from "@/motion/tokens";
import { Button, cn, Dialog, Field, Input } from "@/ui";

import { StudioIcon } from "../components/StudioIcon";
import { BLANK_TEMPLATE, newStudioPath } from "../icons";
import { slugify, STUDIO_ID } from "../model";
import { studioStrings as s } from "../strings";
import type { Studio } from "../types";

/** "Yeni stüdyo": name, id and a template to start from; opens the editor with a copy. */
export function NewStudioDialog({ open, onOpenChange, studios, initialTemplate }: { open: boolean; onOpenChange: (open: boolean) => void; studios: Studio[]; initialTemplate?: string }) {
  const navigate = useNavigate();
  const formId = useId();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [template, setTemplate] = useState(initialTemplate ?? BLANK_TEMPLATE);
  const [submitted, setSubmitted] = useState(false);

  const effectiveId = idTouched ? id : slugify(name);
  const nameError = !name.trim() ? s.nameRequired : null;
  const idError = !STUDIO_ID.test(effectiveId) ? s.badId : studios.some((st) => st.id === effectiveId) ? s.idTaken(effectiveId) : null;

  const reset = () => {
    setName("");
    setId("");
    setIdTouched(false);
    setSubmitted(false);
    setTemplate(initialTemplate ?? BLANK_TEMPLATE);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitted(true);
    if (nameError || idError) return;
    onOpenChange(false);
    void navigate(newStudioPath(template, effectiveId, name.trim()));
    reset();
  };

  const options = [{ id: BLANK_TEMPLATE, name: s.blankTemplate, icon: "sparkles", hint: s.blankTemplateHint }, ...studios.map((st) => ({ id: st.id, name: st.name, icon: st.icon, hint: undefined as string | undefined }))];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
      size="lg"
      title={s.newDialogTitle}
      description={s.newDialogDescription}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {s.cancel}
          </Button>
          <Button variant="primary" type="submit" form={formId} icon={<FilePlus2 />}>
            {s.continue}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-5 p-0.5">
        <div className="grid grid-cols-2 gap-4">
          <Field label={s.nameLabel} htmlFor={`${formId}-name`} required error={submitted ? nameError : null}>
            <Input id={`${formId}-name`} autoFocus value={name} placeholder={s.namePlaceholder} invalid={submitted && !!nameError} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={s.idLabel} htmlFor={`${formId}-id`} required hint={s.idHint} error={submitted || idTouched ? idError : null}>
            <Input
              id={`${formId}-id`}
              value={effectiveId}
              className="font-mono text-xs"
              invalid={(submitted || idTouched) && !!idError}
              onChange={(e) => {
                setIdTouched(true);
                setId(e.target.value.toLowerCase());
              }}
            />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-xs font-medium text-fg">{s.templateLabel}</legend>
          <div role="radiogroup" aria-label={s.templateLabel} className="grid max-h-[300px] grid-cols-3 gap-2 overflow-y-auto p-0.5">
            {options.map((o) => {
              const active = template === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setTemplate(o.id)}
                  className={cn(
                    "relative flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left outline-none transition-colors duration-150 focus-visible:shadow-[var(--focus-ring)]",
                    active ? "border-accent bg-accent-soft/40" : "border-line bg-surface hover:border-line-strong hover:bg-surface-hover",
                  )}
                >
                  <StudioIcon name={o.icon} size="sm" />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-xs font-medium text-fg">{o.name}</span>
                    {o.hint && <span className="truncate text-2xs text-fg-muted">{o.hint}</span>}
                  </span>
                  {active && (
                    <motion.span layoutId={`${formId}-template-ring`} transition={spring.layout} className="pointer-events-none absolute inset-[-1px] rounded-lg border-[1.5px] border-accent" />
                  )}
                </button>
              );
            })}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
