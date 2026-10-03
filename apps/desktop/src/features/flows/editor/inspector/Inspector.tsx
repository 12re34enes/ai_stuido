/**
 * Right inspector: slides in on selection (node, edge, several) or for flow settings, and
 * cross-fades between selections. Every edit goes through the editor store (undoable).
 */
import { ArrowRight, CircleAlert, Copy, Settings2, Trash2, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { spring, transition } from "@/motion/tokens";
import { Button, cn, IconButton, Input, ProviderMark, ScrollArea, Select } from "@/ui";

import type { CanvasIssue } from "../../model/issues";
import { conditionsFor, isValidNodeId, kindInfo } from "../../model/kinds";
import { conditionStrings, s } from "../../strings";
import type { EdgeCondition, NodeConfig } from "../../types";
import { resolveProvider, useEditorEnv } from "../context";
import { useEditor, useEditorStore } from "../store";
import { FormField, Section } from "./controls";
import { NodeConfigForm } from "./NodeForms";
import { SettingsForm } from "./SettingsForm";

type View = { type: "node"; id: string } | { type: "edge"; id: string } | { type: "multi"; count: number } | { type: "settings" } | null;

function useView(): View {
  const sel = useEditor(
    useShallow((st) => ({
      nodes: st.nodes.filter((n) => n.selected && !st.exiting[n.id]).map((n) => n.id).join(","),
      edges: st.edges.filter((e) => e.selected && !st.exiting[e.id]).map((e) => e.id).join(","),
      panel: st.panel,
    })),
  );
  const nodes = sel.nodes ? sel.nodes.split(",") : [];
  const edges = sel.edges ? sel.edges.split(",") : [];
  if (nodes.length + edges.length > 1) return { type: "multi", count: nodes.length + edges.length };
  if (nodes.length === 1) return { type: "node", id: nodes[0]! };
  if (edges.length === 1) return { type: "edge", id: edges[0]! };
  if (sel.panel === "settings") return { type: "settings" };
  return null;
}

function IssueList({ issues }: { issues: CanvasIssue[] | undefined }) {
  return (
    <AnimatePresence initial={false}>
      {issues?.length ? (
        <motion.ul
          key="issues"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0, transition: spring.smooth }}
          exit={{ opacity: 0, transition: transition.exit }}
          className="flex flex-col gap-1.5"
          aria-label={s.inspector.issues}
        >
          {issues.map((i, n) => (
            <li
              key={`${i.code}-${n}`}
              className={cn(
                "flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs",
                i.level === "error" ? "border-danger/25 bg-danger-soft text-danger" : "border-warning/25 bg-warning-soft text-warning",
              )}
            >
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

function KindTile({ config }: { config: NodeConfig }) {
  const env = useEditorEnv();
  const provider = resolveProvider(config, env.profilesById);
  if (provider) return <ProviderMark provider={provider} variant="tile" size={28} />;
  const Icon = kindInfo(config.kind).icon;
  return (
    <span className={cn("grid size-7 place-items-center rounded-md [&_svg]:size-4", config.kind === "gate" ? "bg-accent-soft text-accent" : "bg-surface-sunken text-fg-muted")}>
      <Icon aria-hidden />
    </span>
  );
}

function IdField({ id }: { id: string }) {
  const store = useEditorStore();
  const [draft, setDraft] = useState(id);
  const taken = useEditor((st) => draft !== id && st.nodes.some((n) => n.id === draft));
  const fieldId = useId();
  const invalid = !isValidNodeId(draft);
  const error = invalid ? s.inspector.idInvalid : taken ? s.inspector.idTaken : undefined;
  const commit = () => {
    if (!error && draft !== id) store.getState().renameNode(id, draft);
    else setDraft(id);
  };
  return (
    <FormField label={s.inspector.id} htmlFor={fieldId} hint={s.inspector.idHint} error={error}>
      <Input
        id={fieldId}
        size="sm"
        className="font-mono text-[11px] placeholder:font-sans placeholder:text-xs"
        value={draft}
        invalid={!!error}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          }
          if (e.key === "Escape") {
            setDraft(id);
            e.currentTarget.blur();
          }
        }}
      />
    </FormField>
  );
}

function NodePanel({ id }: { id: string }) {
  const store = useEditorStore();
  const data = useEditor((st) => st.nodes.find((n) => n.id === id)?.data);
  const issues = useEditor((st) => st.issues.byNode[id]);
  const readOnly = useEditor((st) => st.preview !== null);
  const focusLabel = useEditor((st) => st.focusLabel);
  const labelRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const lastFocus = useRef(focusLabel);
  useEffect(() => {
    if (focusLabel !== lastFocus.current) {
      lastFocus.current = focusLabel;
      requestAnimationFrame(() => labelRef.current?.select());
    }
  }, [focusLabel]);
  if (!data) return null;
  const info = kindInfo(data.config.kind);
  return (
    <>
      <PanelHeader
        icon={<KindTile config={data.config} />}
        title={data.label || info.label}
        subtitle={info.long}
        onClose={() => store.getState().clearSelection()}
        actions={
          !readOnly && (
            <>
              <IconButton size="md" label={s.inspector.duplicateNode} icon={<Copy />} onClick={() => store.getState().duplicateSelection()} />
              <IconButton size="md" variant="danger" label={s.inspector.deleteNode} icon={<Trash2 />} onClick={() => store.getState().removeElements([id], [])} />
            </>
          )
        }
      />
      <ScrollArea className="min-h-0 flex-1">
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6 px-4 pt-4 pb-6" data-testid="node-inspector">
          <IssueList issues={issues} />
          <Section title={s.inspector.general}>
            <FormField label={s.inspector.label} htmlFor={labelId}>
              <Input
                ref={labelRef}
                id={labelId}
                size="sm"
                value={data.label}
                onChange={(e) => store.getState().updateNode(id, { label: e.target.value })}
                onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
              />
            </FormField>
            <IdField key={id} id={id} />
          </Section>
          <NodeConfigForm id={id} config={data.config} update={(patch) => store.getState().updateConfig(id, patch)} />
        </fieldset>
      </ScrollArea>
    </>
  );
}

function EdgePanel({ id }: { id: string }) {
  const store = useEditorStore();
  const edge = useEditor((st) => st.edges.find((e) => e.id === id));
  const source = useEditor((st) => st.nodes.find((n) => n.id === edge?.source));
  const target = useEditor((st) => st.nodes.find((n) => n.id === edge?.target));
  const issues = useEditor((st) => st.issues.byEdge[id]);
  const readOnly = useEditor((st) => st.preview !== null);
  const condId = useId();
  if (!edge || !source || !target) return null;
  const condition = edge.data?.condition ?? "default";
  const options = conditionsFor(source.data.config.kind);
  if (!options.includes(condition)) options.push(condition);
  return (
    <>
      <PanelHeader
        icon={
          <span className="grid size-7 place-items-center rounded-md bg-surface-sunken text-fg-muted [&_svg]:size-4">
            <ArrowRight aria-hidden />
          </span>
        }
        title={s.inspector.edge}
        subtitle={`${source.data.label} → ${target.data.label}`}
        onClose={() => store.getState().clearSelection()}
        actions={!readOnly && <IconButton size="md" variant="danger" label={s.inspector.deleteEdge} icon={<Trash2 />} onClick={() => store.getState().removeElements([], [id])} />}
      />
      <ScrollArea className="min-h-0 flex-1">
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6 px-4 pt-4 pb-6" data-testid="edge-inspector">
          <IssueList issues={issues} />
          <Section title={s.inspector.general}>
            <FormField label={s.inspector.edgeCondition} htmlFor={condId} hint={conditionStrings[condition].description}>
              <Select<EdgeCondition>
                id={condId}
                size="sm"
                aria-label={s.inspector.edgeCondition}
                value={condition}
                className="w-full"
                options={options.map((c) => ({ value: c, label: conditionStrings[c].label, description: conditionStrings[c].description }))}
                onValueChange={(c) => store.getState().setCondition(id, c)}
              />
            </FormField>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-fg-muted">{s.inspector.edgeFrom}</dt>
              <dd className="truncate text-fg">
                {source.data.label} <span className="font-mono text-[11px] text-fg-faint">{source.id}</span>
              </dd>
              <dt className="text-fg-muted">{s.inspector.edgeTo}</dt>
              <dd className="truncate text-fg">
                {target.data.label} <span className="font-mono text-[11px] text-fg-faint">{target.id}</span>
              </dd>
            </dl>
            {edge.data?.loop && <p className="text-xs text-fg-muted">{s.inspector.loopEdge}</p>}
          </Section>
        </fieldset>
      </ScrollArea>
    </>
  );
}

function MultiPanel({ count }: { count: number }) {
  const store = useEditorStore();
  const readOnly = useEditor((st) => st.preview !== null);
  return (
    <>
      <PanelHeader
        icon={<span className="grid size-7 place-items-center rounded-md bg-accent-soft text-xs font-medium text-accent tabular">{count}</span>}
        title={s.inspector.multi(count)}
        onClose={() => store.getState().clearSelection()}
      />
      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="text-sm text-fg-muted">{s.inspector.multiHint}</p>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Copy />} onClick={() => store.getState().duplicateSelection()}>
              {s.editor.duplicateSel}
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 />} className="text-danger hover:text-danger" onClick={() => store.getState().deleteSelection()}>
              {s.editor.deleteSel}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function SettingsPanel() {
  const store = useEditorStore();
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
        <div className="px-4 pt-4 pb-6" data-testid="flow-settings">
          <SettingsForm />
        </div>
      </ScrollArea>
    </>
  );
}

function viewKey(v: Exclude<View, null>): string {
  return v.type === "node" || v.type === "edge" ? `${v.type}:${v.id}` : v.type;
}

export function Inspector() {
  const view = useView();
  return (
    <AnimatePresence>
      {view && (
        <motion.aside
          key="inspector"
          aria-label={view.type === "settings" ? s.settings.title : s.inspector.node}
          data-testid="inspector"
          className="pointer-events-auto flex max-h-full w-[360px] flex-col overflow-hidden rounded-xl border border-line bg-surface/95 shadow-3 backdrop-blur-md"
          initial={{ opacity: 0, x: 28 }}
          animate={{ opacity: 1, x: 0, transition: spring.smooth }}
          exit={{ opacity: 0, x: 28, transition: { duration: 0.18, ease: [0.4, 0, 1, 1] } }}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={viewKey(view)}
              className="flex min-h-0 flex-1 flex-col"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { ...spring.smooth, opacity: transition.micro } }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
            >
              {view.type === "node" && <NodePanel id={view.id} />}
              {view.type === "edge" && <EdgePanel id={view.id} />}
              {view.type === "multi" && <MultiPanel count={view.count} />}
              {view.type === "settings" && <SettingsPanel />}
            </motion.div>
          </AnimatePresence>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
