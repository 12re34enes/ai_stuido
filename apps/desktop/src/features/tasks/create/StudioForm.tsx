/**
 * A studio's input form inside the composer (spec §16): text, textarea, select, repo, branch, host,
 * db and deploy_profile inputs. Target inputs only list hosts/profiles of the input's environment;
 * picking a production or test target raises the matching environment context (red frame).
 */
import { motion } from "motion/react";
import { useMemo, type Ref } from "react";

import { useEnvironmentScope } from "@/lib/environment";
import type { Environment } from "@/lib/types";
import { spring } from "@/motion/tokens";
import { Field, Input, Select, Textarea, cn, uiStrings, type SelectOption } from "@/ui";

import { inputDefault, type FieldErrors } from "./buildTask";
import { useBranches, useTargets, type TargetKind } from "./queries";
import { createStrings as s } from "./strings";
import type { Repo, Studio, StudioInput } from "./types";

const TARGET_KINDS: TargetKind[] = ["host", "db", "deploy_profile"];

const ENV_DOT: Record<Environment, string> = {
  local: "bg-env-local",
  test: "bg-env-test",
  production: "bg-env-production",
};

export interface StudioFormProps {
  studio: Studio;
  values: Record<string, string>;
  errors: FieldErrors;
  onChange: (name: string, value: string) => void;
  workspaceId: string;
  repos: Repo[];
  /** Repo the composer targets (for branch inputs when the studio has no repo input). */
  fallbackRepoId: string | null;
  firstFieldRef?: Ref<HTMLTextAreaElement | HTMLInputElement>;
}

function wide(input: StudioInput): boolean {
  return input.type === "textarea";
}

function TargetSelect({
  input,
  kind,
  value,
  workspaceId,
  invalid,
  onChange,
}: {
  input: StudioInput;
  kind: TargetKind;
  value: string;
  workspaceId: string;
  invalid: boolean;
  onChange: (v: string) => void;
}) {
  const env = (input.environment ?? null) as Environment | null;
  const { data = [], isLoading } = useTargets(kind, workspaceId, env);
  const selected = data.find((t) => t.id === value);
  useEnvironmentScope(selected && selected.environment !== "local" ? selected.environment : null, selected?.name);
  const options: SelectOption[] = data.map((t) => ({
    value: t.id,
    label: t.name,
    description: [uiStrings.environment[t.environment], t.detail].filter(Boolean).join(" · "),
    icon: <span aria-hidden className={cn("size-2 rounded-full", ENV_DOT[t.environment])} />,
  }));
  const envLabel = env ? uiStrings.environment[env] : null;
  return (
    <Select
      id={`studio-${input.name}`}
      aria-label={input.label}
      value={value || undefined}
      onValueChange={onChange}
      options={options}
      invalid={invalid}
      disabled={isLoading || options.length === 0}
      placeholder={isLoading ? uiStrings.loading : options.length === 0 ? (envLabel ? s.studio.noTargetsEnv(envLabel) : s.studio.noTargets) : s.studio.selectOption}
    />
  );
}

function BranchSelect({ input, repoId, value, invalid, onChange }: { input: StudioInput; repoId: string | null; value: string; invalid: boolean; onChange: (v: string) => void }) {
  const { data, isLoading } = useBranches(repoId);
  const options: SelectOption[] = useMemo(() => {
    if (!data) return [];
    const local = data.local.map((b) => ({ value: b.name, label: b.name, description: b.is_default ? s.branch.default(b.name) : b.subject || undefined }));
    const known = new Set(local.map((o) => o.value));
    const remote = data.remote.filter((b) => !known.has(b.name.replace(/^[^/]+\//, ""))).map((b) => ({ value: b.name, label: b.name, description: s.branch.remote }));
    return [...local, ...remote];
  }, [data]);
  return (
    <Select
      id={`studio-${input.name}`}
      aria-label={input.label}
      value={value || undefined}
      onValueChange={onChange}
      options={options}
      invalid={invalid}
      disabled={!repoId || isLoading}
      placeholder={!repoId ? s.studio.branchNeedsRepo : isLoading ? s.branch.loading : s.studio.selectOption}
    />
  );
}

export function StudioForm({ studio, values, errors, onChange, workspaceId, repos, fallbackRepoId, firstFieldRef }: StudioFormProps) {
  const value = (input: StudioInput) => values[input.name] ?? inputDefault(input);
  const repoInput = studio.inputs.find((i) => i.type === "repo");
  const branchRepo = (repoInput ? value(repoInput) : "") || fallbackRepoId;
  const repoOptions: SelectOption[] = repos.map((r) => ({ value: r.id, label: r.name, description: r.path }));
  const firstTextIndex = studio.inputs.findIndex((i) => i.type === "text" || i.type === "textarea");

  return (
    <motion.div
      className="grid grid-cols-2 gap-x-3 gap-y-3.5"
      role="group"
      aria-label={s.studio.formLabel(studio.name)}
      initial="initial"
      animate="animate"
      variants={{ animate: { transition: { staggerChildren: 0.03 } } }}
    >
      {studio.inputs.map((input, i) => {
        const id = `studio-${input.name}`;
        const err = errors[`input.${input.name}`];
        const v = value(input);
        const isFirst = i === firstTextIndex;
        let control;
        if (input.type === "textarea") {
          control = (
            <Textarea
              id={id}
              ref={isFirst ? (firstFieldRef as Ref<HTMLTextAreaElement>) : undefined}
              value={v}
              onChange={(e) => onChange(input.name, e.target.value)}
              minRows={isFirst ? 3 : 2}
              maxRows={10}
              invalid={!!err}
            />
          );
        } else if (input.type === "select") {
          control = (
            <Select
              id={id}
              aria-label={input.label}
              value={v || undefined}
              onValueChange={(nv) => onChange(input.name, nv)}
              options={(input.options ?? []).map((o) => ({ value: o, label: o }))}
              invalid={!!err}
            />
          );
        } else if (input.type === "repo") {
          control = (
            <Select
              id={id}
              aria-label={input.label}
              value={v || undefined}
              onValueChange={(nv) => onChange(input.name, nv)}
              options={repoOptions}
              invalid={!!err}
              disabled={repoOptions.length === 0}
              placeholder={repoOptions.length === 0 ? s.repos.none : s.studio.selectOption}
            />
          );
        } else if (input.type === "branch") {
          control = <BranchSelect input={input} repoId={branchRepo} value={v} invalid={!!err} onChange={(nv) => onChange(input.name, nv)} />;
        } else if ((TARGET_KINDS as string[]).includes(input.type)) {
          control = (
            <TargetSelect
              input={input}
              kind={input.type as TargetKind}
              value={v}
              workspaceId={workspaceId}
              invalid={!!err}
              onChange={(nv) => onChange(input.name, nv)}
            />
          );
        } else {
          control = (
            <Input
              id={id}
              ref={isFirst ? (firstFieldRef as Ref<HTMLInputElement>) : undefined}
              value={v}
              onChange={(e) => onChange(input.name, e.target.value)}
              invalid={!!err}
            />
          );
        }
        const envNote = input.environment ? s.studio.onlyEnv(uiStrings.environment[input.environment]) : null;
        return (
          <motion.div
            key={input.name}
            variants={{ initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0, transition: spring.smooth } }}
            className={cn(wide(input) ? "col-span-2" : "col-span-2 sm:col-span-1")}
          >
            <Field
              label={
                <span className="inline-flex items-center gap-1.5">
                  {input.label}
                  {envNote && <span className="font-normal text-fg-faint">· {envNote}</span>}
                </span>
              }
              htmlFor={id}
              required={input.required}
              hint={input.help ?? undefined}
              error={err}
            >
              {control}
            </Field>
          </motion.div>
        );
      })}
    </motion.div>
  );
}
