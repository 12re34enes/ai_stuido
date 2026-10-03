/** Plan (editable markdown), memory (diff + editable content), merge (diff) and final details. */
import { AlertTriangle, BadgeCheck, CircleCheck, CircleDashed, CircleX, FileText, GitMerge, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";

import { variants } from "@/motion/tokens";
import { Badge, Button, cn, DiffView, MarkdownView, SegmentedControl, Textarea } from "@/ui";

import { parsePatch } from "../../sessions/kit/patch";
import { PatchFileView } from "../../sessions/kit/PatchFileView";
import { isEdited } from "../draft";
import { finalPayload, memoryPayload, mergePayload, planPayload, type GateRow, type RepoDiff } from "../payload";
import { approvalStrings as s } from "../strings";
import { Facts, Mono, Section, Stats, type DetailProps } from "./common";

function EditedBar({ onReset, label }: { onReset: () => void; label: string }) {
  return (
    <motion.div {...variants.fadeUp} className="flex items-center justify-between gap-3 rounded-md bg-accent-soft/70 px-3 py-1.5 text-xs text-accent">
      <span>{label}</span>
      <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={onReset} className="-mr-1.5 h-6 text-accent hover:text-accent">
        {s.plan.reset}
      </Button>
    </motion.div>
  );
}

/** A clamped markdown preview with a soft fade (compact cards). */
function Clamp({ source }: { source: string }) {
  return (
    <div className="relative max-h-[104px] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_60%,transparent)]">
      <MarkdownView source={source} density="compact" />
    </div>
  );
}

// --------------------------------------------------------------------------- plan

export function PlanDetail({ approval, variant, draft, setDraft, editable }: DetailProps) {
  const p = planPayload(approval.payload);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const text = typeof draft.plan === "string" ? draft.plan : p.plan;
  const edited = isEdited(approval, draft);
  if (variant === "compact") return p.plan ? <Clamp source={text} /> : null;
  return (
    <Section
      title={s.plan.title}
      trailing={
        editable && p.editable ? (
          <SegmentedControl
            size="sm"
            aria-label={s.plan.title}
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "preview", label: s.plan.preview },
              { value: "edit", label: s.plan.edit },
            ]}
          />
        ) : undefined
      }
    >
      <AnimatePresence initial={false}>{edited && <EditedBar label={s.plan.edited} onReset={() => setDraft({ plan: p.plan })} />}</AnimatePresence>
      <AnimatePresence mode="wait" initial={false}>
        {mode === "edit" && editable ? (
          <motion.div key="edit" {...variants.fade}>
            <Textarea
              aria-label={s.plan.edit}
              value={text}
              onChange={(e) => setDraft({ plan: e.target.value })}
              minRows={12}
              maxRows={30}
              spellCheck={false}
              className="font-mono text-xs leading-5"
            />
          </motion.div>
        ) : (
          <motion.div key="preview" {...variants.fade} className="rounded-lg border border-line bg-surface px-5 py-4">
            {text.trim() ? <MarkdownView source={text} /> : <p className="text-sm text-fg-muted">{s.plan.empty}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </Section>
  );
}

// --------------------------------------------------------------------------- memory

export function MemoryDetail({ approval, variant, draft, setDraft, editable }: DetailProps) {
  const p = memoryPayload(approval.payload);
  const [mode, setMode] = useState<"diff" | "edit">("diff");
  const files = useMemo(() => parsePatch(p.diff, p.path), [p.diff, p.path]);
  const content = typeof draft.content === "string" ? draft.content : p.content;
  const edited = isEdited(approval, draft);
  const layer = p.layer ? (s.memory.layers[p.layer] ?? p.layer) : null;
  if (variant === "compact") {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <FileText className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
        <Mono className="min-w-0 truncate text-2xs">{p.path}</Mono>
        {layer && <Badge>{layer}</Badge>}
        <Stats additions={p.additions} deletions={p.deletions} className="ml-auto" />
      </div>
    );
  }
  const file = files[0];
  return (
    <div className="flex flex-col gap-5">
      <Facts
        rows={[
          [s.memory.file, <Mono key="p">{p.path}</Mono>],
          [s.memory.layer, layer],
          [s.memory.rationale, p.rationale],
        ]}
      />
      {p.boundaryWarnings.length > 0 && (
        <div role="alert" className="flex gap-2.5 rounded-lg border border-warning/35 bg-warning-soft/60 px-3.5 py-3 text-sm text-fg">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <div className="flex flex-col gap-1">
            <span className="font-medium">{s.memory.boundaryWarnings}</span>
            <ul className="flex flex-col gap-0.5 pl-4 text-xs text-fg-muted [list-style:disc]">
              {p.boundaryWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <Section
        title={mode === "diff" ? s.memory.diff : s.memory.content}
        trailing={
          editable ? (
            <SegmentedControl
              size="sm"
              aria-label={s.memory.content}
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "diff", label: s.memory.showDiff },
                { value: "edit", label: s.memory.editContent },
              ]}
            />
          ) : undefined
        }
      >
        <AnimatePresence initial={false}>{edited && <EditedBar label={s.memory.edited} onReset={() => setDraft({ content: p.content })} />}</AnimatePresence>
        <AnimatePresence mode="wait" initial={false}>
          {mode === "edit" && editable ? (
            <motion.div key="edit" {...variants.fade}>
              <Textarea
                aria-label={s.memory.editContent}
                value={content}
                onChange={(e) => setDraft({ content: e.target.value })}
                minRows={12}
                maxRows={30}
                spellCheck={false}
                className="font-mono text-xs leading-5"
              />
            </motion.div>
          ) : (
            <motion.div key="diff" {...variants.fade}>
              {file && !file.empty ? (
                edited ? (
                  <DiffView original={file.original} modified={content} filename={p.path} maxHeight={480} />
                ) : (
                  <PatchFileView file={file} label={p.path} maxHeight={480} />
                )
              ) : (
                <div className="rounded-lg border border-line bg-surface px-5 py-4">
                  <MarkdownView source={content} />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </Section>
    </div>
  );
}

// --------------------------------------------------------------------------- merge

export function MergeDetail({ approval, variant }: DetailProps) {
  const p = mergePayload(approval.payload);
  if (variant === "compact") {
    return (
      <ul className="flex flex-col gap-1">
        {p.merges.map((m, i) => (
          <li key={i} className="flex min-w-0 items-center gap-2 text-xs">
            <GitMerge className="size-3.5 shrink-0 text-fg-faint" aria-hidden />
            <span className="shrink-0 font-medium text-fg">{m.repo}</span>
            <Mono className="min-w-0 truncate text-2xs">{m.branch}</Mono>
            <span className="text-fg-faint">→</span>
            <Mono className="shrink-0 text-2xs">{m.targetRef}</Mono>
            <span className="ml-auto shrink-0 text-2xs text-fg-muted">{s.merge.files(m.files.length)}</span>
            <Stats additions={m.additions} deletions={m.deletions} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {p.strategy && <Badge tone="info">{s.merge.strategies[p.strategy] ?? p.strategy}</Badge>}
        {p.conflictsResolved && <Badge tone="warning">{s.merge.conflictsResolved}</Badge>}
      </div>
      {p.merges.map((m, i) => (
        <MergeRepo key={i} merge={m} />
      ))}
    </div>
  );
}

function MergeRepo({ merge }: { merge: ReturnType<typeof mergePayload>["merges"][number] }) {
  const files = useMemo(() => parsePatch(merge.patch), [merge.patch]);
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, 6);
  return (
    <Section
      title={
        <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
          <span className="text-xs font-medium text-fg">{merge.repo}</span>
          <Mono className="text-2xs">{merge.branch}</Mono>
          <span className="text-fg-faint">→</span>
          <Mono className="text-2xs">{merge.targetRef}</Mono>
        </span>
      }
      trailing={
        <span className="flex items-center gap-2 text-2xs text-fg-muted">
          {s.merge.files(merge.files.length)}
          <Stats additions={merge.additions} deletions={merge.deletions} />
        </span>
      }
    >
      {files.length === 0 ? (
        <p className="text-xs text-fg-muted">{s.merge.noPatch}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {shown.map((f, i) => (
            <PatchFileView key={`${f.path}-${i}`} file={f} />
          ))}
          {files.length > shown.length && (
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setAll(true)}>
              {s.merge.more(files.length - shown.length)}
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

// --------------------------------------------------------------------------- final

export function DiffstatTable({ diff }: { diff: RepoDiff[] }) {
  if (!diff.length) return <p className="text-xs text-fg-muted">{s.final.noChanges}</p>;
  return (
    <Section title={s.final.changes}>
      <div className="overflow-hidden rounded-lg border border-line">
        {diff.map((r, i) => (
          <div key={i} className={cn(i > 0 && "border-t border-line")}>
            <div className="flex items-center gap-2 bg-surface-sunken/70 px-3 py-1.5 text-xs">
              <span className="font-medium text-fg">{r.repo}</span>
              {r.branch && <Mono className="bg-surface text-2xs">{r.branch}</Mono>}
              <span className="ml-auto text-2xs text-fg-muted">{s.merge.files(r.files.length)}</span>
              <Stats additions={r.additions} deletions={r.deletions} />
            </div>
            <ul>
              {r.files.map((f) => (
                <li key={f.path} className="flex items-center gap-2.5 border-t border-line-subtle px-3 py-1 text-xs first:border-t-0">
                  <span className="w-4 shrink-0 text-center font-mono text-2xs font-medium text-fg-faint">{(f.status ?? "M").slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg">{f.path}</span>
                  <Stats additions={f.additions} deletions={f.deletions} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

function GateIcon({ status }: { status: string }) {
  if (status === "passed") return <CircleCheck className="size-4 text-success" aria-hidden />;
  if (status === "failed") return <CircleX className="size-4 text-danger" aria-hidden />;
  return <CircleDashed className="size-4 text-fg-faint" aria-hidden />;
}

export function GateList({ gates }: { gates: GateRow[] }) {
  if (!gates.length) return null;
  return (
    <Section title={s.final.gates}>
      <ul className="flex flex-col divide-y divide-line-subtle rounded-lg border border-line">
        {gates.map((g, i) => (
          <li key={i} className="flex items-start gap-2.5 px-3 py-2">
            <span className="mt-px">
              <GateIcon status={g.status} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm text-fg">{g.label}</span>
              {g.summary && <span className="text-xs text-fg-muted">{g.summary}</span>}
            </div>
            <span className="shrink-0 text-2xs text-fg-muted">{s.final.gateStatus[g.status] ?? g.status}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function FinalDetail({ approval, variant }: DetailProps) {
  const p = finalPayload(approval.payload, approval.summary);
  const files = p.diff.reduce((n, r) => n + r.files.length, 0);
  const adds = p.diff.reduce((n, r) => n + r.additions, 0);
  const dels = p.diff.reduce((n, r) => n + r.deletions, 0);
  const passed = p.gates.filter((g) => g.status === "passed").length;
  if (variant === "compact") {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
        <span>{s.merge.files(files)}</span>
        <Stats additions={adds} deletions={dels} />
        {p.gates.length > 0 && (
          <span className={cn("inline-flex items-center gap-1", passed === p.gates.length ? "text-success" : "text-warning")}>
            <BadgeCheck className="size-3.5" aria-hidden />
            {s.final.gates} {passed}/{p.gates.length}
          </span>
        )}
        {p.evidence.length > 0 && (
          <span>
            {s.final.evidence}: {p.evidence.length}
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      {p.summary && (
        <Section title={s.final.summary}>
          <div className="rounded-lg border border-line bg-surface px-5 py-4">
            <MarkdownView source={p.summary} />
          </div>
        </Section>
      )}
      <GateList gates={p.gates} />
      <DiffstatTable diff={p.diff} />
      {p.evidence.length > 0 && (
        <Section title={s.final.evidence}>
          <ul className="flex flex-wrap gap-1.5">
            {p.evidence.map((e) => (
              <li key={e.id}>
                <Badge variant="outline" icon={<FileText aria-hidden />}>
                  {e.title}
                </Badge>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
