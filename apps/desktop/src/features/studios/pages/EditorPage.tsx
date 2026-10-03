import { useQuery } from "@tanstack/react-query";
import { Save, Workflow } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef, useState } from "react";
import { useBlocker, useNavigate, useSearchParams } from "react-router";

import { ApiError } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";
import { transition } from "@/motion/tokens";
import { Button, CountBadge, Dialog, EmptyState, Field, Input, Kbd, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, toast } from "@/ui";

import { useSaveStudio, useStudio, useStudios, validateStudio } from "../api";
import { LazyCodeEditor } from "../code/LazyCodeEditor";
import { FlowPreview } from "../components/FlowPreview";
import { IssueList, ValidationPill, type ValidationState } from "../components/IssueList";
import { BackLink, LoadError } from "../components/Page";
import { StudioVersionBadges } from "../components/StudioCard";
import { StudioIcon } from "../components/StudioIcon";
import { VersionHistory } from "../components/VersionHistory";
import { useDebounced, useShortcut } from "../hooks";
import { BLANK_TEMPLATE } from "../icons";
import { STUDIO_ID } from "../model";
import { studioStrings as s } from "../strings";
import { blankStudio, schemaIssuesFromError, serverIssues, studioFromTemplate, studioToYaml, yamlToStudio, type EditorIssue } from "../studioYaml";
import type { FlowGraph, Studio } from "../types";

type Panel = "issues" | "graph" | "versions";

interface EditorPageProps {
  /** Existing studio id; omitted for "Yeni stüdyo" (template, id and name come from the query string). */
  studioId?: string;
}

function useInitialStudio(studioId: string | undefined) {
  const [params] = useSearchParams();
  const from = params.get("from") ?? BLANK_TEMPLATE;
  const newId = params.get("id") ?? "";
  const newName = params.get("name") ?? "";
  const existing = useStudio(studioId);
  const template = useStudio(!studioId && from !== BLANK_TEMPLATE ? from : undefined);
  if (studioId) return { studio: existing.data && !existing.isPlaceholderData ? existing.data : undefined, query: existing, isNew: false, newId: "" };
  if (from === BLANK_TEMPLATE) return { studio: blankStudio(newId, newName), query: null, isNew: true, newId };
  return {
    studio: template.data && !template.isPlaceholderData ? studioFromTemplate(template.data, newId, newName) : undefined,
    query: template,
    isNew: true,
    newId,
  };
}

export function EditorPage({ studioId }: EditorPageProps) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { studio: initial, query, isNew, newId } = useInitialStudio(studioId);
  const { data: studios } = useStudios();
  const save = useSaveStudio();

  const [text, setText] = useState<string | null>(null);
  const [savedText, setSavedText] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | undefined>(undefined);
  const [panel, setPanel] = useState<Panel>(params.get("panel") === "versions" && !isNew ? "versions" : "issues");
  const [reveal, setReveal] = useState<{ line: number; nonce: number } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [note, setNote] = useState("");
  const [lastGraph, setLastGraph] = useState<FlowGraph | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  // Load the studio into the editor once, and again when a newer saved version arrives while the
  // editor is clean (derived during render: no effect round-trip, no flash of stale text).
  const initialKey = initial ? `${initial.id}:${initial.version ?? 1}` : null;
  if (initial && initialKey !== loadedKey && (text === null || text === savedText)) {
    const yaml = studioToYaml(initial);
    setLoadedKey(initialKey);
    setText(yaml);
    setSavedText(isNew ? "" : yaml);
    setBaseVersion(isNew ? undefined : (initial.version ?? 1));
  }

  const value = text ?? "";
  const dirty = text !== null && text !== savedText;
  const parsed = useMemo(() => yamlToStudio(value, { version: baseVersion }), [value, baseVersion]);
  // Keep showing the last graph that parsed while the YAML is momentarily broken.
  if (parsed.studio && parsed.studio.graph !== lastGraph) setLastGraph(parsed.studio.graph);

  const identityIssues: EditorIssue[] = useMemo(() => {
    const st = parsed.studio;
    if (!st) return [];
    const line = parsed.lines.get("id");
    if (!isNew && studioId && st.id !== studioId) return [{ level: "error", message: s.idChanged, line, source: "schema" }];
    if (isNew && !STUDIO_ID.test(st.id)) return [{ level: "error", message: s.badId, line, source: "schema" }];
    if (isNew && studios?.some((x) => x.id === st.id)) return [{ level: "error", message: s.idTaken(st.id), line, source: "schema" }];
    return [];
  }, [isNew, parsed, studioId, studios]);

  // Server validation of the debounced text, once it parses.
  const debounced = useDebounced(value, 450);
  const debouncedParse = useMemo(() => yamlToStudio(debounced, { version: baseVersion }), [debounced, baseVersion]);
  const validation = useQuery({
    queryKey: ["studios", "validate", debounced],
    queryFn: () => validateStudio(debouncedParse.studio!),
    enabled: text !== null && !!debouncedParse.studio,
    retry: false,
    staleTime: Infinity,
    gcTime: 30_000,
  });
  const stale = debounced !== value;
  const serverDown = validation.isError && (isUnreachable(validation.error) || isMissingEndpoint(validation.error));
  const serverList: EditorIssue[] = useMemo(() => {
    if (stale || !debouncedParse.studio) return [];
    if (validation.data) return serverIssues(validation.data, debouncedParse.studio, debouncedParse.lines);
    if (validation.error) return schemaIssuesFromError(validation.error, debouncedParse.lines) ?? [];
    return [];
  }, [debouncedParse, stale, validation.data, validation.error]);

  const issues = useMemo(() => (text === null ? [] : [...parsed.issues, ...identityIssues, ...serverList]), [identityIssues, parsed.issues, serverList, text]);
  const errors = issues.filter((i) => i.level === "error").length;
  const warnings = issues.length - errors;
  const state: ValidationState = text === null
    ? "idle"
    : !parsed.studio
    ? "invalid"
    : stale || validation.isFetching
      ? "validating"
      : errors
        ? "invalid"
        : validation.data?.ok || serverDown
          ? "valid"
          : "idle";
  const canSave = !!parsed.studio && errors === 0 && (dirty || isNew) && !save.isPending;

  // Set right before navigating away after a successful create, so the guard lets it through.
  const leaving = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && !save.isPending && !leaving.current && currentLocation.pathname !== nextLocation.pathname);

  const doSave = () => {
    const studio = parsed.studio;
    if (!studio) return;
    save.mutate(
      { studio: { ...studio, version: baseVersion }, note: note.trim() || undefined, create: isNew },
      {
        onSuccess: (saved) => {
          setSaveOpen(false);
          setNote("");
          const yaml = studioToYaml(saved);
          setLoadedKey(`${saved.id}:${saved.version ?? 1}`);
          setText(yaml);
          setSavedText(yaml);
          setBaseVersion(saved.version);
          if (isNew) {
            leaving.current = true;
            toast.success(s.createdStudio, { description: saved.name });
            void navigate(`/studios/${encodeURIComponent(saved.id)}`, { replace: true });
          } else toast.success(s.saved(saved.version ?? 1), { description: saved.name });
        },
        onError: (err) => {
          setSaveOpen(false);
          const detailErrors = err instanceof ApiError ? err.details?.errors : undefined;
          const first = Array.isArray(detailErrors) && detailErrors[0] && typeof detailErrors[0] === "object" ? (detailErrors[0] as { message?: string }).message : undefined;
          toast.error(s.saveFailed, { description: first ?? (err instanceof ApiError ? err.message : undefined) });
          setPanel("issues");
        },
      },
    );
  };

  const requestSave = () => {
    if (!canSave) {
      if (errors) setPanel("issues");
      return;
    }
    setSaveOpen(true);
  };
  useShortcut("⌘S", requestSave, text !== null);

  const restore = async (studio: Studio, version: number) => {
    const saved = await save.mutateAsync({ studio: { ...studio, id: studioId ?? studio.id }, note: s.restoreNote(version) });
    const yaml = studioToYaml(saved);
    setLoadedKey(`${saved.id}:${saved.version ?? 1}`);
    setText(yaml);
    setSavedText(yaml);
    setBaseVersion(saved.version);
    toast.success(s.restored(version), { description: s.saved(saved.version ?? 1) });
  };

  const title = initial?.name ?? (isNew ? s.newEditorTitle : studioId ?? "");
  const backTo = studioId ? `/studios/${encodeURIComponent(studioId)}` : "/studios";
  const graph = parsed.studio?.graph ?? lastGraph;
  const nextVersion = (baseVersion ?? 0) + 1;

  if (query?.isError && !initial)
    return (
      <div className="absolute inset-0 grid place-items-center">
        <LoadError title={s.notFound} error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );

  return (
    <div className="absolute inset-0 flex flex-col" data-studio-editor>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-canvas px-5">
        <BackLink to={backTo}>{studioId ? title : s.back}</BackLink>
        <span className="h-4 w-px bg-line" aria-hidden />
        <div className="flex min-w-0 items-center gap-2">
          <StudioIcon name={parsed.studio?.icon ?? initial?.icon} size="sm" />
          <h1 className="truncate font-sans text-sm font-medium text-fg">{isNew ? `${s.newEditorTitle} · ${parsed.studio?.name || newId}` : `${title}`}</h1>
          {initial && !isNew && <StudioVersionBadges studio={{ ...initial, version: baseVersion ?? initial.version }} />}
          <AnimatePresence initial={false}>
            {dirty && !isNew && (
              <motion.span key="dirty" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1, transition: transition.micro }} exit={{ opacity: 0, scale: 0.6, transition: transition.exit }} className="flex items-center gap-1.5 text-2xs text-fg-muted">
                <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                {s.dirty}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <div className="flex-1" />
        <ValidationPill state={state} errors={errors} warnings={warnings} />
        <Button variant="primary" size="sm" icon={<Save />} disabled={!canSave} loading={save.isPending} onClick={requestSave} iconRight={<Kbd shortcut="⌘S" tone="accent" className="ml-1" />}>
          {isNew ? s.createStudio : s.save}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-code">
          {text === null ? (
            <div className="flex flex-col gap-2 p-5" aria-busy>
              {Array.from({ length: 14 }, (_, i) => (
                <Skeleton key={i} height={10} width={`${30 + ((i * 37) % 55)}%`} />
              ))}
            </div>
          ) : (
            <LazyCodeEditor
              value={value}
              onChange={setText}
              language="yaml"
              ariaLabel={s.editorTitle(title)}
              issues={issues.filter((i) => i.line).map((i) => ({ line: i.line!, level: i.level, message: i.message }))}
              reveal={reveal}
              onSave={requestSave}
              className="absolute inset-0"
            />
          )}
          <span className="pointer-events-none absolute right-4 bottom-3 rounded-md bg-surface/80 px-2 py-1 text-2xs text-fg-faint backdrop-blur">{s.editorHint}</span>
        </div>

        <aside className="flex w-[440px] shrink-0 flex-col border-l border-line bg-surface" aria-label={s.validation}>
          <Tabs value={panel} onValueChange={(v) => setPanel(v as Panel)} className="min-h-0 flex-1">
            <TabsList className="shrink-0 px-4" aria-label={s.validation}>
              <TabsTrigger value="issues" trailing={<CountBadge count={errors} tone="danger" />}>
                {s.validation}
              </TabsTrigger>
              <TabsTrigger value="graph">{s.graphPreview}</TabsTrigger>
              {!isNew && <TabsTrigger value="versions">{s.versions}</TabsTrigger>}
            </TabsList>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <TabsContent value="issues">
                <IssueList issues={issues} state={state} serverDown={serverDown} onReveal={(line) => setReveal({ line, nonce: Date.now() })} />
              </TabsContent>
              <TabsContent value="graph" className="p-4">
                {graph ? (
                  <div className="flex flex-col gap-2">
                    <FlowPreview graph={graph} className="h-[420px]" aria-label={s.graphPreview} />
                    {!parsed.studio && <p className="text-xs text-fg-muted">{s.graphInvalid}</p>}
                  </div>
                ) : (
                  <EmptyState size="sm" icon={<Workflow />} title={s.graphInvalid} />
                )}
              </TabsContent>
              {!isNew && studioId && (
                <TabsContent value="versions">
                  <VersionHistory
                    studioId={studioId}
                    onRestore={restore}
                    onLoad={(yaml) => {
                      setText(yaml);
                      setPanel("issues");
                    }}
                  />
                </TabsContent>
              )}
            </div>
          </Tabs>
        </aside>
      </div>

      <Dialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        size="md"
        title={isNew ? s.createStudio : s.saveDialogTitle}
        description={isNew ? s.createDialogDescription : s.saveDialogDescription(nextVersion)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              {s.cancel}
            </Button>
            <Button variant="primary" icon={<Save />} loading={save.isPending} type="submit" form="studio-save-form">
              {isNew ? s.createStudio : s.saveAsVersion(nextVersion)}
            </Button>
          </>
        }
      >
        <form
          id="studio-save-form"
          className="p-0.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!save.isPending) doSave();
          }}
        >
          <Field label={s.noteLabel} htmlFor="studio-save-note">
            <Input id="studio-save-note" autoFocus value={note} placeholder={s.notePlaceholder} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </form>
      </Dialog>

      <Dialog
        open={blocker.state === "blocked"}
        onOpenChange={(o) => {
          if (!o && blocker.state === "blocked") blocker.reset();
        }}
        title={s.leaveTitle}
        description={s.leaveDescription}
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.state === "blocked" && blocker.reset()}>
              {s.stay}
            </Button>
            <Button variant="danger" onClick={() => blocker.state === "blocked" && blocker.proceed()}>
              {s.leave}
            </Button>
          </>
        }
      />
    </div>
  );
}
