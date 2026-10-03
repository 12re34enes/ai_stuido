/**
 * Builder inspector (floating right panel): per-member settings — name, id, role, profile,
 * provider (styled), model, effort, instructions, writes, boundaries, and for testers the mode,
 * target and test command; managers / advisors can be re-attached from a picker too (keyboard
 * alternative to drag & drop). Team settings live in the same panel. Every edit is undoable.
 */
import { Copy, CircleAlert, Settings2, Trash2, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState, type ReactNode } from "react";

import { spring, transition } from "@/motion/tokens";
import { Badge, cn, IconButton, Input, ProviderMark, ScrollArea, SegmentedControl, Select, Switch, Textarea, type SelectOption } from "@/ui";
import { uiStrings } from "@/ui/strings";

import { defaultBoundaries } from "../../flows/model/kinds";
import { FormField, ModelInput, NumberInput, ProfileSelect, Section, TagInput } from "../../flows/editor/inspector/controls";
import type { AgentProfile, Boundaries } from "../../flows/types";
import { roleLabel } from "../model/spec";
import { canDuplicate, canReparent, testerAnchor } from "../model/tree";
import type { IndexedIssue } from "../model/validate";
import { mergeStrings, reportModeStrings, roleStrings, s, testModeStrings, triggerStrings } from "../strings";
import type { Provider, ReportMode, TeamMember, TestMode } from "../types";
import { EffortControl } from "./EffortControl";
import { useBuilder, useBuilderStore } from "./store";

function useFieldId(name: string) {
  return `${useId()}-${name}`;
}

function Reveal({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0, transition: spring.smooth }} exit={{ opacity: 0, transition: transition.exit }} className="flex flex-col gap-3">
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function IssueList({ issues }: { issues: IndexedIssue[] | undefined }) {
  return (
    <AnimatePresence initial={false}>
      {issues?.length ? (
        <motion.ul key="issues" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0, transition: spring.smooth }} exit={{ opacity: 0, transition: transition.exit }} className="flex flex-col gap-1.5" aria-label={s.inspector.issues}>
          {issues.map((i, n) => (
            <li key={`${i.code}-${n}`} className={cn("flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs", i.level === "error" ? "border-danger/25 bg-danger-soft text-danger" : "border-warning/25 bg-warning-soft text-warning")}>
              {i.level === "error" ? <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> : <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />}
              <span className="text-fg">{i.message}</span>
            </li>
          ))}
        </motion.ul>
      ) : null}
    </AnimatePresence>
  );
}

function PanelHeader({ icon, title, subtitle, actions, onClose }: { icon: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; onClose: () => void }) {
  return (
    <header className="flex items-start gap-3 border-b border-line-subtle px-4 pt-3.5 pb-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 className="truncate text-md leading-6 text-fg">{title}</h2>
        {subtitle && <p className="text-xs text-fg-muted">{subtitle}</p>}
      </div>
      <div className="-mt-0.5 -mr-1.5 flex shrink-0 items-center gap-0.5">
        {actions}
        <IconButton size="md" label={s.inspector.close} icon={<X />} onClick={onClose} />
      </div>
    </header>
  );
}

function ProviderChoice({ value, onChange }: { value: Provider; onChange: (p: Provider) => void }) {
  return (
    <SegmentedControl<Provider>
      size="sm"
      fullWidth
      aria-label={s.inspector.provider}
      value={value}
      onValueChange={onChange}
      options={[
        { value: "claude", label: <span className="font-serif text-[13px]">{uiStrings.providers.claude}</span>, icon: <ProviderMark provider="claude" size={14} label="" /> },
        { value: "codex", label: <span className="font-mono text-[11px] font-semibold">{uiStrings.providers.codex}</span>, icon: <ProviderMark provider="codex" size={14} label="" /> },
      ]}
    />
  );
}

function IdField({ member }: { member: TeamMember }) {
  const store = useBuilderStore();
  const [draft, setDraft] = useState(member.id);
  const taken = useBuilder((st) => draft !== member.id && st.spec.members.some((m) => m.id === draft));
  const id = useFieldId("id");
  const invalid = !/^[a-z0-9][a-z0-9-_]{0,39}$/.test(draft);
  const error = invalid ? "Küçük harf, rakam ve tire kullan." : taken ? "Bu kimlik kullanılıyor." : undefined;
  const commit = () => {
    if (!error && draft !== member.id) store.getState().renameId(member.id, draft);
    else setDraft(member.id);
  };
  return (
    <FormField label={s.inspector.id} htmlFor={id} error={error}>
      <Input
        id={id}
        size="sm"
        className="font-mono text-[11px]"
        value={draft}
        invalid={!!error}
        spellCheck={false}
        disabled={member.role === "lead"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setDraft(member.id);
            e.currentTarget.blur();
          }
        }}
      />
    </FormField>
  );
}

function BoundariesSection({ value, onChange }: { value: Boundaries | null; onChange: (b: Boundaries | null) => void }) {
  const b = value ?? defaultBoundaries();
  const set = (patch: Partial<Boundaries>) => onChange({ ...b, ...patch });
  const ids = { f: useFieldId("f"), r: useFieldId("r"), a: useFieldId("a"), d: useFieldId("d") };
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
        <Switch label={s.inspector.network} checked={b.network} onCheckedChange={(on) => set({ network: on })} />
      </Reveal>
    </Section>
  );
}

/** Re-attach picker: lists only the members this one may move under (canReparent). */
function AttachPicker({ member, label }: { member: TeamMember; label: string }) {
  const store = useBuilderStore();
  const spec = useBuilder((st) => st.spec);
  const id = useFieldId("attach");
  const current = member.role === "tester" ? testerAnchor(member) : member.parent_id;
  const options: SelectOption[] = spec.members
    .filter((m) => m.id === current || canReparent(spec, member.id, m.id).ok)
    .map((m) => ({ value: m.id, label: m.name, description: `${roleLabel(m)} · ${m.id}`, icon: <ProviderMark provider={m.provider} size={14} label="" /> }));
  if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: current, description: "Bulunamadı" });
  return (
    <FormField label={label} htmlFor={id}>
      <Select id={id} size="sm" aria-label={label} placeholder={s.inspector.testTargetPlaceholder} value={current ?? undefined} options={options} invalid={!current} className="w-full" onValueChange={(v) => v !== current && store.getState().move(member.id, v)} />
    </FormField>
  );
}

function MemberPanel({ id, profiles }: { id: string; profiles: AgentProfile[] }) {
  const store = useBuilderStore();
  const member = useBuilder((st) => st.spec.members.find((m) => m.id === id));
  const issues = useBuilder((st) => st.issues.byMember[id]);
  const readOnly = useBuilder((st) => st.preview !== null);
  const ids = { name: useFieldId("name"), profile: useFieldId("profile"), model: useFieldId("model"), effort: useFieldId("effort"), instr: useFieldId("instr"), cmd: useFieldId("cmd") };
  if (!member) return null;
  const update = (patch: Partial<TeamMember>, key?: string) => store.getState().updateMember(id, patch, key);
  const profilesById = new Map(profiles.map((p) => [p.id, p]));
  const profile = member.profile_id ? profilesById.get(member.profile_id) : undefined;
  const modelSuggestions = profiles.filter((p) => p.provider === member.provider && p.model).map((p) => p.model!);
  const isTester = member.role === "tester";
  const isAdvisor = member.role === "advisor";

  return (
    <>
      <PanelHeader
        icon={<ProviderMark provider={member.provider} variant="tile" size={28} />}
        title={member.name || "—"}
        subtitle={roleStrings[member.role].description}
        onClose={() => store.getState().select(null)}
        actions={
          !readOnly && (
            <>
              {canDuplicate({ members: [member] }, member.id) && <IconButton size="md" label={s.builder.duplicateSubtree} shortcut="⌘D" icon={<Copy />} onClick={() => store.getState().duplicate(id)} />}
              {member.role !== "lead" && <IconButton size="md" variant="danger" label={s.builder.deleteMember} shortcut="⌫" icon={<Trash2 />} onClick={() => store.getState().requestDelete(id)} />}
            </>
          )
        }
      />
      <ScrollArea className="min-h-0 flex-1">
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6 px-4 pt-4 pb-6" data-testid="member-inspector">
          <IssueList issues={issues} />
          <Section title={s.inspector.general}>
            <FormField label={s.inspector.name} htmlFor={ids.name}>
              <Input id={ids.name} size="sm" value={member.name} invalid={!member.name.trim()} onChange={(e) => update({ name: e.target.value })} onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()} />
            </FormField>
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <IdField key={member.id} member={member} />
              <div className="flex flex-col gap-1.5 pb-1">
                <span className="text-xs font-medium text-fg">{s.inspector.role}</span>
                <Badge tone={member.role === "lead" ? "accent" : isAdvisor ? "info" : isTester ? "success" : "neutral"} size="md">
                  {roleLabel(member)}
                </Badge>
              </div>
            </div>
            {member.role === "worker" && <AttachPicker member={member} label={s.inspector.reportsTo} />}
            {isAdvisor && <AttachPicker member={member} label={s.inspector.advises} />}
          </Section>

          {isTester && (
            <Section title={s.inspector.tester}>
              <FormField label={s.inspector.testMode} hint={testModeStrings[member.test_mode].description}>
                <SegmentedControl<TestMode>
                  size="sm"
                  fullWidth
                  aria-label={s.inspector.testMode}
                  value={member.test_mode}
                  onValueChange={(v) => {
                    const anchor = testerAnchor(member);
                    update(v === "dependent" ? { test_mode: v, tests_member_id: anchor, parent_id: anchor } : { test_mode: v, tests_member_id: null, parent_id: anchor });
                  }}
                  options={(["dependent", "independent"] as const).map((v) => ({ value: v, label: testModeStrings[v].label }))}
                />
              </FormField>
              <AttachPicker member={member} label={member.test_mode === "dependent" ? s.inspector.testTarget : s.inspector.testScope} />
              <FormField label={s.inspector.testCommand} htmlFor={ids.cmd} hint={s.inspector.testCommandHint}>
                <Input id={ids.cmd} size="sm" className="font-mono text-[11px] placeholder:font-sans placeholder:text-xs" value={member.test_command ?? ""} placeholder={s.inspector.testCommandPlaceholder} onChange={(e) => update({ test_command: e.target.value || null })} />
              </FormField>
            </Section>
          )}

          <Section title={s.inspector.model}>
            <FormField label={s.inspector.profile} htmlFor={ids.profile} hint={member.profile_id ? undefined : s.inspector.profileHint}>
              <ProfileSelect
                id={ids.profile}
                aria-label={s.inspector.profile}
                profiles={profiles}
                value={member.profile_id}
                emptyLabel={s.inspector.noProfile}
                onChange={(v) => {
                  const p = v ? profilesById.get(v) : undefined;
                  update(p ? { profile_id: v, provider: p.provider, model: p.model, effort: p.effort } : { profile_id: v });
                }}
              />
            </FormField>
            <AnimatePresence initial={false} mode="popLayout">
              {profile && (
                <motion.div key="profile" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: transition.exit }} className="flex flex-wrap items-center gap-1.5 rounded-md bg-surface-sunken px-2.5 py-2 text-xs text-fg-muted">
                  <Badge tone={profile.provider}>{uiStrings.providers[profile.provider]}</Badge>
                  {profile.model && <span className="font-mono text-[11px] text-fg">{profile.model}</span>}
                  {profile.effort && <span>· {profile.effort}</span>}
                  <span>· {s.inspector.fromProfile}</span>
                </motion.div>
              )}
            </AnimatePresence>
            <FormField label={s.inspector.provider}>
              <ProviderChoice value={member.provider} onChange={(p) => update({ provider: p, profile_id: profile && profile.provider !== p ? null : member.profile_id })} />
            </FormField>
            <FormField label={s.inspector.modelLabel} htmlFor={ids.model}>
              <ModelInput id={ids.model} value={member.model} placeholder={s.inspector.modelPlaceholder} suggestions={modelSuggestions} onChange={(v) => update({ model: v })} />
            </FormField>
            <FormField label={s.inspector.effort} htmlFor={ids.effort} hint={s.inspector.effortHint}>
              <EffortControl id={ids.effort} provider={member.provider} value={member.effort} onChange={(v) => update({ effort: v }, `effort:${id}`)} />
            </FormField>
          </Section>

          <Section title={s.inspector.instructions}>
            <Textarea id={ids.instr} aria-label={s.inspector.instructions} minRows={3} maxRows={10} value={member.instructions} placeholder={s.inspector.instructionsPlaceholder} onChange={(e) => update({ instructions: e.target.value })} />
          </Section>

          <Section title={s.inspector.behavior}>
            <Switch label={s.inspector.writes} description={isAdvisor ? s.inspector.advisorReadOnly : s.inspector.writesHint} checked={member.writes} disabled={isAdvisor} onCheckedChange={(on) => update({ writes: on })} />
          </Section>

          <BoundariesSection value={member.boundaries} onChange={(b) => update({ boundaries: b })} />
        </fieldset>
      </ScrollArea>
    </>
  );
}

export function SettingsForm() {
  const store = useBuilderStore();
  const settings = useBuilder((st) => st.spec.settings);
  const readOnly = useBuilder((st) => st.preview !== null);
  const ids = { interval: useFieldId("interval"), par: useFieldId("par"), depth: useFieldId("depth"), max: useFieldId("max"), rounds: useFieldId("rounds") };
  const set = store.getState().updateSettings;
  return (
    <fieldset disabled={readOnly} className="flex flex-col gap-6" data-testid="team-settings">
      <Section title={s.settings.reporting}>
        <FormField label={s.settings.reportMode} hint={reportModeStrings[settings.report_mode].description}>
          <SegmentedControl<ReportMode>
            size="sm"
            fullWidth
            aria-label={s.settings.reportMode}
            value={settings.report_mode}
            onValueChange={(v) => set({ report_mode: v })}
            options={(Object.keys(reportModeStrings) as ReportMode[]).map((v) => ({ value: v, label: reportModeStrings[v].label }))}
          />
        </FormField>
        <Reveal show={settings.report_mode === "periodic"}>
          <FormField label={s.settings.interval} htmlFor={ids.interval}>
            <NumberInput id={ids.interval} value={settings.report_interval_minutes} min={1} max={240} allowEmpty={false} suffix={s.settings.minutes} onChange={(v) => set({ report_interval_minutes: v ?? 15 }, "settings:interval")} />
          </FormField>
        </Reveal>
      </Section>
      <Section title={s.settings.limits}>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={s.settings.maxParallel} htmlFor={ids.par}>
            <NumberInput id={ids.par} value={settings.max_parallel_members} min={1} max={16} allowEmpty={false} onChange={(v) => set({ max_parallel_members: v ?? 1 }, "settings:par")} />
          </FormField>
          <FormField label={s.settings.maxDepth} htmlFor={ids.depth} hint={s.settings.maxDepthHint}>
            <NumberInput id={ids.depth} value={settings.max_depth} min={1} max={8} allowEmpty={false} onChange={(v) => set({ max_depth: v ?? 4 }, "settings:depth")} />
          </FormField>
        </div>
        <FormField label={s.settings.maxAssignments} htmlFor={ids.max}>
          <NumberInput id={ids.max} value={settings.max_assignments} min={1} max={500} allowEmpty={false} onChange={(v) => set({ max_assignments: v ?? 40 }, "settings:max")} />
        </FormField>
      </Section>
      <Section title={s.settings.testing}>
        <FormField label={s.settings.testRounds} htmlFor={ids.rounds} hint={s.settings.testRoundsHint}>
          <NumberInput id={ids.rounds} value={settings.test_max_rounds} min={0} max={10} allowEmpty={false} onChange={(v) => set({ test_max_rounds: v ?? 2 }, "settings:rounds")} />
        </FormField>
        <FormField label={s.settings.independentTrigger}>
          <SegmentedControl
            size="sm"
            fullWidth
            aria-label={s.settings.independentTrigger}
            value={settings.independent_tests_trigger}
            onValueChange={(v) => set({ independent_tests_trigger: v })}
            options={(["after_each_merge", "at_end"] as const).map((v) => ({ value: v, label: triggerStrings[v] }))}
          />
        </FormField>
      </Section>
      <Section title={s.settings.merging}>
        <FormField label={s.settings.mergeStrategy}>
          <SegmentedControl size="sm" fullWidth aria-label={s.settings.mergeStrategy} value={settings.merge_strategy} onValueChange={(v) => set({ merge_strategy: v })} options={(["merge", "squash"] as const).map((v) => ({ value: v, label: mergeStrings[v] }))} />
        </FormField>
      </Section>
    </fieldset>
  );
}

function SettingsPanel() {
  const store = useBuilderStore();
  return (
    <>
      <PanelHeader
        icon={
          <span className="grid size-7 place-items-center rounded-md bg-surface-sunken text-fg-muted [&_svg]:size-4">
            <Settings2 aria-hidden />
          </span>
        }
        title={s.settings.title}
        onClose={() => store.getState().setPanel(null)}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pt-4 pb-6">
          <SettingsForm />
        </div>
      </ScrollArea>
    </>
  );
}

export function Inspector({ profiles }: { profiles: AgentProfile[] }) {
  const selected = useBuilder((st) => (st.selected && st.spec.members.some((m) => m.id === st.selected) ? st.selected : null));
  const panel = useBuilder((st) => st.panel);
  const view = selected ? `member:${selected}` : panel === "settings" ? "settings" : null;
  return (
    <AnimatePresence>
      {view && (
        <motion.aside
          key="inspector"
          aria-label={view === "settings" ? s.settings.title : s.inspector.general}
          data-testid="team-inspector"
          className="pointer-events-auto flex max-h-full w-[360px] flex-col overflow-hidden rounded-xl border border-line bg-surface/95 shadow-3 backdrop-blur-md"
          initial={{ opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0, transition: spring.smooth }}
          exit={{ opacity: 0, x: 28, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={view} className="flex min-h-0 flex-1 flex-col" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, opacity: transition.micro } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
              {selected ? <MemberPanel id={selected} profiles={profiles} /> : <SettingsPanel />}
            </motion.div>
          </AnimatePresence>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
