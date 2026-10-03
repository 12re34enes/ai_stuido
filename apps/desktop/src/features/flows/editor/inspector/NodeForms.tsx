/**
 * Inspector forms for every NodeConfig kind and field (contracts/flows.py). Each form edits the
 * config through `update(patch)`; the store coalesces typing into single undo steps.
 */
import { Lock, Wrench } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useMemo, useState, type ReactNode } from "react";

import { isMissingEndpoint } from "@/lib/connection";
import { spring, transition } from "@/motion/tokens";
import { Badge, Checkbox, EnvBadge, Input, SegmentedControl, Select, Skeleton, Switch, Textarea, type SelectOption } from "@/ui";
import { uiStrings } from "@/ui/strings";

import { useDeployProfiles, useTools } from "../../api";
import { errorText } from "../../util";
import { defaultBoundaries } from "../../model/kinds";
import { buildTopology, upstream } from "../../model/topology";
import {
  gateStrings,
  mergeStrategyStrings,
  outputFormatStrings,
  remoteAccessStrings,
  s,
  sandboxStrings,
  severityStrings,
  synthesisFormatStrings,
} from "../../strings";
import {
  GATE_KINDS,
  REPO_COMMAND_KEYS,
  type AdvisorNodeConfig,
  type AgentNodeConfig,
  type AgentOutputFormat,
  type Boundaries,
  type CompareNodeConfig,
  type ConditionNodeConfig,
  type DeployNodeConfig,
  type GateKind,
  type GateNodeConfig,
  type GitNodeConfig,
  type HumanNodeConfig,
  type JoinNodeConfig,
  type MergeNodeConfig,
  type MergeStrategy,
  type ModelConfig,
  type NodeConfig,
  type RemoteAccess,
  type SandboxLevel,
  type SynthesisNodeConfig,
  type SynthesisOutputFormat,
} from "../../types";
import { PromptEditor } from "../code/PromptEditor";
import { resolveProvider, useEditorEnv } from "../context";
import { useEditor } from "../store";
import { useGraphStructure, useTemplateVars } from "../useTemplateVars";
import { AllOrPick, CheckGroup, EffortSelect, FormField, ModelInput, NumberInput, ProfileSelect, ProviderPicker, Section, TagInput } from "./controls";
import { ROLE_OPTIONS, SEVERITIES } from "./options";

export interface FormProps<C extends NodeConfig> {
  id: string;
  config: C;
  update: (patch: Partial<C>) => void;
}

function useFieldId(name: string) {
  return `${useId()}-${name}`;
}

/** Smooth height-free reveal for conditional fields (opacity + small slide). */
function Reveal({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0, transition: spring.smooth }}
          exit={{ opacity: 0, transition: transition.exit }}
          className="flex flex-col gap-3"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ----------------------------------------------------------------------------- model / profile

function ModelSection<C extends ModelConfig>({ config, update, withEffort = true, withRole = false }: FormProps<C> & { withEffort?: boolean; withRole?: boolean }) {
  const env = useEditorEnv();
  const profileId = useFieldId("profile");
  const modelId = useFieldId("model");
  const effortId = useFieldId("effort");
  const roleId = useFieldId("role");
  const profile = config.profile_id ? env.profilesById.get(config.profile_id) : undefined;
  const provider = resolveProvider(config, env.profilesById);
  const modelSuggestions = env.profiles.filter((p) => p.provider === (provider ?? "claude") && p.model).map((p) => p.model!);
  return (
    <Section title={s.inspector.model}>
      <FormField label={s.inspector.profile} htmlFor={profileId} hint={config.profile_id ? undefined : s.inspector.profileHint}>
        <ProfileSelect
          id={profileId}
          aria-label={s.inspector.profile}
          profiles={env.profiles}
          value={config.profile_id}
          emptyLabel={s.inspector.noProfile}
          onChange={(v) => {
            if (v) update({ profile_id: v, provider: null, model: null, ...(withEffort ? { effort: null } : {}) } as Partial<C>);
            else update({ profile_id: null, provider: profile?.provider ?? config.provider ?? "claude", model: profile?.model ?? null } as Partial<C>);
          }}
        />
      </FormField>
      <AnimatePresence initial={false} mode="popLayout">
        {profile ? (
          <motion.div
            key="from-profile"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: transition.exit }}
            className="flex flex-wrap items-center gap-1.5 rounded-md bg-surface-sunken px-2.5 py-2 text-xs text-fg-muted"
          >
            <Badge tone={profile.provider}>{uiStrings.providers[profile.provider]}</Badge>
            {profile.model && <span className="font-mono text-[11px] text-fg">{profile.model}</span>}
            {profile.effort && <span>· {profile.effort}</span>}
            <span>· {uiStrings.agentRole[profile.role]}</span>
          </motion.div>
        ) : (
          <motion.div key="manual" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: transition.exit }} className="flex flex-col gap-3">
            <FormField label={s.inspector.provider}>
              <ProviderPicker value={config.provider} allowDefault={config.provider === null} onChange={(p) => update({ provider: p } as Partial<C>)} />
            </FormField>
            <div className="grid grid-cols-2 gap-3">
              <FormField label={s.inspector.modelLabel} htmlFor={modelId} className={withEffort ? undefined : "col-span-2"}>
                <ModelInput id={modelId} value={config.model} placeholder={s.inspector.modelPlaceholder} suggestions={modelSuggestions} onChange={(m) => update({ model: m } as Partial<C>)} />
              </FormField>
              {withEffort && "effort" in config && (
                <FormField label={s.inspector.effort} htmlFor={effortId}>
                  <EffortSelect id={effortId} provider={config.provider} value={config.effort} onChange={(e) => update({ effort: e } as unknown as Partial<C>)} />
                </FormField>
              )}
            </div>
            {withRole && config.kind === "agent" && (
              <FormField label={s.inspector.role} htmlFor={roleId}>
                <Select id={roleId} size="sm" aria-label={s.inspector.role} value={config.role} options={ROLE_OPTIONS} onValueChange={(r) => update({ role: r } as unknown as Partial<C>)} className="w-full" />
              </FormField>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

function PromptSection({
  nodeId,
  value,
  onChange,
  hint,
  placeholder,
  title = s.inspector.prompt,
}: {
  nodeId: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  title?: string;
}) {
  const { vars, nodeIds } = useTemplateVars(nodeId);
  const id = useFieldId("prompt");
  return (
    <Section title={title} description={hint ?? s.inspector.promptHint}>
      <PromptEditor id={id} aria-label={title} value={value} onChange={onChange} variables={vars} nodeIds={nodeIds} placeholder={placeholder} minLines={5} maxHeight={360} />
    </Section>
  );
}

// ----------------------------------------------------------------------------- agent

function BoundariesEditor({ value, onChange }: { value: Boundaries | null; onChange: (b: Boundaries | null) => void }) {
  const b = value ?? defaultBoundaries();
  const set = (patch: Partial<Boundaries>) => onChange({ ...b, ...patch });
  const ids = { f: useFieldId("forbidden"), r: useFieldId("readonly"), a: useFieldId("allowed"), d: useFieldId("denied"), sb: useFieldId("sandbox"), ra: useFieldId("remote") };
  return (
    <Section title={s.inspector.boundaries} description={s.inspector.boundariesHint} action={<Switch size="sm" aria-label={s.inspector.boundaries} checked={value !== null} onCheckedChange={(on) => onChange(on ? defaultBoundaries() : null)} />}>
      <Reveal show={value !== null}>
        <FormField label={s.inspector.forbiddenPaths} htmlFor={ids.f}>
          <TagInput id={ids.f} aria-label={s.inspector.forbiddenPaths} values={b.forbidden_paths} placeholder={s.inspector.pathPlaceholder} onChange={(v) => set({ forbidden_paths: v })} />
        </FormField>
        <FormField label={s.inspector.readonlyPaths} htmlFor={ids.r}>
          <TagInput id={ids.r} aria-label={s.inspector.readonlyPaths} values={b.readonly_paths} placeholder={s.inspector.pathPlaceholder} onChange={(v) => set({ readonly_paths: v })} />
        </FormField>
        <FormField label={s.inspector.allowedCommands} htmlFor={ids.a}>
          <TagInput id={ids.a} aria-label={s.inspector.allowedCommands} values={b.allowed_commands} placeholder={s.inspector.commandPlaceholder} onChange={(v) => set({ allowed_commands: v })} />
        </FormField>
        <FormField label={s.inspector.deniedCommands} htmlFor={ids.d}>
          <TagInput id={ids.d} aria-label={s.inspector.deniedCommands} values={b.denied_commands} placeholder={s.inspector.commandPlaceholder} onChange={(v) => set({ denied_commands: v })} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={s.inspector.sandbox} htmlFor={ids.sb}>
            <Select<SandboxLevel>
              id={ids.sb}
              size="sm"
              aria-label={s.inspector.sandbox}
              value={b.sandbox}
              className="w-full"
              options={(Object.keys(sandboxStrings) as SandboxLevel[]).map((v) => ({ value: v, label: sandboxStrings[v] }))}
              onValueChange={(v) => set({ sandbox: v })}
            />
          </FormField>
          <FormField label={s.inspector.remoteAccess} htmlFor={ids.ra}>
            <Select<RemoteAccess>
              id={ids.ra}
              size="sm"
              aria-label={s.inspector.remoteAccess}
              value={b.remote_access}
              className="w-full"
              options={(Object.keys(remoteAccessStrings) as RemoteAccess[]).map((v) => ({ value: v, label: remoteAccessStrings[v] }))}
              onValueChange={(v) => set({ remote_access: v })}
            />
          </FormField>
        </div>
        <Switch label={s.inspector.network} checked={b.network} onCheckedChange={(on) => set({ network: on })} />
      </Reveal>
    </Section>
  );
}

function ReposPicker({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const env = useEditorEnv();
  return (
    <Section title={s.inspector.repos}>
      <AllOrPick all={s.inspector.allRepos} pick={s.inspector.pickRepos} isAll={value === null} onChange={(all) => onChange(all ? null : [])} />
      <Reveal show={value !== null}>
        {env.repos.length === 0 ? (
          <p className="text-xs text-fg-muted">{s.inspector.reposEmpty}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {env.repos.map((r) => (
              <Checkbox
                key={r.id}
                label={r.name}
                description={r.path}
                checked={value?.includes(r.id) ?? false}
                onCheckedChange={(on) => onChange(on ? [...(value ?? []), r.id] : (value ?? []).filter((x) => x !== r.id))}
              />
            ))}
          </div>
        )}
      </Reveal>
    </Section>
  );
}

function ToolsPicker({ value, onChange }: { value: string[] | null; onChange: (v: string[] | null) => void }) {
  const tools = useTools(value !== null);
  const id = useFieldId("tools");
  return (
    <Section title={s.inspector.tools}>
      <AllOrPick all={s.inspector.allTools} pick={s.inspector.pickTools} isAll={value === null} onChange={(all) => onChange(all ? null : [])} />
      <Reveal show={value !== null}>
        {tools.isPending ? (
          <div className="flex flex-col gap-2">
            <Skeleton height={14} width="70%" />
            <Skeleton height={14} width="55%" />
          </div>
        ) : tools.isError ? (
          <FormField label={s.inspector.toolsError} htmlFor={id}>
            <TagInput id={id} aria-label={s.inspector.tools} values={value ?? []} onChange={onChange} placeholder="studio_memory_read" />
          </FormField>
        ) : (
          <div className="flex flex-col gap-2">
            {(tools.data ?? []).map((t) => (
              <Checkbox
                key={t.name}
                label={
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono text-[11px]">{t.name}</span>
                    {t.mutating && <Badge tone="warning" icon={<Wrench />}>yazar</Badge>}
                  </span>
                }
                description={t.description}
                checked={value?.includes(t.name) ?? false}
                onCheckedChange={(on) => onChange(on ? [...(value ?? []), t.name] : (value ?? []).filter((x) => x !== t.name))}
              />
            ))}
          </div>
        )}
      </Reveal>
    </Section>
  );
}

export function AgentForm(props: FormProps<AgentNodeConfig>) {
  const { id, config, update } = props;
  const turnsId = useFieldId("turns");
  return (
    <>
      <ModelSection {...props} withRole />
      <PromptSection nodeId={id} value={config.prompt_template} onChange={(v) => update({ prompt_template: v })} />
      <Section title={s.inspector.behavior}>
        <FormField label={s.inspector.outputFormat}>
          <SegmentedControl<AgentOutputFormat>
            size="sm"
            fullWidth
            aria-label={s.inspector.outputFormat}
            value={config.output_format}
            onValueChange={(v) => update({ output_format: v })}
            options={(Object.keys(outputFormatStrings) as AgentOutputFormat[]).map((v) => ({ value: v, label: outputFormatStrings[v] }))}
          />
        </FormField>
        <Switch label={s.inspector.writes} description={s.inspector.writesHint} checked={config.writes} onCheckedChange={(on) => update({ writes: on })} />
        <FormField label={s.inspector.maxTurns} htmlFor={turnsId}>
          <NumberInput id={turnsId} value={config.max_turns} min={1} max={500} placeholder={s.inspector.unlimited} onChange={(v) => update({ max_turns: v })} />
        </FormField>
      </Section>
      <ReposPicker value={config.repo_ids} onChange={(v) => update({ repo_ids: v })} />
      <ToolsPicker value={config.tool_names} onChange={(v) => update({ tool_names: v })} />
      <BoundariesEditor value={config.boundaries} onChange={(b) => update({ boundaries: b })} />
    </>
  );
}

// ----------------------------------------------------------------------------- advisor

export function AdvisorForm(props: FormProps<AdvisorNodeConfig>) {
  const { id, config, update } = props;
  const perspectiveId = useFieldId("perspective");
  return (
    <>
      <ModelSection {...props} />
      <Section title={s.inspector.behavior}>
        <FormField label={s.inspector.perspective} htmlFor={perspectiveId}>
          <Input id={perspectiveId} size="sm" value={config.perspective} placeholder={s.inspector.perspectivePlaceholder} onChange={(e) => update({ perspective: e.target.value })} />
        </FormField>
        <Switch label={s.inspector.webAccess} description={s.inspector.webAccessHint} checked={config.web_access} onCheckedChange={(on) => update({ web_access: on })} />
      </Section>
      <PromptSection nodeId={id} value={config.prompt_template} onChange={(v) => update({ prompt_template: v })} />
    </>
  );
}

// ----------------------------------------------------------------------------- gate

function useAuthorProvider(nodeId: string, targetId: string | null) {
  const env = useEditorEnv();
  const { nodes, edges } = useGraphStructure();
  const authorId = useMemo(() => {
    if (targetId) return targetId;
    const topo = buildTopology(
      nodes.map((n) => n.id),
      edges,
    );
    return upstream(topo, nodeId).find((nid) => nodes.find((n) => n.id === nid)?.kind === "agent") ?? null;
  }, [edges, nodeId, nodes, targetId]);
  const author = useEditor((st) => (authorId ? st.nodes.find((n) => n.id === authorId)?.data.config : undefined));
  return author ? resolveProvider(author, env.profilesById) : null;
}

export function GateForm({ id, config, update }: FormProps<GateNodeConfig>) {
  const env = useEditorEnv();
  const { nodes } = useGraphStructure();
  const ids = { kind: useFieldId("gate"), cmd: useFieldId("cmd"), cmds: useFieldId("cmds"), rev: useFieldId("rev"), revModel: useFieldId("revModel"), focus: useFieldId("focus"), target: useFieldId("target"), rounds: useFieldId("rounds") };
  const authorProvider = useAuthorProvider(id, config.target_node_id);
  const reviewer = config.reviewer_profile_id ? env.profilesById.get(config.reviewer_profile_id) : undefined;
  const sameProvider = !!reviewer && !!authorProvider && reviewer.provider === authorProvider;
  const definedCommands = useMemo(() => {
    const keys = new Set<string>();
    for (const r of env.repos) for (const k of REPO_COMMAND_KEYS) if (r.commands?.[k]) keys.add(k);
    return keys.size ? [...keys] : ["lint", "typecheck", "test", "build"];
  }, [env.repos]);
  const gateOptions: SelectOption<GateKind>[] = GATE_KINDS.map((g) => ({
    value: g,
    label: gateStrings[g].label,
    description: gateStrings[g].description.split(".")[0],
    icon: g === "deploy_approval" ? <Lock /> : undefined,
  }));
  const targetOptions: SelectOption[] = [{ value: "", label: s.inspector.targetDefault }, ...nodes.filter((n) => n.id !== id).map((n) => ({ value: n.id, label: n.label || n.id, description: n.id }))];
  if (config.target_node_id && !nodes.some((n) => n.id === config.target_node_id)) targetOptions.push({ value: config.target_node_id, label: config.target_node_id, description: "Bulunamadı" });

  return (
    <>
      <Section title={s.inspector.gateKind}>
        <Select<GateKind> id={ids.kind} size="sm" aria-label={s.inspector.gateKind} value={config.gate} options={gateOptions} onValueChange={(g) => update({ gate: g })} className="w-full" />
        <p className="text-xs text-fg-muted">{gateStrings[config.gate].description}</p>
        <Reveal show={config.gate === "deploy_approval"}>
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-soft px-2.5 py-2 text-xs text-warning">
            <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>{s.inspector.gateLocked}</span>
          </div>
        </Reveal>
      </Section>

      <Reveal show={config.gate === "build_test"}>
        <Section title={s.inspector.commands}>
          <AllOrPick all={s.inspector.commandsAll} pick={s.inspector.commandsPick} isAll={config.commands === null} onChange={(all) => update({ commands: all ? null : [] })} />
          <Reveal show={config.commands !== null}>
            <TagInput id={ids.cmds} aria-label={s.inspector.commands} values={config.commands ?? []} suggestions={definedCommands} placeholder="test" onChange={(v) => update({ commands: v })} />
          </Reveal>
        </Section>
      </Reveal>

      <Reveal show={config.gate === "custom_command"}>
        <Section title={s.inspector.command}>
          <Input id={ids.cmd} size="sm" aria-label={s.inspector.command} className="font-mono text-[11px]" value={config.command ?? ""} placeholder={s.inspector.commandPlaceholderGate} onChange={(e) => update({ command: e.target.value || null })} invalid={!config.command?.trim()} />
        </Section>
      </Reveal>

      <Reveal show={config.gate === "cross_review"}>
        <Section title={s.inspector.review}>
          <FormField label={s.inspector.reviewer} htmlFor={ids.rev} error={sameProvider ? s.inspector.sameProviderWarn : undefined}>
            <ProfileSelect id={ids.rev} aria-label={s.inspector.reviewer} profiles={env.profiles} value={config.reviewer_profile_id} emptyLabel={s.inspector.reviewerDefault} onChange={(v) => update({ reviewer_profile_id: v })} />
          </FormField>
          <FormField label={s.inspector.reviewerModel} htmlFor={ids.revModel}>
            <Input id={ids.revModel} size="sm" className="font-mono text-[11px] placeholder:font-sans placeholder:text-xs" value={config.reviewer_model ?? ""} placeholder={s.inspector.modelPlaceholder} onChange={(e) => update({ reviewer_model: e.target.value || null })} />
          </FormField>
          <FormField label={s.inspector.reviewFocus} htmlFor={ids.focus}>
            <Textarea id={ids.focus} minRows={2} maxRows={6} value={config.review_focus ?? ""} placeholder={s.inspector.reviewFocusPlaceholder} onChange={(e) => update({ review_focus: e.target.value || null })} />
          </FormField>
          <FormField label={s.inspector.blocking}>
            <CheckGroup
              options={SEVERITIES.map((sv) => ({ value: sv as string, label: severityStrings[sv]! }))}
              value={config.blocking_severities}
              onChange={(v) => update({ blocking_severities: SEVERITIES.filter((sv) => v.includes(sv)) })}
            />
          </FormField>
        </Section>
      </Reveal>

      <Section title={s.inspector.behavior}>
        <FormField label={s.inspector.targetNode} htmlFor={ids.target}>
          <Select id={ids.target} size="sm" aria-label={s.inspector.targetNode} value={config.target_node_id ?? ""} options={targetOptions} onValueChange={(v) => update({ target_node_id: v || null })} className="w-full" />
        </FormField>
        <FormField label={s.inspector.maxRounds} htmlFor={ids.rounds} hint={s.inspector.maxRoundsHint}>
          <NumberInput id={ids.rounds} value={config.max_rounds} min={1} max={20} allowEmpty={false} onChange={(v) => update({ max_rounds: v ?? 1 })} />
        </FormField>
      </Section>
    </>
  );
}

// ----------------------------------------------------------------------------- branching

export function ParallelForm() {
  return (
    <Section title={s.inspector.behavior}>
      <p className="text-sm text-fg-muted">{s.inspector.parallelInfo}</p>
    </Section>
  );
}

export function JoinForm({ config, update }: FormProps<JoinNodeConfig>) {
  return (
    <Section title={s.inspector.joinMode}>
      <SegmentedControl
        size="sm"
        fullWidth
        aria-label={s.inspector.joinMode}
        value={config.mode}
        onValueChange={(v) => update({ mode: v })}
        options={[
          { value: "all" as const, label: s.inspector.joinAll },
          { value: "any" as const, label: s.inspector.joinAny },
        ]}
      />
    </Section>
  );
}

export function CompareForm({ config, update }: FormProps<CompareNodeConfig>) {
  const env = useEditorEnv();
  const ids = { judge: useFieldId("judge"), criteria: useFieldId("criteria") };
  const compareGates: GateKind[] = ["boundary_check", "build_test", "cross_review", "custom_command"];
  return (
    <>
      <Section title={s.inspector.judge}>
        <SegmentedControl
          size="sm"
          fullWidth
          aria-label={s.inspector.judge}
          value={config.judge}
          onValueChange={(v) => update({ judge: v })}
          options={[
            { value: "user" as const, label: s.inspector.judgeUser },
            { value: "agent" as const, label: s.inspector.judgeAgent },
          ]}
        />
        <Reveal show={config.judge === "agent"}>
          <FormField label={s.inspector.judgeProfile} htmlFor={ids.judge}>
            <ProfileSelect id={ids.judge} aria-label={s.inspector.judgeProfile} profiles={env.profiles} value={config.judge_profile_id} emptyLabel={s.inspector.providerDefault} onChange={(v) => update({ judge_profile_id: v })} />
          </FormField>
        </Reveal>
        <FormField label={s.inspector.criteria} htmlFor={ids.criteria}>
          <Textarea id={ids.criteria} minRows={2} maxRows={6} value={config.criteria} onChange={(e) => update({ criteria: e.target.value })} />
        </FormField>
      </Section>
      <Section title={s.inspector.runGates}>
        <CheckGroup
          columns={1}
          options={compareGates.map((g) => ({ value: g, label: gateStrings[g].label }))}
          value={config.run_gates}
          onChange={(v) => update({ run_gates: GATE_KINDS.filter((g) => v.includes(g)) })}
        />
      </Section>
    </>
  );
}

export function ConditionForm({ id, config, update }: FormProps<ConditionNodeConfig>) {
  const { vars, nodeIds } = useTemplateVars(id);
  const ids = { expr: useFieldId("expr"), loops: useFieldId("loops") };
  return (
    <Section title={s.inspector.expression} description={s.inspector.expressionHint}>
      <PromptEditor
        id={ids.expr}
        mode="expression"
        singleLine
        aria-label={s.inspector.expression}
        value={config.expression}
        onChange={(v) => update({ expression: v })}
        variables={vars}
        nodeIds={nodeIds}
        placeholder={s.inspector.expressionPlaceholder}
        invalid={!config.expression.trim()}
      />
      <FormField label={s.inspector.maxLoops} htmlFor={ids.loops} hint={s.inspector.maxRoundsHint}>
        <NumberInput id={ids.loops} value={config.max_loops} min={1} max={20} allowEmpty={false} onChange={(v) => update({ max_loops: v ?? 1 })} />
      </FormField>
    </Section>
  );
}

export function SynthesisForm(props: FormProps<SynthesisNodeConfig>) {
  const { id, config, update } = props;
  return (
    <>
      <ModelSection {...props} withEffort={false} />
      <Section title={s.inspector.behavior}>
        <FormField label={s.inspector.outputFormat}>
          <SegmentedControl<SynthesisOutputFormat>
            size="sm"
            fullWidth
            aria-label={s.inspector.outputFormat}
            value={config.output_format}
            onValueChange={(v) => update({ output_format: v })}
            options={(Object.keys(synthesisFormatStrings) as SynthesisOutputFormat[]).map((v) => ({ value: v, label: synthesisFormatStrings[v] }))}
          />
        </FormField>
        <Switch label={s.inspector.devilAdvocate} description={s.inspector.devilAdvocateHint} checked={config.devil_advocate} onCheckedChange={(on) => update({ devil_advocate: on })} />
        <Switch label={s.inspector.proposeMemory} description={s.inspector.proposeMemoryHint} checked={config.propose_memory} onCheckedChange={(on) => update({ propose_memory: on })} />
      </Section>
      <PromptSection nodeId={id} value={config.prompt_template} onChange={(v) => update({ prompt_template: v })} hint={s.inspector.synthesisPromptHint} placeholder={s.inspector.synthesisPlaceholder} />
    </>
  );
}

// ----------------------------------------------------------------------------- delivery

export function MergeForm({ config, update }: FormProps<MergeNodeConfig>) {
  const refId = useFieldId("ref");
  return (
    <Section title={s.inspector.behavior}>
      <FormField label={s.inspector.targetRef} htmlFor={refId}>
        <Input id={refId} size="sm" className="font-mono text-[11px] placeholder:font-sans placeholder:text-xs" value={config.target_ref ?? ""} placeholder={s.inspector.targetRefPlaceholder} onChange={(e) => update({ target_ref: e.target.value || null })} />
      </FormField>
      <FormField label={s.inspector.strategy}>
        <SegmentedControl<MergeStrategy>
          size="sm"
          fullWidth
          aria-label={s.inspector.strategy}
          value={config.strategy}
          onValueChange={(v) => update({ strategy: v })}
          options={(Object.keys(mergeStrategyStrings) as MergeStrategy[]).map((v) => ({ value: v, label: mergeStrategyStrings[v] }))}
        />
      </FormField>
      <Switch label={s.inspector.requireApproval} checked={config.require_approval} onCheckedChange={(on) => update({ require_approval: on })} />
      <Switch label={s.inspector.resolveConflicts} checked={config.resolve_conflicts_with_agent} onCheckedChange={(on) => update({ resolve_conflicts_with_agent: on })} />
    </Section>
  );
}

export function GitForm({ id, config, update }: FormProps<GitNodeConfig>) {
  const { vars, nodeIds } = useTemplateVars(id);
  const ids = { base: useFieldId("base"), title: useFieldId("title"), body: useFieldId("body"), push: useFieldId("push") };
  return (
    <>
      <Section title={s.inspector.gitAction}>
        <SegmentedControl
          size="sm"
          fullWidth
          aria-label={s.inspector.gitAction}
          value={config.action}
          onValueChange={(v) => update({ action: v })}
          options={[
            { value: "open_pr" as const, label: s.inspector.gitPr },
            { value: "push" as const, label: s.inspector.gitPush },
          ]}
        />
      </Section>
      <Reveal show={config.action === "open_pr"}>
        <Section title={s.inspector.gitPr}>
          <FormField label={s.inspector.baseRef} htmlFor={ids.base}>
            <Input id={ids.base} size="sm" className="font-mono text-[11px] placeholder:font-sans placeholder:text-xs" value={config.base_ref ?? ""} placeholder={s.inspector.baseRefPlaceholder} onChange={(e) => update({ base_ref: e.target.value || null })} />
          </FormField>
          <Switch label={s.inspector.draft} checked={config.draft} onCheckedChange={(on) => update({ draft: on })} />
          <FormField label={s.inspector.titleTemplate} htmlFor={ids.title}>
            <PromptEditor id={ids.title} singleLine aria-label={s.inspector.titleTemplate} value={config.title_template} onChange={(v) => update({ title_template: v })} variables={vars} nodeIds={nodeIds} />
          </FormField>
          <FormField label={s.inspector.bodyTemplate} htmlFor={ids.body} hint={s.inspector.bodyTemplateHint}>
            <PromptEditor id={ids.body} aria-label={s.inspector.bodyTemplate} value={config.body_template ?? ""} onChange={(v) => update({ body_template: v.trim() ? v : null })} variables={vars} nodeIds={nodeIds} placeholder={s.inspector.bodyPlaceholder} minLines={4} />
          </FormField>
        </Section>
      </Reveal>
      <Reveal show={config.action === "push"}>
        <Section title={s.inspector.gitPush}>
          <FormField label={s.inspector.pushBranch} htmlFor={ids.push} hint={s.inspector.pushBranchHint}>
            <PromptEditor id={ids.push} singleLine aria-label={s.inspector.pushBranch} value={config.push_branch_template ?? ""} onChange={(v) => update({ push_branch_template: v.trim() ? v : null })} variables={vars} nodeIds={nodeIds} />
          </FormField>
        </Section>
      </Reveal>
      <Section title={s.inspector.behavior}>
        <Switch label={s.inspector.watch} description={s.inspector.watchHint} checked={config.watch} onCheckedChange={(on) => update({ watch: on })} />
        <Switch label={s.inspector.autofix} description={s.inspector.autofixHint} checked={config.autofix} disabled={!config.watch} onCheckedChange={(on) => update({ autofix: on })} />
      </Section>
    </>
  );
}

export function DeployForm({ config, update }: FormProps<DeployNodeConfig>) {
  const env = useEditorEnv();
  const deploy = useDeployProfiles(env.workspaceId);
  const id = useFieldId("deploy");
  const missing = deploy.isError && isMissingEndpoint(deploy.error);
  const list = deploy.data ?? [];
  const selected = list.find((p) => p.id === config.profile_id);
  return (
    <Section title={s.inspector.deployProfile}>
      {deploy.isPending ? (
        <Skeleton height={28} />
      ) : deploy.isError ? (
        <FormField label={s.inspector.deployProfileManual} htmlFor={id} hint={missing ? s.inspector.deployMissing : errorText(deploy.error)}>
          <Input id={id} size="sm" className="font-mono text-[11px] placeholder:font-sans placeholder:text-xs" value={config.profile_id} invalid={!config.profile_id.trim()} onChange={(e) => update({ profile_id: e.target.value })} />
        </FormField>
      ) : list.length === 0 ? (
        <p className="text-sm text-fg-muted">{s.inspector.deployEmpty}</p>
      ) : (
        <Select
          id={id}
          size="sm"
          aria-label={s.inspector.deployProfile}
          placeholder={s.inspector.deployProfilePlaceholder}
          value={config.profile_id || undefined}
          invalid={!config.profile_id}
          className="w-full"
          onValueChange={(v) => update({ profile_id: v })}
          options={list.map((p) => ({ value: p.id, label: p.name, description: `${p.kind.toUpperCase()} · ${uiStrings.environment[p.environment]}` }))}
        />
      )}
      {selected && (
        <div className="flex items-center gap-2">
          <EnvBadge environment={selected.environment} />
          <span className="text-xs text-fg-muted">{selected.kind.toUpperCase()}</span>
        </div>
      )}
      <Reveal show={selected?.environment === "production"}>
        <div className="flex items-start gap-2 rounded-md border border-env-production/30 bg-env-production-soft px-2.5 py-2 text-xs text-env-production">
          <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{s.inspector.productionDeploy}</span>
        </div>
      </Reveal>
    </Section>
  );
}

function SchemaEditor({ value, onChange }: { value: Record<string, unknown> | null; onChange: (v: Record<string, unknown> | null) => void }) {
  const [draft, setDraft] = useState(() => (value ? JSON.stringify(value, null, 2) : ""));
  const [error, setError] = useState<string | null>(null);
  const id = useFieldId("schema");
  return (
    <FormField label={s.inspector.inputSchema} htmlFor={id} hint={s.inspector.inputSchemaHint} error={error}>
      <PromptEditor
        id={id}
        mode="json"
        aria-label={s.inspector.inputSchema}
        value={draft}
        invalid={!!error}
        minLines={4}
        placeholder='{ "type": "object", "properties": { … } }'
        onChange={(text) => {
          setDraft(text);
          if (!text.trim()) {
            setError(null);
            onChange(null);
            return;
          }
          try {
            const parsed: unknown = JSON.parse(text);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            setError(null);
            onChange(parsed as Record<string, unknown>);
          } catch {
            setError(s.inspector.jsonInvalid);
          }
        }}
      />
    </FormField>
  );
}

export function HumanForm({ config, update }: FormProps<HumanNodeConfig>) {
  const id = useFieldId("instructions");
  return (
    <Section title={s.inspector.behavior}>
      <FormField label={s.inspector.instructions} htmlFor={id}>
        <Textarea id={id} minRows={3} maxRows={10} value={config.instructions} invalid={!config.instructions.trim()} placeholder={s.inspector.instructionsPlaceholder} onChange={(e) => update({ instructions: e.target.value })} />
      </FormField>
      <SchemaEditor value={config.input_schema} onChange={(v) => update({ input_schema: v })} />
    </Section>
  );
}

/** The form for a config, by kind. */
export function NodeConfigForm({ id, config, update }: FormProps<NodeConfig>) {
  const u = update as (patch: Partial<NodeConfig>) => void;
  switch (config.kind) {
    case "agent":
      return <AgentForm id={id} config={config} update={u} />;
    case "advisor":
      return <AdvisorForm id={id} config={config} update={u} />;
    case "gate":
      return <GateForm id={id} config={config} update={u} />;
    case "parallel":
      return <ParallelForm />;
    case "join":
      return <JoinForm id={id} config={config} update={u} />;
    case "compare":
      return <CompareForm id={id} config={config} update={u} />;
    case "condition":
      return <ConditionForm id={id} config={config} update={u} />;
    case "synthesis":
      return <SynthesisForm id={id} config={config} update={u} />;
    case "merge":
      return <MergeForm id={id} config={config} update={u} />;
    case "git":
      return <GitForm id={id} config={config} update={u} />;
    case "deploy":
      return <DeployForm id={id} config={config} update={u} />;
    case "human":
      return <HumanForm id={id} config={config} update={u} />;
  }
}
