import { Database, FolderGit2, GitBranch, Rocket, Server } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Environment } from "@/lib/types";
import { EnvBadge, Field, Input, Select, Textarea, type SelectOption } from "@/ui";

import { useBranches, useDbProfiles, useDeployProfiles, useHosts, useRepos } from "../api";
import { branchRepo, fieldKind, forEnvironment, isRequired, type FormValues } from "../form";
import { environmentLabels, studioStrings as s } from "../strings";
import type { BranchInfo, StudioInput } from "../types";

export interface InputFieldProps {
  input: StudioInput;
  /** Every input of the studio (a branch picker follows the repo input). */
  inputs: StudioInput[];
  values: FormValues;
  error?: string | null;
  workspaceId: string;
  onChange: (name: string, value: string) => void;
  onBlur?: (name: string) => void;
}

function FieldLabel({ input }: { input: StudioInput }) {
  return (
    <span className="flex w-full items-center gap-1.5">
      <span>{input.label}</span>
      {isRequired(input) ? (
        <span className="text-danger" aria-hidden>
          *
        </span>
      ) : (
        <span className="font-normal text-fg-faint">· {s.optional}</span>
      )}
      {input.environment && (
        <EnvBadge environment={input.environment} label={s.onlyEnvironment(environmentLabels[input.environment] ?? input.environment)} className="ml-auto" />
      )}
    </span>
  );
}

function ManageLink() {
  return (
    <Link to="/connections" className="text-accent underline decoration-accent/35 underline-offset-2 hover:decoration-accent">
      {s.manageConnections}
    </Link>
  );
}

interface PickerState {
  options: SelectOption[];
  loading: boolean;
  failed: boolean;
  empty: ReactNode;
  placeholder: string;
}

/** Options for the resource pickers (repo, branch, host, db, deploy profile), filtered by environment. */
function usePicker(input: StudioInput, inputs: StudioInput[], values: FormValues, workspaceId: string): PickerState | null {
  const kind = fieldKind(input);
  const env = input.environment as Environment | null | undefined;
  const envLabel = env ? environmentLabels[env] : undefined;
  const branchFor = kind === "branch" ? branchRepo(inputs, values) : undefined;
  const repos = useRepos(kind === "repo" ? workspaceId : undefined);
  const branches = useBranches(branchFor);
  const hosts = useHosts(workspaceId, kind === "host");
  const dbs = useDbProfiles(workspaceId, kind === "db");
  const profiles = useDeployProfiles(workspaceId, kind === "deploy_profile");

  switch (kind) {
    case "repo":
      return {
        options: (repos.data ?? []).map((r) => ({ value: r.id, label: r.name, description: r.path, icon: <FolderGit2 /> })),
        loading: repos.isPending,
        failed: repos.isError,
        empty: s.noRepos,
        placeholder: s.selectRepo,
      };
    case "branch": {
      if (!branchFor) return { options: [], loading: false, failed: false, empty: s.selectFirstRepo, placeholder: s.selectFirstRepo };
      const data = branches.data;
      const local = data?.local ?? [];
      const remote = (data?.remote ?? []).filter((b) => !local.some((l) => b.name.endsWith(`/${l.name}`)));
      const list: BranchInfo[] = [...local, ...remote];
      return {
        options: list.map((b) => {
          const isDefault = b.is_default || b.name === data?.default_branch;
          const detail = [isDefault ? s.defaultBranch : "", b.subject ?? ""].filter(Boolean).join(" · ");
          return { value: b.name, label: b.name, description: detail || undefined, icon: <GitBranch /> };
        }),
        loading: branches.isPending,
        failed: branches.isError,
        empty: s.noBranches,
        placeholder: s.selectBranch,
      };
    }
    case "host":
      return {
        options: forEnvironment(hosts.data ?? [], env).map((h) => ({
          value: h.id,
          label: h.name,
          description: `${h.username ? `${h.username}@` : ""}${h.hostname} · ${environmentLabels[h.environment]}`,
          icon: <Server />,
        })),
        loading: hosts.isPending,
        failed: hosts.isError,
        empty: (
          <>
            {s.noHosts(envLabel)} · <ManageLink />
          </>
        ),
        placeholder: s.selectHost,
      };
    case "db":
      return {
        options: forEnvironment(dbs.data ?? [], env).map((d) => ({
          value: d.id,
          label: d.name,
          description: `${d.kind}${d.database ? ` · ${d.database}` : ""} · ${environmentLabels[d.environment]}`,
          icon: <Database />,
        })),
        loading: dbs.isPending,
        failed: dbs.isError,
        empty: (
          <>
            {s.noDbs(envLabel)} · <ManageLink />
          </>
        ),
        placeholder: s.selectDb,
      };
    case "deploy_profile":
      return {
        options: forEnvironment(profiles.data ?? [], env).map((p) => ({
          value: p.id,
          label: p.name,
          description: `${p.kind} · ${environmentLabels[p.environment]}`,
          icon: <Rocket />,
        })),
        loading: profiles.isPending,
        failed: profiles.isError,
        empty: (
          <>
            {s.noProfiles(envLabel)} · <ManageLink />
          </>
        ),
        placeholder: s.selectProfile,
      };
    default:
      return null;
  }
}

/** One generated form field. Pickers degrade to free text when their list cannot be fetched. */
export function InputField({ input, inputs, values, error, workspaceId, onChange, onBlur }: InputFieldProps) {
  const kind = fieldKind(input);
  const picker = usePicker(input, inputs, values, workspaceId);
  const id = `studio-input-${input.name}`;
  const value = values[input.name] ?? "";
  const set = (v: string) => onChange(input.name, v);
  const placeholder = typeof input.default === "string" && input.default ? input.default : undefined;

  let control: ReactNode;
  let hint: ReactNode = input.help ?? undefined;

  if (kind === "textarea") {
    control = (
      <Textarea
        id={id}
        value={value}
        minRows={3}
        maxRows={10}
        invalid={!!error}
        placeholder={placeholder}
        onChange={(e) => set(e.target.value)}
        onBlur={() => onBlur?.(input.name)}
      />
    );
  } else if (kind === "select") {
    const options: SelectOption[] = (input.options ?? []).map((o) => ({ value: o, label: o }));
    if (!isRequired(input) && !input.default) options.unshift({ value: "", label: s.none });
    control = <Select id={id} value={value} onValueChange={set} options={options} invalid={!!error} aria-label={input.label} />;
  } else if (picker && !picker.failed) {
    const empty = !picker.loading && picker.options.length === 0;
    const options = !isRequired(input) && picker.options.length ? [{ value: "", label: s.none }, ...picker.options] : picker.options;
    control = (
      <Select
        id={id}
        value={value || undefined}
        onValueChange={set}
        options={options}
        invalid={!!error}
        disabled={picker.loading || empty}
        placeholder={picker.loading ? s.empty : empty ? (typeof picker.empty === "string" ? picker.empty : picker.placeholder) : picker.placeholder}
        aria-label={input.label}
      />
    );
    if (empty && typeof picker.empty !== "string") hint = picker.empty;
  } else {
    control = (
      <Input id={id} value={value} invalid={!!error} placeholder={placeholder} onChange={(e) => set(e.target.value)} onBlur={() => onBlur?.(input.name)} />
    );
    if (picker?.failed) hint = s.pickerUnavailable;
  }

  return (
    <Field label={<FieldLabel input={input} />} htmlFor={id} error={error} hint={hint}>
      {control}
    </Field>
  );
}
