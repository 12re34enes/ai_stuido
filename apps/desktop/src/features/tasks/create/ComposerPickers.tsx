/** Studio, repo and base-branch pickers of the composer toolbar. */
import { Check, FolderGit2, GitBranch, Sparkles } from "lucide-react";
import { AnimatePresence } from "motion/react";
import { createElement, useMemo } from "react";

import { cn, Tooltip } from "@/ui";

import { Chip, ClearButton, PickerPopover, type PickerItem } from "./Picker";
import { repoSummary, shortPath, toggleRepo } from "./pickerLogic";
import { useBranches } from "./queries";
import { createStrings as s } from "./strings";
import { studioIcon } from "./icons";
import type { Repo, Studio } from "./types";

// ----------------------------------------------------------------------------- studio

export function StudioPicker({
  studios,
  value,
  onChange,
  loading,
  error,
}: {
  studios: Studio[];
  value: Studio | null;
  onChange: (id: string | null) => void;
  loading?: boolean;
  error?: boolean;
}) {
  const items: PickerItem[] = [
    { value: "", label: s.studio.none, description: s.studio.noneHint, icon: <Sparkles className="opacity-40" /> },
    ...studios.map((st) => ({
      value: st.id,
      label: st.name,
      description: st.description,
      icon: createElement(studioIcon(st.icon)),
      keywords: st.id,
    })),
  ];
  return (
    <span className="inline-flex items-center gap-0.5">
      <PickerPopover
        label={s.studio.button}
        items={items}
        selected={[value?.id ?? ""]}
        onSelect={(v) => onChange(v || null)}
        searchPlaceholder={s.studio.search}
        emptyText={s.studio.empty}
        loading={loading}
        error={error ? s.studio.loadFailed : null}
        width={340}
        trigger={
          <Chip icon={createElement(value ? studioIcon(value.icon) : Sparkles)} active={!!value} aria-label={value ? `${s.studio.button}: ${value.name}` : s.studio.button}>
            {value?.name ?? s.studio.button}
          </Chip>
        }
      />
      <AnimatePresence>{value && <ClearButton key="clear" label={s.studio.clear} onClick={() => onChange(null)} />}</AnimatePresence>
    </span>
  );
}

// ----------------------------------------------------------------------------- repos

export function RepoPicker({
  repos,
  value,
  onChange,
  loading,
}: {
  repos: Repo[];
  value: string[] | null;
  onChange: (v: string[] | null) => void;
  loading?: boolean;
}) {
  const summary = repoSummary(repos, value);
  if (repos.length <= 1) {
    return (
      <Chip icon={<FolderGit2 />} caret={false} active={repos.length === 1} disabled={repos.length === 0} aria-label={`${s.repos.button}: ${summary}`} tabIndex={-1}>
        {loading ? "…" : summary}
      </Chip>
    );
  }
  const selected = value ?? repos.map((r) => r.id);
  const items: PickerItem[] = repos.map((r) => ({
    value: r.id,
    label: r.name,
    description: shortPath(r.path),
    trailing: r.default_branch,
    disabled: selected.length === 1 && selected[0] === r.id,
    keywords: r.path,
  }));
  const all = value === null;
  return (
    <PickerPopover
      label={s.repos.button}
      multiple
      items={items}
      selected={selected}
      onSelect={(id) => onChange(toggleRepo(repos, value, id))}
      searchPlaceholder={s.repos.search}
      emptyText={s.repos.empty}
      searchable={repos.length > 6}
      width={320}
      header={
        <button
          type="button"
          role="option"
          aria-selected={all}
          onClick={() => onChange(null)}
          className="flex min-h-8 w-full items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-left text-sm outline-none transition-colors duration-100 hover:bg-surface-hover focus-visible:bg-surface-hover"
        >
          <span
            aria-hidden
            className={cn(
              "grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors duration-150",
              all ? "border-accent bg-accent text-fg-on-accent" : "border-line-strong bg-surface",
            )}
          >
            {all && <Check className="size-3" strokeWidth={3} />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-fg">{s.repos.all}</span>
            <span className="text-xs text-fg-muted">{s.repos.allHint}</span>
          </span>
        </button>
      }
      trigger={
        <Chip icon={<FolderGit2 />} active={!all} aria-label={`${s.repos.button}: ${summary}`}>
          {summary}
        </Chip>
      }
    />
  );
}

// ----------------------------------------------------------------------------- branch

export function BranchPicker({
  repo,
  value,
  onChange,
  disabledReason,
}: {
  /** The single repo whose branches are offered; null disables the picker. */
  repo: Repo | null;
  value: string | null;
  onChange: (v: string | null) => void;
  disabledReason?: string;
}) {
  const { data, isLoading, isError } = useBranches(repo?.id);
  const defaultBranch = data?.default_branch ?? repo?.default_branch ?? "main";
  const items = useMemo<PickerItem[]>(() => {
    if (!data) return [];
    const local = data.local.map((b) => ({
      value: b.name,
      label: b.name,
      description: b.subject || undefined,
      group: s.branch.local,
      trailing: b.is_default ? s.branch.defaultTag : undefined,
    }));
    const known = new Set(local.map((b) => b.value));
    const remote = data.remote
      .filter((b) => !b.name.endsWith("/HEAD") && !known.has(b.name.replace(/^[^/]+\//, "")))
      .map((b) => ({ value: b.name, label: b.name, description: b.subject || undefined, group: s.branch.remote }));
    return [...local, ...remote];
  }, [data]);

  const label = value ?? defaultBranch;
  if (!repo) {
    return (
      <Tooltip content={disabledReason} side="bottom" disabled={!disabledReason}>
        <span className="inline-flex" tabIndex={disabledReason ? 0 : -1} aria-label={disabledReason}>
          <Chip icon={<GitBranch />} caret={false} disabled>
            {s.branch.button}
          </Chip>
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      <PickerPopover
        label={s.branch.label}
        items={items}
        selected={[label]}
        onSelect={(v) => onChange(v === defaultBranch ? null : v)}
        searchPlaceholder={s.branch.search}
        emptyText={s.branch.empty}
        loading={isLoading}
        error={isError ? s.branch.loadFailed : null}
        width={320}
        trigger={
          <Chip icon={<GitBranch />} active={value !== null} aria-label={`${s.branch.label}: ${label}`} className="font-mono">
            {label}
          </Chip>
        }
      />
      <AnimatePresence>{value && <ClearButton key="clear" label={s.branch.default(defaultBranch)} onClick={() => onChange(null)} />}</AnimatePresence>
    </span>
  );
}
