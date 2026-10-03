/** Small form building blocks for the inspector (sections, numbers, tag lists, pickers). */
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { spring, transition } from "@/motion/tokens";
import { Checkbox, cn, Input, ProviderMark, SegmentedControl, Select, type SelectOption } from "@/ui";
import { uiStrings } from "@/ui/strings";

import type { AgentProfile, Provider } from "../../types";

export function Section({ title, description, action, children, className }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-3", className)} aria-label={title}>
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-sans text-2xs font-medium tracking-wide text-fg-faint uppercase">{title}</h3>
          {description && <p className="text-xs text-fg-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0 pt-px">{action}</div>}
      </header>
      {children}
    </section>
  );
}

/** Label + control, consistent 6px rhythm (like ui Field, with an htmlFor-friendly API). */
export function FormField({ label, hint, error, children, htmlFor, className, trailing }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string; className?: string; trailing?: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-xs font-medium text-fg">
          {label}
        </label>
        {trailing}
      </div>
      {children}
      <AnimatePresence initial={false} mode="popLayout">
        {error ? (
          <motion.p key="e" role="alert" className="text-xs text-danger" initial={{ opacity: 0, y: -2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: transition.exit }}>
            {error}
          </motion.p>
        ) : hint ? (
          <motion.p key="h" className="text-xs text-fg-muted" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: transition.exit }}>
            {hint}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  placeholder,
  suffix,
  id,
  allowEmpty = true,
  size = "sm",
  "aria-label": ariaLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  suffix?: string;
  id?: string;
  allowEmpty?: boolean;
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));
  const commit = (raw: string) => {
    setDraft(null);
    if (raw.trim() === "") {
      if (allowEmpty) onChange(null);
      return;
    }
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    onChange(step >= 1 ? Math.round(clamped) : clamped);
  };
  return (
    <Input
      id={id}
      size={size}
      inputMode="decimal"
      value={shown}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="tabular"
      onChange={(e) => {
        setDraft(e.target.value);
        const raw = e.target.value;
        const n = Number(raw.replace(",", "."));
        if (raw.trim() !== "" && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) onChange(step >= 1 ? Math.round(n) : n);
        else if (raw.trim() === "" && allowEmpty) onChange(null);
      }}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const base = value ?? min ?? 0;
          const next = base + (e.key === "ArrowUp" ? step : -step);
          onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next)));
          setDraft(null);
        }
      }}
      trailing={suffix ? <span className="text-xs text-fg-faint">{suffix}</span> : undefined}
    />
  );
}

/** Chips + input. Enter or comma adds; Backspace on empty removes the last chip. */
export function TagInput({
  values,
  onChange,
  placeholder,
  suggestions,
  id,
  mono = true,
  "aria-label": ariaLabel,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  id?: string;
  mono?: boolean;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return;
    onChange([...values, ...parts.filter((p) => !values.includes(p))]);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };
  const open = (suggestions ?? []).filter((sug) => !values.includes(sug));
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-1 transition-[border-color,box-shadow] duration-150",
          "hover:border-line-strong focus-within:border-accent focus-within:shadow-[var(--focus-ring)]",
        )}
      >
        <AnimatePresence initial={false}>
          {values.map((v) => (
            <motion.span
              key={v}
              layout="position"
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.85, transition: transition.exit }}
              transition={spring.snappy}
              className={cn("inline-flex h-5 max-w-full items-center gap-0.5 rounded-[5px] bg-surface-sunken pr-0.5 pl-1.5 text-xs text-fg", mono && "font-mono text-[11px]")}
            >
              <span className="truncate">{v}</span>
              <button
                type="button"
                aria-label={`${v} kaldır`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="grid size-4 place-items-center rounded-[4px] text-fg-faint outline-none hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)] [&_svg]:size-3"
              >
                <X aria-hidden />
              </button>
            </motion.span>
          ))}
        </AnimatePresence>
        <input
          id={id}
          value={draft}
          aria-label={ariaLabel}
          placeholder={values.length ? "" : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => add(draft)}
          className={cn("h-5 min-w-16 flex-1 bg-transparent px-0.5 text-xs text-fg outline-none placeholder:text-fg-faint focus-visible:shadow-none", mono && "font-mono text-[11px]")}
        />
      </div>
      {open.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {open.map((sug) => (
            <button
              key={sug}
              type="button"
              onClick={() => onChange([...values, sug])}
              className="inline-flex h-5 items-center rounded-full border border-dashed border-line-strong px-2 font-mono text-[11px] text-fg-muted outline-none transition-colors hover:border-accent hover:text-accent focus-visible:shadow-[var(--focus-ring)]"
            >
              + {sug}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProviderPicker({ value, onChange, allowDefault = false, id }: { value: Provider | null; onChange: (v: Provider | null) => void; allowDefault?: boolean; id?: string }) {
  type V = Provider | "default";
  const options = [
    ...(allowDefault ? [{ value: "default" as V, label: "Varsayılan" }] : []),
    { value: "claude" as V, label: uiStrings.providers.claude, icon: <ProviderMark provider="claude" size={14} label="" /> },
    { value: "codex" as V, label: uiStrings.providers.codex, icon: <ProviderMark provider="codex" size={14} label="" /> },
  ];
  return (
    <div id={id}>
      <SegmentedControl<V> size="sm" fullWidth aria-label="Sağlayıcı" value={value ?? "default"} onValueChange={(v) => onChange(v === "default" ? null : v)} options={options} />
    </div>
  );
}

const EFFORTS: Record<Provider, { value: string; label: string }[]> = {
  claude: [
    { value: "low", label: "Düşük" },
    { value: "medium", label: "Orta" },
    { value: "high", label: "Yüksek" },
    { value: "xhigh", label: "Çok yüksek" },
    { value: "max", label: "En yüksek" },
  ],
  codex: [
    { value: "minimal", label: "En az" },
    { value: "low", label: "Düşük" },
    { value: "medium", label: "Orta" },
    { value: "high", label: "Yüksek" },
  ],
};

export function EffortSelect({ provider, value, onChange, id }: { provider: Provider | null; value: string | null; onChange: (v: string | null) => void; id?: string }) {
  const list = EFFORTS[provider ?? "claude"];
  const options: SelectOption[] = [{ value: "", label: "Varsayılan" }, ...list];
  if (value && !list.some((o) => o.value === value)) options.push({ value, label: value });
  return <Select id={id} size="sm" aria-label="Efor" value={value ?? ""} onValueChange={(v) => onChange(v || null)} options={options} className="w-full" />;
}

export function ProfileSelect({
  profiles,
  value,
  onChange,
  placeholder,
  emptyLabel,
  filter,
  id,
  "aria-label": ariaLabel,
}: {
  profiles: AgentProfile[];
  value: string | null;
  onChange: (v: string | null) => void;
  placeholder?: string;
  emptyLabel: string;
  filter?: (p: AgentProfile) => boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const list = filter ? profiles.filter(filter) : profiles;
  const options: SelectOption[] = [
    { value: "", label: emptyLabel },
    ...list.map((p) => ({
      value: p.id,
      label: p.name,
      description: [uiStrings.providers[p.provider], p.model, uiStrings.agentRole[p.role]].filter(Boolean).join(" · "),
      icon: <ProviderMark provider={p.provider} size={14} label="" />,
    })),
  ];
  if (value && !list.some((p) => p.id === value)) options.push({ value, label: value, description: "Bulunamadı" });
  return <Select id={id} size="sm" aria-label={ariaLabel} placeholder={placeholder} value={value ?? ""} onValueChange={(v) => onChange(v || null)} options={options} className="w-full" />;
}

/** Model text field with quick picks from the profiles known for this provider. */
export function ModelInput({ value, onChange, suggestions, id, placeholder }: { value: string | null; onChange: (v: string | null) => void; suggestions: string[]; id?: string; placeholder: string }) {
  const picks = [...new Set(suggestions)].filter((m) => m !== value).slice(0, 4);
  return (
    <div className="flex flex-col gap-1.5">
      <Input id={id} size="sm" className="font-mono text-[11px] placeholder:font-sans placeholder:text-xs" value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value.trim() ? e.target.value : null)} />
      {picks.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {picks.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onChange(m)}
              className="inline-flex h-5 items-center rounded-full bg-surface-sunken px-2 font-mono text-[11px] text-fg-muted outline-none transition-colors hover:bg-accent-soft hover:text-accent focus-visible:shadow-[var(--focus-ring)]"
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Checkbox group over a fixed option list. */
export function CheckGroup<V extends string>({ options, value, onChange, columns = 2 }: { options: { value: V; label: string; description?: string }[]; value: V[]; onChange: (v: V[]) => void; columns?: 1 | 2 }) {
  return (
    <div className={cn("grid gap-x-3 gap-y-2", columns === 2 ? "grid-cols-2" : "grid-cols-1")}>
      {options.map((o) => (
        <Checkbox
          key={o.value}
          label={o.label}
          description={o.description}
          checked={value.includes(o.value)}
          onCheckedChange={(on) => onChange(on ? [...value, o.value] : value.filter((x) => x !== o.value))}
        />
      ))}
    </div>
  );
}

/** "All / only selected" choice in front of a nullable list (null = all). */
export function AllOrPick({ all, pick, isAll, onChange }: { all: string; pick: string; isAll: boolean; onChange: (all: boolean) => void }) {
  return (
    <SegmentedControl
      size="sm"
      fullWidth
      aria-label={`${all} / ${pick}`}
      value={isAll ? "all" : "pick"}
      onValueChange={(v) => onChange(v === "all")}
      options={[
        { value: "all", label: all },
        { value: "pick", label: pick },
      ]}
    />
  );
}
