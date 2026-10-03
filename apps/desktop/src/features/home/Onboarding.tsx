/**
 * First run: create a workspace → add a repo → check the agent CLIs → write the first task.
 * Shown while there is no workspace, or the workspace has no repo (until finished or skipped).
 */
import { ArrowLeft, ArrowRight, FolderGit2, RotateCw, Sparkle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type FormEvent, type ReactNode } from "react";

import { ApiError } from "@/lib/api";
import { useCreateWorkspace } from "@/lib/queries";
import type { Provider, Workspace } from "@/lib/types";
import { useWorkspaceStore } from "@/lib/workspace";
import { useShake } from "@/motion/hooks";
import { spring, transition, variants } from "@/motion/tokens";
import { Badge, Button, CopyButton, Field, Input, ProviderMark, Skeleton, cn, toast } from "@/ui";
import { GateMark } from "@/ui/flow";

import { useAddRepo, useAgentHealth } from "../tasks/create/queries";
import type { AdapterHealth } from "../tasks/create/types";
import { homeStrings } from "./strings";

const s = homeStrings.onboarding;

export type OnboardingStep = "workspace" | "repo" | "cli" | "ready";
const STEPS: OnboardingStep[] = ["workspace", "repo", "cli", "ready"];

function Stepper({ current }: { current: OnboardingStep }) {
  const index = STEPS.indexOf(current);
  return (
    <ol className="flex items-center gap-2" aria-label={s.stepOf(index + 1, STEPS.length)}>
      {STEPS.map((step, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li key={step} className={cn("flex items-center gap-2", i < STEPS.length - 1 ? "flex-auto" : "flex-none")} aria-current={active ? "step" : undefined}>
            <span className="relative grid size-5 shrink-0 place-items-center">
              {done ? (
                <GateMark status="passed" size={18} label={s.steps[step]} />
              ) : (
                <motion.span
                  className={cn("grid size-[18px] place-items-center rounded-full border-[1.5px] text-2xs font-semibold tabular", active ? "border-accent text-accent" : "border-line-strong text-fg-faint")}
                  initial={false}
                  animate={{ scale: active ? 1 : 0.92 }}
                  transition={spring.bouncy}
                >
                  {i + 1}
                </motion.span>
              )}
            </span>
            <span className={cn("shrink-0 text-xs whitespace-nowrap", active ? "font-medium text-fg" : done ? "text-fg-muted" : "text-fg-faint")}>{s.steps[step]}</span>
            {i < STEPS.length - 1 && (
              <span className="relative ml-1 h-px min-w-3 flex-1 overflow-hidden bg-line" aria-hidden>
                <motion.span className="absolute inset-0 origin-left bg-success" initial={false} animate={{ scaleX: done ? 1 : 0 }} transition={spring.fill} />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function StepFrame({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg leading-[26px] text-fg">{title}</h2>
        <p className="text-sm text-fg-muted">{description}</p>
      </div>
      {children}
    </div>
  );
}

function WorkspaceStep({ onCreated }: { onCreated: (ws: Workspace) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useCreateWorkspace();
  const [scope, shake] = useShake<HTMLFormElement>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(s.workspace.empty);
      shake();
      return;
    }
    create.mutate(
      { name: name.trim() },
      {
        onSuccess: (ws) => {
          useWorkspaceStore.getState().setCurrentId(ws.id);
          onCreated(ws);
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : String(err));
          shake();
        },
      },
    );
  };
  return (
    <StepFrame title={s.workspace.title} description={s.workspace.description}>
      <form ref={scope} onSubmit={submit} className="flex flex-col gap-4">
        <Field label={s.workspace.name} htmlFor="onb-ws-name" error={error}>
          <Input
            id="onb-ws-name"
            size="lg"
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            placeholder={s.workspace.placeholder}
            invalid={!!error}
          />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={create.isPending} iconRight={<ArrowRight />}>
            {s.workspace.create}
          </Button>
        </div>
      </form>
    </StepFrame>
  );
}

function RepoStep({ workspace, onAdded, onSkip }: { workspace: Workspace; onAdded: () => void; onSkip: () => void }) {
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = useAddRepo(workspace.id);
  const [scope, shake] = useShake<HTMLFormElement>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) {
      setError(s.repo.empty);
      shake();
      return;
    }
    add.mutate(
      { path: path.trim(), name: name.trim() || null },
      {
        onSuccess: (repo) => {
          toast({ title: s.repo.added(repo.name), tone: "success" });
          onAdded();
        },
        onError: (err) => {
          setError(err instanceof ApiError || err instanceof Error ? err.message : String(err));
          shake();
        },
      },
    );
  };
  return (
    <StepFrame title={s.repo.title} description={s.repo.description}>
      <form ref={scope} onSubmit={submit} className="flex flex-col gap-4">
        <Field label={s.repo.path} htmlFor="onb-repo-path" hint={s.repo.pathHint} error={error}>
          <Input
            id="onb-repo-path"
            size="lg"
            autoFocus
            icon={<FolderGit2 />}
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setError(null);
            }}
            placeholder={s.repo.pathPlaceholder}
            invalid={!!error}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="font-mono text-sm"
          />
        </Field>
        <Field label={s.repo.name} htmlFor="onb-repo-name">
          <Input id="onb-repo-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={s.repo.namePlaceholder} />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={onSkip}>
            {s.repo.skip}
          </Button>
          <Button type="submit" variant="primary" loading={add.isPending} iconRight={<ArrowRight />}>
            {s.repo.add}
          </Button>
        </div>
      </form>
    </StepFrame>
  );
}

function Command({ text }: { text: string }) {
  return (
    <span className="flex h-8 items-center gap-2 rounded-md border border-line bg-code pr-1 pl-2.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" data-selectable>
        {text}
      </code>
      <CopyButton value={text} size="xs" />
    </span>
  );
}

function healthState(h: AdapterHealth | undefined): "ok" | "missing" | "login" | "version" {
  if (!h || !h.installed) return "missing";
  if (h.compatible === false) return "version";
  if (h.logged_in === false) return "login";
  return "ok";
}

function ProviderHealth({ provider, health }: { provider: Provider; health: AdapterHealth | undefined }) {
  const state = healthState(health);
  const label = state === "ok" ? s.cli.ok : state === "missing" ? s.cli.notInstalled : state === "login" ? s.cli.loggedOut : s.cli.incompatible;
  return (
    <motion.li layout="position" className="flex flex-col gap-2.5 rounded-[12px] border border-line bg-surface px-4 py-3" {...variants.fadeUp}>
      <div className="flex items-center gap-3">
        <ProviderMark provider={provider} variant="tile" size={28} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-fg">{s.cli.names[provider]}</span>
          <span className="truncate text-xs text-fg-muted">
            {health?.version ? s.cli.version(health.version) : (health?.binary ?? "")}
            {state === "version" && health?.tested_range ? ` · ${s.cli.testedRange(health.tested_range)}` : ""}
          </span>
        </div>
        <Badge tone={state === "ok" ? "success" : state === "missing" ? "danger" : "warning"} dot>
          {label}
        </Badge>
      </div>
      <AnimatePresence initial={false}>
        {state !== "ok" && (
          <motion.div key={state} {...variants.fadeUp} className="flex flex-col gap-1.5">
            {health?.message && <p className="text-xs text-fg-muted">{health.message}</p>}
            <p className="text-xs text-fg-muted">{state === "login" ? s.cli.loginHint[provider] : s.cli.installHint}</p>
            <Command text={state === "login" ? s.cli.login[provider] : s.cli.install[provider]} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

function CliStep({ onContinue }: { onContinue: () => void }) {
  const health = useAgentHealth();
  const byProvider = new Map((health.data ?? []).map((h) => [h.provider, h]));
  const anyReady = (health.data ?? []).some((h) => healthState(h) === "ok");
  return (
    <StepFrame title={s.cli.title} description={s.cli.description}>
      {health.isPending ? (
        <div className="flex flex-col gap-2" aria-label={s.cli.checking}>
          <Skeleton height={56} className="rounded-[12px]" />
          <Skeleton height={56} className="rounded-[12px]" />
        </div>
      ) : health.isError ? (
        <p className="rounded-[12px] border border-dashed border-line px-4 py-3 text-sm text-fg-muted">{s.cli.error}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {(["claude", "codex"] as const).map((p) => (
            <ProviderHealth key={p} provider={p} health={byProvider.get(p)} />
          ))}
        </ul>
      )}
      <AnimatePresence initial={false}>
        {health.data && !anyReady && (
          <motion.p key="none" {...variants.fadeUp} className="text-xs text-warning">
            {s.cli.noneReady}
          </motion.p>
        )}
      </AnimatePresence>
      <div className="flex items-center justify-between gap-2">
        <Button variant="secondary" icon={<RotateCw />} loading={health.isFetching} onClick={() => void health.refetch()}>
          {health.isFetching ? s.cli.checking : s.cli.recheck}
        </Button>
        <Button variant="primary" iconRight={<ArrowRight />} onClick={onContinue}>
          {s.cli.continue}
        </Button>
      </div>
    </StepFrame>
  );
}

function ReadyStep({ onStart }: { onStart: () => void }) {
  return (
    <StepFrame title={s.ready.title} description={s.ready.description}>
      <div className="flex justify-end">
        <Button variant="primary" icon={<Sparkle />} onClick={onStart} autoFocus>
          {s.ready.start}
        </Button>
      </div>
    </StepFrame>
  );
}

export interface OnboardingProps {
  workspace: Workspace | null;
  initialStep: OnboardingStep;
  /** Called when the user makes progress (keeps the flow on screen after data changes). */
  onProgress: () => void;
  /** Called when finished or when the repo step was skipped for good. */
  onFinish: (opts: { skippedRepo: boolean }) => void;
}

export function Onboarding({ workspace, initialStep, onProgress, onFinish }: OnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [dir, setDir] = useState(1);
  const [skippedRepo, setSkippedRepo] = useState(false);
  const go = (next: OnboardingStep) => {
    setDir(STEPS.indexOf(next) >= STEPS.indexOf(step) ? 1 : -1);
    setStep(next);
  };
  const canGoBack = step === "cli" || step === "ready";

  return (
    <div className="mx-auto flex w-full max-w-[540px] flex-col gap-8 px-8 pt-[12vh] pb-16">
      <motion.div className="flex flex-col items-center gap-3 text-center" {...variants.fadeUp}>
        <motion.span
          className="grid size-10 place-items-center rounded-[12px] bg-accent text-fg-on-accent shadow-2"
          initial={{ rotate: -40, scale: 0.6, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          transition={spring.bouncy}
        >
          <Sparkle className="size-5" />
        </motion.span>
        <h1 className="text-2xl text-fg">{s.title}</h1>
        <p className="text-sm text-fg-muted">{s.subtitle}</p>
      </motion.div>

      <motion.div
        className="relative overflow-hidden rounded-[18px] border border-line bg-surface p-7 shadow-2"
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1, transition: spring.gentle }}
      >
        <div className="mb-7 flex items-center gap-3">
          <AnimatePresence initial={false}>
            {canGoBack && (
              <motion.button
                key="back"
                type="button"
                aria-label={s.back}
                onClick={() => go(step === "ready" ? "cli" : "repo")}
                className="-ml-2 grid size-7 place-items-center rounded-md text-fg-muted outline-none transition-colors hover:bg-surface-hover hover:text-fg focus-visible:shadow-[var(--focus-ring)]"
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7, transition: transition.exit }}
              >
                <ArrowLeft className="size-4" />
              </motion.button>
            )}
          </AnimatePresence>
          <div className="min-w-0 flex-1">
            <Stepper current={step} />
          </div>
        </div>
        <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <motion.div
            key={step}
            custom={dir}
            variants={{
              initial: (d: number) => ({ opacity: 0, x: 28 * d }),
              animate: { opacity: 1, x: 0, transition: spring.smooth },
              exit: (d: number) => ({ opacity: 0, x: -20 * d, transition: transition.exit }),
            }}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {step === "workspace" && (
              <WorkspaceStep
                onCreated={() => {
                  onProgress();
                  go("repo");
                }}
              />
            )}
            {step === "repo" && workspace && (
              <RepoStep
                workspace={workspace}
                onAdded={() => {
                  onProgress();
                  go("cli");
                }}
                onSkip={() => {
                  onProgress();
                  setSkippedRepo(true);
                  go("cli");
                }}
              />
            )}
            {step === "cli" && <CliStep onContinue={() => go("ready")} />}
            {step === "ready" && <ReadyStep onStart={() => onFinish({ skippedRepo })} />}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
