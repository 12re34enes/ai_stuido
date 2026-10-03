/**
 * Editor header: back, inline flow name, version + save state, history, validation status (with
 * the issue list), versions, settings, save and "Bu akışla görev başlat".
 */
import { Check, ChevronLeft, CircleAlert, Ellipsis, History, LayoutTemplate, Play, Redo2, RotateCcw, Save, Settings2, ShieldCheck, TriangleAlert, Undo2, Eye } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { spring, transition, variants } from "@/motion/tokens";
import { Badge, Button, cn, IconButton, Menu, MenuItem, MenuSeparator, Popover, ScrollArea, Skeleton, Spinner, Tooltip } from "@/ui";

import { fetchFlowVersion, useFlowVersions } from "../api";
import type { CanvasIssue } from "../model/issues";
import { s } from "../strings";
import { editorShortcuts } from "./shortcuts";
import { useEditor, useEditorStore } from "./store";
import { useEditorActions } from "./useEditorActions";

function NameField() {
  const store = useEditorStore();
  const name = useEditor((st) => st.name);
  const readOnly = useEditor((st) => st.preview !== null);
  return (
    <div className="relative min-w-0">
      {/* Sizer keeps the input exactly as wide as its text. */}
      <span aria-hidden className="invisible block truncate px-1.5 font-serif text-lg whitespace-pre">
        {name || s.editor.untitled}
      </span>
      <input
        aria-label={s.editor.nameLabel}
        value={name}
        readOnly={readOnly}
        placeholder={s.editor.untitled}
        onChange={(e) => store.getState().setMeta({ name: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
        }}
        className="absolute inset-0 w-full min-w-0 rounded-md bg-transparent px-1.5 font-serif text-lg text-fg outline-none transition-[background-color,box-shadow] duration-150 placeholder:text-fg-faint hover:bg-surface-hover focus:bg-surface focus:shadow-[var(--focus-ring)]"
      />
    </div>
  );
}

function SaveState() {
  const dirty = useEditor((st) => st.dirty);
  const version = useEditor((st) => st.version);
  const flowId = useEditor((st) => st.flowId);
  return (
    <div className="flex shrink-0 items-center gap-2">
      {version !== null && <Badge variant="outline">{s.version(version)}</Badge>}
      <span className="inline-flex" data-testid="save-state" aria-live="polite">
      <AnimatePresence mode="popLayout" initial={false}>
        {dirty || !flowId ? (
          <motion.span key="dirty" {...variants.fade} className="flex items-center gap-1.5 text-xs text-fg-muted">
            <motion.span className="size-1.5 rounded-full bg-warning" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring.bouncy} />
            {s.editor.unsaved}
          </motion.span>
        ) : (
          <motion.span key="saved" {...variants.fade} className="flex items-center gap-1 text-xs text-fg-muted">
            <Check className="size-3.5 text-success" aria-hidden />
            {s.editor.saved}
          </motion.span>
        )}
      </AnimatePresence>
      </span>
    </div>
  );
}

function IssueRow({ issue, onPick }: { issue: CanvasIssue; onPick: (issue: CanvasIssue) => void }) {
  const target = issue.node_id ?? issue.edge_id;
  return (
    <li>
      <button
        type="button"
        disabled={!target}
        onClick={() => onPick(issue)}
        className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)] disabled:hover:bg-transparent"
      >
        {issue.level === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-fg">{issue.message}</span>
          <span className="font-mono text-[11px] text-fg-faint">{issue.node_id ?? issue.edge_id ?? s.editor.flowIssue}</span>
        </span>
      </button>
    </li>
  );
}

function ValidationStatus() {
  const actions = useEditorActions();
  const store = useEditorStore();
  const issues = useEditor((st) => st.issues);
  const hasReport = useEditor((st) => st.report !== null);
  const stale = useEditor((st) => st.report !== null && st.reportRevision !== st.revision);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    const report = await actions.validate({ explicit: true });
    setBusy(false);
    if (report && !report.ok) setOpen(true);
  };
  const pick = (issue: CanvasIssue) => {
    setOpen(false);
    if (issue.node_id && !issue.edge_id) actions.focusNode(issue.node_id);
    else if (issue.edge_id) store.getState().selectOnly({ edges: [issue.edge_id] });
  };
  const errors = issues.errorCount;
  const warnings = issues.warningCount;
  const tone = !hasReport ? "neutral" : errors ? "danger" : warnings ? "warning" : "success";
  return (
    <div className="flex items-center gap-1">
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="end"
        label={s.editor.issues}
        className="w-[380px] p-0"
        trigger={
          <button
            type="button"
            data-testid="validation-status"
            aria-label={`${s.editor.issues}: ${errors ? s.editor.errorsCount(errors) : warnings ? s.editor.warningsCount(warnings) : hasReport ? s.editor.validFlow : s.editor.notValidated}`}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium outline-none transition-[background-color,color,opacity] duration-150 focus-visible:shadow-[var(--focus-ring)]",
              tone === "neutral" && "text-fg-muted hover:bg-surface-hover",
              tone === "success" && "text-success hover:bg-success-soft",
              tone === "warning" && "text-warning hover:bg-warning-soft",
              tone === "danger" && "text-danger hover:bg-danger-soft",
              stale && "opacity-60",
            )}
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={`${tone}-${errors}-${warnings}`} className="inline-flex items-center gap-1.5" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4, transition: transition.exit }} transition={spring.snappy}>
                {tone === "success" ? <Check className="size-3.5" /> : tone === "danger" ? <CircleAlert className="size-3.5" /> : tone === "warning" ? <TriangleAlert className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
                {tone === "neutral" ? s.editor.notValidated : errors ? s.editor.errorsCount(errors) : warnings ? s.editor.warningsCount(warnings) : s.editor.validFlow}
                {errors > 0 && warnings > 0 && <span className="text-warning">· {s.editor.warningsCount(warnings)}</span>}
              </motion.span>
            </AnimatePresence>
          </button>
        }
      >
        <div className="flex items-center justify-between gap-2 border-b border-line-subtle px-3 py-2.5">
          <span className="text-sm font-medium text-fg">{s.editor.issues}</span>
          {stale && <span className="text-2xs text-fg-faint">{s.editor.staleIssues}</span>}
        </div>
        {issues.all.length === 0 ? (
          <p className="px-3 py-4 text-sm text-fg-muted">{hasReport ? s.editor.noIssues : s.editor.staleIssues}</p>
        ) : (
          <ScrollArea className="max-h-[320px]">
            <ul className="flex flex-col p-1.5" data-testid="issue-list">
              {issues.all.map((i, n) => (
                <IssueRow key={`${i.code}-${i.node_id}-${i.edge_id}-${n}`} issue={i} onPick={pick} />
              ))}
            </ul>
          </ScrollArea>
        )}
      </Popover>
      <Tooltip content={s.editor.validate} shortcut={editorShortcuts.validate}>
        <Button size="sm" variant="ghost" icon={busy ? <Spinner size={14} label="" /> : <ShieldCheck />} onClick={() => void run()} data-testid="validate">
          {s.editor.validate}
        </Button>
      </Tooltip>
    </div>
  );
}

function VersionsPopover({ onRestore }: { onRestore: (version: number) => void }) {
  const store = useEditorStore();
  const flowId = useEditor((st) => st.flowId);
  const current = useEditor((st) => st.version);
  const previewing = useEditor((st) => st.preview?.version ?? null);
  const [open, setOpen] = useState(false);
  const versions = useFlowVersions(open ? flowId : null);
  const now = useNow(60_000);
  const [loading, setLoading] = useState<number | null>(null);

  const view = async (version: number) => {
    if (!flowId) return;
    if (version === current) {
      store.getState().exitPreview();
      setOpen(false);
      return;
    }
    setLoading(version);
    try {
      const saved = await fetchFlowVersion(flowId, version);
      store.getState().enterPreview(version, saved.graph, { name: saved.name, description: saved.description });
      setOpen(false);
    } finally {
      setLoading(null);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={s.versions.title}
      className="w-[340px] p-0"
      trigger={<IconButton label={s.editor.versions} icon={<History />} active={open || previewing !== null} disabled={!flowId} data-testid="versions-button" />}
    >
      <div className="border-b border-line-subtle px-3 py-2.5 text-sm font-medium text-fg">{s.versions.title}</div>
      {versions.isPending ? (
        <div className="flex flex-col gap-2 p-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={30} />
          ))}
        </div>
      ) : versions.isError ? (
        <p className="px-3 py-4 text-sm text-danger">{s.versions.error}</p>
      ) : !versions.data?.length ? (
        <p className="px-3 py-4 text-sm text-fg-muted">{s.versions.empty}</p>
      ) : (
        <ScrollArea className="max-h-[340px]">
          <motion.ul className="flex flex-col p-1.5" initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.03 } } }} data-testid="version-list">
            {[...versions.data].reverse().map((v) => {
              const isCurrent = v.version === current;
              const isPreview = v.version === previewing;
              return (
                <motion.li key={v.version} variants={variants.listItem} className={cn("group/v flex items-center gap-3 rounded-md px-2 py-1.5", isPreview && "bg-accent-soft")}>
                  <span className="w-8 shrink-0 font-mono text-xs text-fg tabular">{s.version(v.version)}</span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-fg">{v.name}</span>
                    <span className="text-2xs text-fg-muted">
                      {relativeTime(v.created_at, new Date(now))} · {s.versions.by(v.created_by)}
                    </span>
                  </span>
                  {isCurrent ? (
                    <Badge tone="success">{s.versions.current}</Badge>
                  ) : (
                    <span className="flex items-center gap-0.5 opacity-70 transition-opacity group-hover/v:opacity-100 group-focus-within/v:opacity-100">
                      <IconButton size="sm" label={`${s.versions.view} ${s.version(v.version)}`} icon={<Eye />} loading={loading === v.version} onClick={() => void view(v.version)} />
                      <IconButton
                        size="sm"
                        label={`${s.versions.restore} ${s.version(v.version)}`}
                        icon={<RotateCcw />}
                        onClick={() => {
                          setOpen(false);
                          onRestore(v.version);
                        }}
                      />
                    </span>
                  )}
                </motion.li>
              );
            })}
          </motion.ul>
        </ScrollArea>
      )}
    </Popover>
  );
}

export function Toolbar({
  onStartTask,
  onRestore,
  onChooseTemplate,
  onSave,
  saving,
}: {
  onStartTask: () => void;
  onRestore: (version: number) => void;
  onChooseTemplate: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const navigate = useNavigate();
  const store = useEditorStore();
  const actions = useEditorActions();
  const canUndo = useEditor((st) => st.past.length > 0 && !st.preview);
  const canRedo = useEditor((st) => st.future.length > 0 && !st.preview);
  const panel = useEditor((st) => st.panel);
  const readOnly = useEditor((st) => st.preview !== null);
  const hasNodes = useEditor((st) => st.nodes.length > 0);

  return (
    <header className="relative z-10 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-canvas pr-3 pl-2" data-testid="flow-toolbar">
      <Button size="sm" variant="ghost" icon={<ChevronLeft />} onClick={() => void navigate("/flows")} className="-mr-1">
        {s.editor.back}
      </Button>
      <span className="text-fg-faint" aria-hidden>
        /
      </span>
      <div className="flex min-w-0 max-w-[420px] items-center">
        <NameField />
      </div>
      <SaveState />

      <div className="min-w-4 flex-1" />

      <div className="flex items-center gap-0.5">
        <IconButton label={s.editor.undo} shortcut={editorShortcuts.undo} icon={<Undo2 />} disabled={!canUndo} onClick={actions.undo} />
        <IconButton label={s.editor.redo} shortcut={editorShortcuts.redo} icon={<Redo2 />} disabled={!canRedo} onClick={actions.redo} />
      </div>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <ValidationStatus />
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <div className="flex items-center gap-0.5">
        <VersionsPopover onRestore={onRestore} />
        <IconButton
          label={s.editor.settings}
          icon={<Settings2 />}
          active={panel === "settings"}
          data-testid="settings-button"
          onClick={() => {
            const st = store.getState();
            if (st.panel === "settings") st.setPanel(null);
            else {
              st.clearSelection();
              st.setPanel("settings");
            }
          }}
        />
        <Menu
          align="end"
          trigger={<IconButton label={s.editor.more} icon={<Ellipsis />} />}
        >
          <MenuItem icon={<LayoutTemplate />} disabled={readOnly} onSelect={onChooseTemplate}>
            {s.editor.startFrom}
          </MenuItem>
          <MenuSeparator />
          <MenuItem shortcut={editorShortcuts.selectAll} disabled={!hasNodes} onSelect={actions.selectAll}>
            {s.editor.selectAll}
          </MenuItem>
          <MenuItem shortcut={editorShortcuts.duplicate} disabled={readOnly} onSelect={actions.duplicate}>
            {s.editor.duplicateSel}
          </MenuItem>
          <MenuItem shortcut={editorShortcuts.copy} onSelect={actions.copy}>
            {s.editor.copy}
          </MenuItem>
          <MenuItem shortcut={editorShortcuts.paste} disabled={readOnly} onSelect={actions.paste}>
            {s.editor.paste}
          </MenuItem>
          <MenuSeparator />
          <MenuItem shortcut={editorShortcuts.layout} disabled={readOnly || !hasNodes} onSelect={actions.autoLayout}>
            {s.editor.autoLayout}
          </MenuItem>
        </Menu>
      </div>
      <Tooltip content={s.editor.save} shortcut={editorShortcuts.save}>
        <Button size="sm" icon={<Save />} loading={saving} disabled={readOnly} onClick={onSave} data-testid="save">
          {s.editor.save}
        </Button>
      </Tooltip>
      <Tooltip content={s.editor.startTask} shortcut={editorShortcuts.startTask}>
        <Button size="sm" variant="primary" icon={<Play />} disabled={readOnly || !hasNodes} onClick={onStartTask} data-testid="start-task">
          {s.editor.startTaskShort}
        </Button>
      </Tooltip>
    </header>
  );
}
