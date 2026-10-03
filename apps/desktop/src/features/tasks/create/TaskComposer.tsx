/**
 * The home task composer (spec §19 "Ana ekran"): a large auto-growing prompt with an optional
 * title, studio / repo / branch pickers, "Gelişmiş" options and the mode preview. ⌘↵ creates the
 * task; its surface then morphs into the task page (shared layoutId with the detail route).
 */
import { ArrowUp, SlidersHorizontal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router";

import { ApiError } from "@/lib/api";
import { useComposerFocusRequest } from "@/lib/shell";
import type { Workspace } from "@/lib/types";
import { useShake } from "@/motion/hooks";
import { spring, transition, variants } from "@/motion/tokens";
import { Button, Kbd, cn, toast } from "@/ui";
import { matchesShortcut } from "@/ui/shortcuts";
import { textareaHeight } from "@/ui/textareaSize";

import { taskLayoutId } from "../list/status";
import { AdvancedPanel } from "./AdvancedPanel";
import { buildTaskBody, deriveTitle, serverFieldErrors, type FieldErrors } from "./buildTask";
import { BranchPicker, RepoPicker, StudioPicker } from "./ComposerPickers";
import { hasAdvanced, useComposer } from "./composerStore";
import { ModePanel } from "./ModePanel";
import { Chip } from "./Picker";
import { useCreateTask, useRepos, useSavedFlows, useStudios } from "./queries";
import { createStrings as s } from "./strings";
import { StudioForm } from "./StudioForm";

const SUBMIT = "⌘↵";
const RESET_AFTER_MS = 700;

/** Borderless auto-growing textarea for the prompt (min/max rows). */
function PromptArea({
  value,
  onChange,
  invalid,
  textareaRef,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const cs = window.getComputedStyle(el);
    el.style.height = "auto";
    const { height, overflow } = textareaHeight({
      scrollHeight: el.scrollHeight,
      lineHeight: parseFloat(cs.lineHeight) || 24,
      paddingY: (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
      borderY: 0,
      minRows: 3,
      maxRows: 14,
    });
    el.style.height = `${height}px`;
    el.style.overflowY = overflow ? "auto" : "hidden";
  }, [textareaRef]);
  useLayoutEffect(() => {
    resize();
  }, [resize, value]);
  return (
    <textarea
      ref={textareaRef}
      rows={3}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={s.promptPlaceholder}
      aria-label={s.promptLabel}
      aria-invalid={invalid || undefined}
      className="block w-full resize-none bg-transparent px-0 py-0 font-sans text-base leading-6 text-fg outline-none placeholder:text-fg-faint focus-visible:shadow-none"
    />
  );
}

export interface TaskComposerProps {
  workspace: Workspace;
  className?: string;
}

export function TaskComposer({ workspace, className }: TaskComposerProps) {
  const navigate = useNavigate();
  const draft = useComposer();
  const studios = useStudios();
  const repos = useRepos(workspace.id);
  const flows = useSavedFlows(workspace.id);
  const create = useCreateTask();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [launchedId, setLaunchedId] = useState<string | null>(null);
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const firstFieldRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const studio = useMemo(() => studios.data?.find((st) => st.id === draft.studioId) ?? null, [studios.data, draft.studioId]);
  const flow = useMemo(() => flows.data?.find((f) => f.id === draft.flowId) ?? null, [flows.data, draft.flowId]);
  const repoList = useMemo(() => repos.data ?? [], [repos.data]);

  // Drop choices that belonged to another workspace.
  useEffect(() => {
    useComposer.getState().bindWorkspace(workspace.id);
  }, [workspace.id]);

  // A studio picked from elsewhere may disappear (e.g. reload): drop the stale id.
  useEffect(() => {
    if (draft.studioId && studios.data && !studio) useComposer.getState().setStudio(null);
  }, [draft.studioId, studio, studios.data]);

  const focus = useCallback(() => {
    requestAnimationFrame(() => {
      const el = useComposer.getState().studioId ? firstFieldRef.current : textareaRef.current;
      el?.focus();
      if (el && "setSelectionRange" in el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);
  useComposerFocusRequest(focus);

  // The single repo the branch picker applies to.
  const targetRepos = draft.repoIds ?? repoList.map((r) => r.id);
  const branchRepo = targetRepos.length === 1 ? (repoList.find((r) => r.id === targetRepos[0]) ?? null) : null;

  const clearError = (key: string) => {
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  const submit = () => {
    if (create.isPending || launchedId) return;
    const result = buildTaskBody(useComposer.getState(), { workspaceId: workspace.id, studio });
    if (!result.ok) {
      setErrors(result.errors);
      shake();
      const budgetOrSchedule = Object.keys(result.errors).some((k) => k.startsWith("budget.") || k === "scheduledAt");
      if (budgetOrSchedule) useComposer.getState().setAdvancedOpen(true);
      else if (!result.errors.team || result.errors.prompt) focus();
      return;
    }
    setErrors({});
    create.mutate(result.body, {
      onSuccess: (detail) => {
        const scheduled = !!result.body.scheduled_at || result.body.start_on_reset;
        toast({ title: scheduled ? s.createdScheduled(detail.task.title) : s.created(detail.task.title), tone: "success" });
        // Commit the task's layoutId on the surface first, then navigate: the surface morphs into the task page.
        flushSync(() => setLaunchedId(detail.task.id));
        void navigate(`/tasks/${encodeURIComponent(detail.task.id)}`, { state: { morph: true } });
        // Clear the draft once this page has left (it must not flash empty while animating out).
        setTimeout(() => useComposer.getState().reset(), RESET_AFTER_MS);
      },
      onError: (err) => {
        const fieldErrors = err instanceof ApiError ? serverFieldErrors(err.details) : {};
        setErrors(fieldErrors);
        shake();
        toast({ title: s.failed, description: err instanceof Error ? err.message : undefined, tone: "danger" });
      },
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (matchesShortcut(e.nativeEvent, SUBMIT)) {
      e.preventDefault();
      submit();
    }
  };

  const derived = !studio && draft.prompt.trim() ? deriveTitle(draft.prompt) : "";
  const submitLabel = draft.schedule === "at" ? s.submitScheduled : draft.schedule === "reset" ? s.submitQueued : s.submit;
  const advancedChanged = hasAdvanced(draft);
  const layoutKey = `${studio?.id ?? "-"}:${draft.advancedOpen}`;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <div ref={shakeRef}>
        <motion.form
          layout
          layoutDependency={layoutKey}
          transition={spring.layout}
          aria-label={s.composerLabel}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          onKeyDown={onKeyDown}
          className="group/composer relative"
          style={{ borderRadius: 18 }}
        >
          {/* Surface: carries the task's layoutId after submit and morphs into the task page. */}
          <motion.div
            layoutId={launchedId ? taskLayoutId(launchedId) : undefined}
            aria-hidden
            className={cn(
              "absolute inset-0 rounded-[18px] border bg-surface shadow-2 transition-[border-color,box-shadow] duration-200",
              "border-line group-focus-within/composer:border-line-strong group-focus-within/composer:shadow-3",
              errors.prompt && "border-danger/60 group-focus-within/composer:border-danger/60",
            )}
            style={{ borderRadius: 18 }}
            transition={spring.gentle}
          />
          <motion.div layout="position" layoutDependency={layoutKey} className="relative flex flex-col gap-2 px-5 pt-4">
            <input
              value={draft.title}
              onChange={(e) => draft.set({ title: e.target.value })}
              placeholder={derived ? s.titleDerived(derived) : s.titlePlaceholder}
              aria-label={s.titlePlaceholder}
              maxLength={120}
              className="h-6 w-full truncate bg-transparent text-sm font-medium text-fg outline-none placeholder:font-normal placeholder:text-fg-faint focus-visible:shadow-none"
            />
            <AnimatePresence mode="popLayout" initial={false}>
              {studio ? (
                <motion.div key={`studio:${studio.id}`} {...variants.fadeUp} className="pt-1 pb-2">
                  <StudioForm
                    studio={studio}
                    values={draft.studioInputs}
                    errors={errors}
                    onChange={(name, v) => {
                      draft.setStudioInput(name, v);
                      clearError(`input.${name}`);
                    }}
                    workspaceId={workspace.id}
                    repos={repoList}
                    fallbackRepoId={branchRepo?.id ?? null}
                    firstFieldRef={firstFieldRef}
                  />
                </motion.div>
              ) : (
                <motion.div key="prompt" {...variants.fadeUp} className="flex flex-col gap-1.5 pb-1">
                  <PromptArea
                    value={draft.prompt}
                    onChange={(v) => {
                      draft.set({ prompt: v });
                      clearError("prompt");
                    }}
                    invalid={!!errors.prompt}
                    textareaRef={textareaRef}
                  />
                  <AnimatePresence initial={false}>
                    {errors.prompt && (
                      <motion.p key="err" role="alert" {...variants.fadeUp} className="text-xs text-danger">
                        {errors.prompt}
                      </motion.p>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
          <motion.div layout="position" layoutDependency={layoutKey} className="relative flex items-center gap-1 px-3 pt-1 pb-3">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              <StudioPicker
                studios={studios.data ?? []}
                value={studio}
                onChange={(id) => {
                  draft.setStudio(id);
                  setErrors({});
                  focus();
                }}
                loading={studios.isPending}
                error={studios.isError}
              />
              <RepoPicker repos={repoList} value={draft.repoIds} onChange={(v) => draft.set({ repoIds: v, baseRef: null })} loading={repos.isPending} />
              <BranchPicker
                repo={branchRepo}
                value={draft.baseRef}
                onChange={(v) => draft.set({ baseRef: v })}
                disabledReason={repoList.length > 1 ? s.branch.multiRepo : undefined}
              />
              <Chip
                icon={<SlidersHorizontal />}
                active={draft.advancedOpen}
                dot={advancedChanged && !draft.advancedOpen}
                aria-expanded={draft.advancedOpen}
                aria-label={advancedChanged ? `${s.advanced.toggle} (${s.advanced.changed})` : s.advanced.toggle}
                onClick={() => draft.setAdvancedOpen(!draft.advancedOpen)}
                caret={false}
              >
                {s.advanced.toggle}
              </Chip>
            </div>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={create.isPending || !!launchedId}
              icon={<ArrowUp strokeWidth={2.25} />}
              aria-keyshortcuts="Meta+Enter"
              className="rounded-[10px] pr-2"
            >
              <span className="flex items-center gap-2">
                {submitLabel}
                <Kbd shortcut={SUBMIT} tone="accent" />
              </span>
            </Button>
          </motion.div>
        </motion.form>
      </div>

      <AnimatePresence initial={false}>
        {draft.advancedOpen && (
          <motion.div key="advanced" layout="position" exit={{ opacity: 0, transition: transition.exit }}>
            <AdvancedPanel workspaceId={workspace.id} errors={errors} showFlows={!studio} />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.div layout="position" transition={spring.layout}>
        <ModePanel
          workspaceId={workspace.id}
          mode={draft.mode}
          onModeChange={(m) => {
            draft.setMode(m);
            clearError("team");
          }}
          studio={studio}
          flow={studio ? null : flow}
          teamError={errors.team}
          onTeamPicked={() => clearError("team")}
        />
      </motion.div>
    </div>
  );
}
