/** Approvals that ask for input: agent question, budget choice, human step form, race winner. */
import { Check, Clock3, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

import { useNow } from "@/hooks/useNow";
import { spring } from "@/motion/tokens";
import { Badge, cn, Field, Input, MarkdownView, ProviderMark, resetCountdown, Select, Switch, Textarea, uiStrings } from "@/ui";

import { budgetPayload, customPayload, questionPayload, type SchemaField } from "../payload";
import { approvalStrings as s } from "../strings";
import { Section, Stats, type DetailProps } from "./common";

// --------------------------------------------------------------------------- choice list

interface Choice {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
}

function ChoiceList({
  label,
  value,
  onChange,
  choices,
  disabled,
}: {
  label: string;
  value: string | null;
  onChange: (v: string) => void;
  choices: Choice[];
  disabled?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    const i = choices.findIndex((c) => c.value === value);
    const next = e.key === "ArrowDown" || e.key === "ArrowRight" ? i + 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? i - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const c = choices[(next + choices.length) % choices.length];
    if (!c) return;
    onChange(c.value);
    refs.current[choices.indexOf(c)]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={onKey} className="flex flex-col gap-1.5">
      {choices.map((c, i) => {
        const active = c.value === value;
        return (
          <button
            key={c.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (value === null && i === 0) ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(c.value)}
            className={cn(
              "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[border-color,background-color,box-shadow] duration-150",
              "focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60",
              active ? "border-accent bg-accent-soft/50" : "border-line bg-surface hover:border-line-strong hover:bg-surface-hover",
            )}
          >
            <span
              className={cn(
                "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border transition-colors duration-150",
                active ? "border-accent bg-accent" : "border-line-strong",
              )}
            >
              {active && (
                <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring.bouncy} className="flex text-fg-on-accent">
                  <Check className="size-2.5" strokeWidth={3.5} aria-hidden />
                </motion.span>
              )}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm text-fg">{c.title}</span>
              {c.description && <span className="text-xs text-fg-muted">{c.description}</span>}
            </span>
            {c.trailing && <span className="shrink-0">{c.trailing}</span>}
          </button>
        );
      })}
    </div>
  );
}

// --------------------------------------------------------------------------- question

export function QuestionDetail({ approval, variant, draft, setDraft, editable }: DetailProps) {
  const p = questionPayload(approval.payload, approval.title);
  const id = useId();
  const answer = String(draft.answer ?? "");
  const full = variant === "full";
  return (
    <div className={cn("flex flex-col", full ? "gap-4" : "gap-2.5")}>
      {full && (
        <blockquote className="border-l-2 border-accent pl-3.5 font-serif text-md leading-6 text-fg" data-selectable>
          {p.question}
        </blockquote>
      )}
      {p.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={s.question.options}>
          {p.options.map((o) => {
            const active = answer === o;
            return (
              <button
                key={o}
                type="button"
                aria-pressed={active}
                disabled={!editable}
                onClick={() => setDraft({ answer: o })}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium outline-none transition-[border-color,background-color,color] duration-150 focus-visible:shadow-[var(--focus-ring)]",
                  active ? "border-accent bg-accent text-fg-on-accent" : "border-line bg-surface text-fg hover:border-line-strong",
                )}
              >
                {active && <Check className="size-3" aria-hidden />}
                {o}
              </button>
            );
          })}
        </div>
      )}
      <Field label={full ? s.question.answer : undefined} htmlFor={id}>
        <Textarea
          id={id}
          aria-label={s.question.answer}
          value={answer}
          disabled={!editable}
          onChange={(e) => setDraft({ answer: e.target.value })}
          placeholder={s.question.placeholder}
          minRows={full ? 3 : 1}
          maxRows={full ? 10 : 4}
          className={full ? undefined : "text-xs"}
        />
      </Field>
    </div>
  );
}

// --------------------------------------------------------------------------- budget

export function BudgetDetail({ approval, variant, draft, setDraft, editable }: DetailProps) {
  const p = budgetPayload(approval.payload);
  const now = useNow(1000, Boolean(p.resetsAt));
  const left = resetCountdown(p.resetsAt, now);
  return (
    <div className={cn("flex flex-col", variant === "full" ? "gap-4" : "gap-2.5")}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        {p.provider && (
          <span className="inline-flex items-center gap-1.5 font-medium text-fg">
            <ProviderMark provider={p.provider} size={13} label="" />
            {uiStrings.providers[p.provider]}
          </span>
        )}
        <Badge tone={p.exhausted ? "danger" : "warning"}>{p.exhausted ? s.budget.exhausted : s.budget.over}</Badge>
        {p.purpose && <span>{p.purpose}</span>}
        {left && (
          <span className="ml-auto inline-flex items-center gap-1 tabular">
            <Clock3 className="size-3.5" aria-hidden />
            {s.budget.resets}: {left}
          </span>
        )}
      </div>
      {p.options.length > 0 && (
        <ChoiceList
          label={s.budget.choose}
          value={typeof draft.action === "string" ? draft.action : null}
          onChange={(action) => setDraft({ action })}
          disabled={!editable}
          choices={p.options.map((o) => ({ value: o, title: s.budget.options[o] ?? o }))}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- custom: human / compare

function FieldInput({ field, value, onChange, disabled }: { field: SchemaField; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const id = useId();
  if (field.type === "boolean") {
    return <Switch checked={value === true} onCheckedChange={onChange} disabled={disabled} label={field.label} description={field.description ?? undefined} />;
  }
  return (
    <Field label={field.label} htmlFor={id} hint={field.description ?? undefined} required={field.required}>
      {field.type === "enum" ? (
        <Select
          id={id}
          aria-label={field.label}
          value={String(value ?? "")}
          onValueChange={onChange}
          disabled={disabled}
          options={field.options.map((o) => ({ value: o, label: o }))}
        />
      ) : field.type === "text" ? (
        <Textarea id={id} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} disabled={disabled} minRows={3} maxRows={10} />
      ) : (
        <Input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      )}
    </Field>
  );
}

export function CustomDetail({ approval, variant, draft, setDraft, editable }: DetailProps) {
  const c = customPayload(approval.payload, approval.summary);
  const full = variant === "full";
  const textId = useId();

  if (c.type === "compare") {
    if (!full) {
      const suggested = c.candidates.find((x) => x.nodeId === c.suggested);
      return (
        <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span>
            {s.custom.candidates}: {c.candidates.length}
          </span>
          {suggested && (
            <Badge tone="accent" icon={<Sparkles aria-hidden />}>
              {s.custom.suggested}: {suggested.label}
            </Badge>
          )}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        {c.criteria.length > 0 && (
          <Section title={s.custom.criteria}>
            <ul className="flex flex-wrap gap-1.5">
              {c.criteria.map((x) => (
                <li key={x}>
                  <Badge variant="outline">{x}</Badge>
                </li>
              ))}
            </ul>
          </Section>
        )}
        <Section title={s.custom.candidates}>
          <ChoiceList
            label={s.custom.candidates}
            value={typeof draft.winner === "string" ? draft.winner : null}
            onChange={(winner) => setDraft({ winner })}
            disabled={!editable}
            choices={c.candidates.map((x) => ({
              value: x.nodeId,
              title: (
                <span className="inline-flex items-center gap-2">
                  {x.provider && <ProviderMark provider={x.provider} size={14} label="" />}
                  <span className="font-medium">{x.label}</span>
                  {x.model && <span className="font-mono text-2xs text-fg-muted">{x.model}</span>}
                  {x.nodeId === c.suggested && (
                    <Badge tone="accent" icon={<Sparkles aria-hidden />}>
                      {s.custom.suggested}
                    </Badge>
                  )}
                </span>
              ),
              description: (
                <span className="flex flex-col gap-1.5 pt-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{s.custom.files(x.files)}</span>
                    <Stats additions={x.additions} deletions={x.deletions} />
                    {x.gates.map((g) => (
                      <Badge key={g.kind} tone={g.status === "passed" ? "success" : g.status === "failed" ? "danger" : "neutral"}>
                        {g.kind}
                      </Badge>
                    ))}
                  </span>
                  {x.summary && <span className="line-clamp-3 text-fg-muted">{x.summary}</span>}
                </span>
              ),
            }))}
          />
        </Section>
      </div>
    );
  }

  // Human step (or an unknown custom approval): instructions + input.
  return (
    <div className={cn("flex flex-col", full ? "gap-5" : "gap-2.5")}>
      {full && c.instructions && (
        <Section title={s.custom.instructions}>
          <div className="rounded-lg border border-line bg-surface px-5 py-4">
            <MarkdownView source={c.instructions} />
          </div>
        </Section>
      )}
      {c.type === "human" &&
        (c.fields.length > 0 ? (
          full ? (
            <Section title={s.custom.input}>
              <div className="flex flex-col gap-3.5">
                {c.fields.map((f) => (
                  <FieldInput key={f.name} field={f} value={draft[f.name]} onChange={(v) => setDraft({ [f.name]: v })} disabled={!editable} />
                ))}
              </div>
            </Section>
          ) : null
        ) : (
          <Field label={full ? s.custom.text : undefined} htmlFor={textId}>
            <Textarea
              id={textId}
              aria-label={s.custom.text}
              value={String(draft.text ?? "")}
              onChange={(e) => setDraft({ text: e.target.value })}
              disabled={!editable}
              minRows={full ? 3 : 1}
              maxRows={full ? 10 : 4}
              className={full ? undefined : "text-xs"}
            />
          </Field>
        ))}
    </div>
  );
}
