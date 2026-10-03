/**
 * Full-page team builder (/teams/new[?from=], /teams/:id/edit[?version=]): header with inline name
 * and description, summary chips, validation, versions (preview + restore), duplicate, start a
 * task, save (new version; built-in templates save as a copy), ⌘S, ⌘K commands and an
 * unsaved-changes guard.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { Check, ChevronLeft, CircleAlert, Copy, Ellipsis, Eye, History, LayoutTemplate, Play, RotateCcw, Save, Undo2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBlocker, useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { ApiError } from "@/lib/api";
import { useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, transition, variants } from "@/motion/tokens";
import { Badge, Button, cn, Dialog, EmptyState, IconButton, Menu, MenuItem, MenuSeparator, Popover, ScrollArea, Skeleton, Spinner, toast } from "@/ui";
import { matchesShortcut } from "@/ui/shortcuts";

import { errorText } from "../../flows/util";
import { fetchTeam, reportFromSaveError, useCreateTeam, useProfiles, useTeam, useTeams, useTeamVersions, useUpdateTeam } from "../api";
import { withPositions } from "../model/graph";
import { defaultTeamSpec } from "../model/spec";
import { StartTeamTaskDialog } from "../StartTeamTaskDialog";
import { MiniOrgChart } from "../chart/MiniOrgChart";
import { s } from "../strings";
import type { Team } from "../types";
import { ValidationStatus } from "./parts";
import { BuilderStoreContext, createBuilderStore, useBuilder, useBuilderStore, type BuilderMeta } from "./store";
import { TeamBuilder } from "./TeamBuilder";
import { useAutoValidate } from "./useAutoValidate";
import { useBuilderLayout } from "./useBuilderLayout";

export interface TeamBuilderPageProps {
  teamId: string | null;
  version?: number | null;
  fromTeamId?: string | null;
}

function metaOf(t: Team): BuilderMeta {
  return { teamId: t.id, version: t.version, builtin: t.builtin, name: t.name, description: t.description };
}

function NameFields() {
  const store = useBuilderStore();
  const name = useBuilder((st) => st.name);
  const description = useBuilder((st) => st.description);
  const readOnly = useBuilder((st) => st.preview !== null);
  return (
    <div className="flex min-w-0 flex-col">
      <div className="relative min-w-0">
        <span aria-hidden className="invisible block truncate px-1.5 font-serif text-lg whitespace-pre">
          {name || s.builder.untitled}
        </span>
        <input
          aria-label={s.builder.nameLabel}
          value={name}
          readOnly={readOnly}
          placeholder={s.builder.untitled}
          onChange={(e) => store.getState().setMeta({ name: e.target.value })}
          onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
          className="absolute inset-0 w-full min-w-0 rounded-md bg-transparent px-1.5 font-serif text-lg text-fg outline-none transition-[background-color,box-shadow] duration-150 placeholder:text-fg-faint hover:bg-surface-hover focus:bg-surface focus:shadow-[var(--focus-ring)]"
        />
      </div>
      <input
        aria-label={s.builder.description}
        value={description}
        readOnly={readOnly}
        placeholder={s.builder.descriptionPlaceholder}
        onChange={(e) => store.getState().setMeta({ description: e.target.value })}
        onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && e.currentTarget.blur()}
        className="h-5 w-[min(420px,40vw)] min-w-0 rounded-[5px] bg-transparent px-1.5 text-xs text-fg-muted outline-none transition-[background-color,box-shadow] duration-150 placeholder:text-fg-faint hover:bg-surface-hover focus:bg-surface focus:shadow-[var(--focus-ring)]"
      />
    </div>
  );
}

function SaveState() {
  const dirty = useBuilder((st) => st.dirty);
  const teamId = useBuilder((st) => st.teamId);
  const version = useBuilder((st) => st.version);
  const builtin = useBuilder((st) => st.builtin);
  return (
    <div className="flex shrink-0 items-center gap-2">
      {builtin ? <Badge tone="accent">{s.builtin}</Badge> : version !== null && <Badge variant="outline">{s.version(version)}</Badge>}
      <span className="inline-flex" data-testid="team-save-state" aria-live="polite">
        <AnimatePresence mode="popLayout" initial={false}>
          {dirty || !teamId ? (
            <motion.span key="dirty" {...variants.fade} className="flex items-center gap-1.5 text-xs text-fg-muted">
              <motion.span className="size-1.5 rounded-full bg-warning" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring.bouncy} />
              {s.builder.unsaved}
            </motion.span>
          ) : (
            <motion.span key="saved" {...variants.fade} className="flex items-center gap-1 text-xs text-fg-muted">
              <Check className="size-3.5 text-success" aria-hidden />
              {s.builder.saved}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
    </div>
  );
}

function VersionsPopover() {
  const store = useBuilderStore();
  const teamId = useBuilder((st) => st.teamId);
  const builtin = useBuilder((st) => st.builtin);
  const current = useBuilder((st) => st.preview?.restore.version ?? st.version);
  const previewing = useBuilder((st) => st.preview?.version ?? null);
  const [open, setOpen] = useState(false);
  const versions = useTeamVersions(open && teamId && !builtin ? teamId : null);
  const now = useNow(60_000);
  const [loading, setLoading] = useState<number | null>(null);
  const view = async (v: number) => {
    if (!teamId) return;
    if (v === current) {
      store.getState().exitPreview();
      setOpen(false);
      return;
    }
    setLoading(v);
    try {
      const t = await fetchTeam(teamId, v);
      store.getState().enterPreview(v, t.spec, { name: t.name, description: t.description });
      setOpen(false);
    } catch (e) {
      toast.error(s.builder.loadFailed, { description: errorText(e) });
    } finally {
      setLoading(null);
    }
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={s.builder.versions}
      className="w-[280px] p-0"
      trigger={<IconButton size="md" label={s.builder.versions} icon={<History />} disabled={!teamId || builtin} data-testid="team-versions" />}
    >
      <div className="border-b border-line-subtle px-3 py-2.5 text-sm font-medium text-fg">{s.builder.versions}</div>
      {versions.isPending ? (
        <div className="flex flex-col gap-2 p-3">
          <Skeleton height={14} width="70%" />
          <Skeleton height={14} width="55%" />
        </div>
      ) : versions.isError || !versions.data?.length ? (
        <p className="px-3 py-4 text-sm text-fg-muted">{versions.isError ? errorText(versions.error) : s.builder.versionsEmpty}</p>
      ) : (
        <ScrollArea className="max-h-[280px]">
          <ul className="flex flex-col p-1.5">
            {versions.data.map((v) => (
              <li key={v.version}>
                <button
                  type="button"
                  onClick={() => void view(v.version)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-surface-hover focus-visible:shadow-[var(--focus-ring)]",
                    previewing === v.version && "bg-accent-soft",
                  )}
                >
                  <Badge variant="outline">{s.version(v.version)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-fg">{v.name}</span>
                  {v.version === current ? <span className="text-2xs text-fg-faint">{s.builder.current}</span> : <span className="text-2xs text-fg-faint">{v.created_at ? relativeTime(v.created_at, new Date(now)) : ""}</span>}
                  {loading === v.version && <Spinner size={12} label="" />}
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </Popover>
  );
}

function PreviewBanner({ onRestore }: { onRestore: (v: number) => void }) {
  const store = useBuilderStore();
  const preview = useBuilder((st) => st.preview);
  return (
    <AnimatePresence>
      {preview && (
        <motion.div
          key="preview"
          className="pointer-events-auto flex items-center gap-3 rounded-full border border-accent/30 bg-surface/95 py-1 pr-1 pl-3.5 shadow-2 backdrop-blur-md"
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1, transition: spring.smooth }}
          exit={{ opacity: 0, y: -8, transition: transition.exit }}
          role="status"
          data-testid="team-preview-banner"
        >
          <Eye className="size-3.5 text-accent" aria-hidden />
          <span className="text-sm whitespace-nowrap text-fg">{s.builder.readOnlyVersion(preview.version)}</span>
          <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => store.getState().exitPreview()}>
            {s.builder.exitPreview}
          </Button>
          <Button size="sm" variant="primary" icon={<RotateCcw />} onClick={() => onRestore(preview.version)}>
            {s.builder.restore}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function TemplatePicker({ workspaceId, onPick }: { workspaceId: string | null; onPick: (t: Team) => void }) {
  const teams = useTeams(workspaceId);
  const builtins = (teams.data ?? []).filter((t) => t.builtin);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-fg-muted">{s.builder.fromTemplateHint}</p>
      {teams.isPending ? (
        <div className="grid grid-cols-2 gap-3">
          <Skeleton height={96} className="rounded-lg" />
          <Skeleton height={96} className="rounded-lg" />
        </div>
      ) : builtins.length === 0 ? (
        <p className="text-sm text-fg-muted">{teams.isError ? errorText(teams.error) : s.builder.templatesEmpty}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {builtins.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t)}
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-left outline-none transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-2 focus-visible:shadow-[var(--focus-ring)]"
            >
              <MiniOrgChart spec={t.spec} className="h-14" aria-label={s.preview(t.name)} />
              <span className="truncate text-sm font-medium text-fg">{t.name}</span>
              <span className="line-clamp-2 text-xs text-fg-muted">{t.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BuilderScreen({ teamId, version = null, fromTeamId = null }: TeamBuilderPageProps) {
  const store = useBuilderStore();
  const navigate = useNavigate();
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const profiles = useProfiles(workspaceId);
  const team = useTeam(teamId);
  const create = useCreateTeam();
  const update = useUpdateTeam();
  const layout = useBuilderLayout();
  const loadedId = useBuilder((st) => st.teamId);
  const [saving, setSaving] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [fromError, setFromError] = useState<string | null>(null);
  const [fromLoaded, setFromLoaded] = useState<string | null>(null);
  const validate = useAutoValidate(true);

  // ------------------------------------------------------------------ load
  useEffect(() => {
    if (!teamId || !team.data || store.getState().teamId === teamId) return;
    store.getState().load({ meta: metaOf(team.data), spec: team.data.spec });
    if (version && version !== team.data.version) {
      void fetchTeam(teamId, version)
        .then((t) => store.getState().enterPreview(version, t.spec, { name: t.name, description: t.description }))
        .catch(() => undefined);
    }
  }, [store, team.data, teamId, version]);

  useEffect(() => {
    if (teamId) return;
    if (!fromTeamId) {
      store.getState().load({ meta: { teamId: null, version: null, builtin: false, name: "", description: "" }, spec: defaultTeamSpec() });
      return;
    }
    let cancelled = false;
    fetchTeam(fromTeamId)
      .then((t) => {
        if (cancelled) return;
        store.getState().load({ meta: { teamId: null, version: null, builtin: false, name: `${t.name}${s.copySuffix}`, description: t.description }, spec: t.spec, dirty: true });
        setFromLoaded(fromTeamId);
      })
      .catch((e: unknown) => !cancelled && setFromError(errorText(e)));
    return () => {
      cancelled = true;
    };
  }, [fromTeamId, store, teamId]);

  const status: "loading" | "ready" | "error" | "notFound" = teamId
    ? loadedId === teamId
      ? "ready"
      : team.isError
        ? team.error instanceof ApiError && team.error.status === 404
          ? "notFound"
          : "error"
        : "loading"
    : fromTeamId && fromLoaded !== fromTeamId
      ? fromError
        ? "error"
        : "loading"
      : "ready";

  // ------------------------------------------------------------------ save
  const save = useCallback(async (): Promise<Team | null> => {
    const st = store.getState();
    if (st.preview || saving) return null;
    setSaving(true);
    try {
      const spec = withPositions(st.spec, layout);
      const name = st.name.trim() || s.builder.untitled;
      if (!st.teamId || st.builtin) {
        const t = await create.mutateAsync({ workspace_id: workspaceId, name: st.builtin ? `${name}${name.endsWith(s.copySuffix) ? "" : s.copySuffix}` : name, description: st.description, spec });
        store.getState().markSaved({ teamId: t.id, version: t.version, name: t.name, description: t.description, builtin: false });
        toast.success(s.builder.createdToast, { description: t.name });
        void navigate(`/teams/${encodeURIComponent(t.id)}/edit`, { replace: true });
        return t;
      }
      const t = await update.mutateAsync({ id: st.teamId, body: { name, description: st.description, spec } });
      store.getState().markSaved({ teamId: t.id, version: t.version, name: t.name, description: t.description, builtin: t.builtin });
      toast.success(s.builder.savedToast(t.version));
      return t;
    } catch (e) {
      // Refused as invalid: mark the members the server named (same markers as live validation).
      const report = reportFromSaveError(e);
      if (report) store.getState().setReport(report, { explicit: true });
      toast.error(s.builder.saveFailed, { description: errorText(e) });
      return null;
    } finally {
      setSaving(false);
    }
  }, [create, layout, navigate, saving, store, update, workspaceId]);

  const restore = useCallback(
    async (v: number) => {
      const st = store.getState();
      if (!st.teamId || !st.preview) return;
      const spec = st.spec;
      const meta = { name: st.name, description: st.description };
      try {
        const t = await update.mutateAsync({ id: st.teamId, body: { ...meta, spec } });
        store.getState().load({ meta: metaOf(t), spec: t.spec });
        toast.success(s.builder.restoreDone(v, t.version));
      } catch (e) {
        toast.error(s.builder.saveFailed, { description: errorText(e) });
      }
    },
    [store, update],
  );

  const duplicate = useCallback(async () => {
    const st = store.getState();
    try {
      const t = await create.mutateAsync({ workspace_id: workspaceId, name: `${st.name || s.builder.untitled}${s.copySuffix}`, description: st.description, spec: withPositions(st.spec, layout) });
      toast.success(s.duplicated, { description: t.name, action: { label: s.open, onClick: () => void navigate(`/teams/${encodeURIComponent(t.id)}/edit`) } });
    } catch (e) {
      toast.error(s.builder.saveFailed, { description: errorText(e) });
    }
  }, [create, layout, navigate, store, workspaceId]);

  // ⌘S works while typing (capture phase, like the flow editor).
  useEffect(() => {
    const onSave = (e: KeyboardEvent) => {
      if (e.isComposing || !matchesShortcut(e, "⌘S")) return;
      if ((e.target as HTMLElement | null)?.closest?.('[role="dialog"]')) return;
      e.preventDefault();
      e.stopPropagation();
      void save();
    };
    window.addEventListener("keydown", onSave, { capture: true });
    return () => window.removeEventListener("keydown", onSave, { capture: true });
  }, [save]);

  // ------------------------------------------------------------------ ⌘K
  const commands = useMemo<StudioCommand[]>(() => {
    const group = s.commands.builderGroup;
    return [
      { id: "teams.builder.save", title: s.builder.save, group, shortcut: "⌘S", order: 0, keywords: ["save", "kaydet"], run: () => void save() },
      { id: "teams.builder.validate", title: s.builder.validate, group, order: 1, keywords: ["validate", "denetle"], run: () => void validate(true) },
      { id: "teams.builder.start", title: s.startWithTeam, group, order: 2, keywords: ["task", "görev", "başlat"], run: () => setStartOpen(true) },
      { id: "teams.builder.addChild", title: s.commands.addChild, group, shortcut: "+", order: 3, keywords: ["üye", "ekle", "member"], run: () => void store.getState().add("worker") },
      { id: "teams.builder.settings", title: s.commands.settings, group, order: 4, keywords: ["settings", "ayar", "rapor"], run: () => store.getState().setPanel("settings") },
      { id: "teams.builder.template", title: s.builder.fromTemplate, group, order: 5, keywords: ["template", "şablon"], run: () => setTemplatesOpen(true) },
      { id: "teams.builder.undo", title: s.builder.undo, group, shortcut: "⌘Z", order: 6, run: () => store.getState().undo() },
      { id: "teams.builder.redo", title: s.builder.redo, group, shortcut: "⌘⇧Z", order: 7, run: () => store.getState().redo() },
    ];
  }, [save, store, validate]);
  useRegisterCommands(commands);

  // ------------------------------------------------------------------ unsaved guard
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const st = store.getState();
    if (!st.dirty || st.preview) return false;
    if (currentLocation.pathname === nextLocation.pathname) return false;
    return !(currentLocation.pathname === "/teams/new" && st.teamId && nextLocation.pathname === `/teams/${st.teamId}/edit`);
  });

  const builtin = useBuilder((st) => st.builtin);
  const spec = useBuilder((st) => st.spec);
  const name = useBuilder((st) => st.name);
  const dirty = useBuilder((st) => st.dirty);
  const currentTeamId = useBuilder((st) => st.teamId);
  const previewing = useBuilder((st) => st.preview !== null);

  if (status === "error" || status === "notFound") {
    return (
      <div className="grid h-full place-items-center">
        <EmptyState
          icon={<CircleAlert />}
          title={status === "notFound" ? s.builder.notFound : s.builder.loadFailed}
          description={status === "notFound" ? s.builder.notFoundBody : fromError ?? errorText(team.error)}
          action={
            <Button size="sm" variant="secondary" icon={<ChevronLeft />} onClick={() => void navigate("/teams")}>
              {s.builder.backToList}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="team-builder-page">
      <header className="flex min-h-[64px] items-center gap-3 border-b border-line-subtle bg-canvas px-4 py-2">
        <IconButton size="md" label={s.builder.backToList} icon={<ChevronLeft />} onClick={() => void navigate("/teams")} />
        <NameFields />
        <SaveState />
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <ValidationStatus />
          <VersionsPopover />
          <Menu align="end" trigger={<IconButton size="md" label={s.more} icon={<Ellipsis />} />}>
            <MenuItem icon={<LayoutTemplate />} onSelect={() => setTemplatesOpen(true)}>
              {s.builder.fromTemplate}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Copy />} disabled={!currentTeamId} onSelect={() => void duplicate()}>
              {s.duplicate}
            </MenuItem>
          </Menu>
          <Button size="sm" variant="secondary" icon={<Play />} disabled={previewing || !workspaceId} onClick={() => setStartOpen(true)} data-testid="team-start">
            {s.startWithTeam}
          </Button>
          <Button size="sm" variant="primary" icon={<Save />} loading={saving} disabled={previewing} onClick={() => void save()} data-testid="team-save">
            {builtin ? s.builder.saveCopy : s.builder.save}
          </Button>
        </div>
      </header>
      <AnimatePresence initial={false}>
        {builtin && (
          <motion.div key="builtin" {...variants.banner} className="border-b border-accent/20 bg-accent-soft/60 px-5 py-1.5 text-xs text-accent">
            {s.builder.builtinBanner}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <TeamBuilder profiles={profiles.data ?? []} scope="page" banner={<PreviewBanner onRestore={(v) => void restore(v)} />} />
        <AnimatePresence>
          {status === "loading" && (
            <motion.div key="loading" {...variants.fade} className="absolute inset-0 z-20 grid place-items-center bg-canvas-subtle/80 backdrop-blur-[2px]" data-testid="team-builder-loading">
              <div className="flex items-center gap-2 text-sm text-fg-muted">
                <Spinner size={16} label="" />
                {s.live.loading}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <StartTeamTaskDialog open={startOpen} onOpenChange={setStartOpen} workspaceId={workspaceId} teamId={currentTeamId} teamName={name || s.builder.untitled} spec={spec} inline={dirty || !currentTeamId} />

      <Dialog open={templatesOpen} onOpenChange={setTemplatesOpen} size="lg" title={s.builder.fromTemplate}>
        <TemplatePicker
          workspaceId={workspaceId}
          onPick={(t) => {
            setTemplatesOpen(false);
            store.getState().setSpec(() => t.spec);
            store.getState().requestFit();
          }}
        />
      </Dialog>

      <Dialog
        open={blocker.state === "blocked"}
        onOpenChange={(o) => !o && blocker.state === "blocked" && blocker.reset()}
        title={s.builder.leaveTitle}
        description={s.builder.leaveBody}
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.state === "blocked" && blocker.reset()}>
              {s.builder.stay}
            </Button>
            <Button variant="danger" onClick={() => blocker.state === "blocked" && blocker.proceed()} data-testid="confirm-leave">
              {s.builder.leave}
            </Button>
          </>
        }
      />
    </div>
  );
}

export function TeamBuilderPage(props: TeamBuilderPageProps) {
  const [store] = useState(() => createBuilderStore());
  return (
    <BuilderStoreContext.Provider value={store}>
      <ReactFlowProvider>
        <BuilderScreen {...props} />
      </ReactFlowProvider>
    </BuilderStoreContext.Provider>
  );
}
