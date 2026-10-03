/**
 * Home (spec §19 "Ana ekran"): calm and centered. A large task composer with mode / studio /
 * repo pickers; below it active tasks as live flow strips, "Seni bekleyenler" and recent tasks.
 * First run (no workspace or repo) shows a short onboarding instead.
 */
import { RotateCw, Sparkle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createElement, useMemo, useState } from "react";

import { useNow } from "@/hooks/useNow";
import { useShell } from "@/lib/shell";
import { readPref, writePref } from "@/lib/storage";
import type { Workspace } from "@/lib/types";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, variants } from "@/motion/tokens";
import { Button, EmptyState, Skeleton } from "@/ui";

import { installTaskCommands } from "../tasks/create/commands";
import { useComposer } from "../tasks/create/composerStore";
import { studioIcon } from "../tasks/create/icons";
import { useRepos, useStudios } from "../tasks/create/queries";
import { TaskComposer } from "../tasks/create/TaskComposer";
import { useTaskLiveSync } from "../tasks/list/live";
import { useTasks } from "../tasks/list/queries";
import { ACTIVE, type TaskStatus } from "../tasks/list/types";
import { ActiveTasks } from "./ActiveTasks";
import { Onboarding, type OnboardingStep } from "./Onboarding";
import { RecentTasks } from "./RecentTasks";
import { Section } from "./Section";
import { homeStrings as s } from "./strings";
import { useWorkspaceApprovals } from "./approvals";
import { WaitingForYou } from "./WaitingForYou";

installTaskCommands();

const ACTIVE_STATUSES: TaskStatus[] = ["running", "waiting", "queued"];
const onboardedKey = (workspaceId: string) => `home.onboarded.${workspaceId}`;

function Greeting({ workspace }: { workspace: Workspace }) {
  const now = useNow(60_000);
  const hour = new Date(now).getHours();
  return (
    <motion.header className="flex flex-col items-center gap-2 text-center" {...variants.fadeUp}>
      <h1 className="flex items-center gap-2.5 text-2xl text-fg">
        <motion.span
          aria-hidden
          className="grid text-accent"
          initial={{ rotate: -50, scale: 0.5, opacity: 0 }}
          animate={{ rotate: 0, scale: 1, opacity: 1 }}
          transition={{ ...spring.bouncy, delay: 0.05 }}
        >
          <Sparkle className="size-6" strokeWidth={1.75} />
        </motion.span>
        {s.greeting(hour)}
      </h1>
      <p className="text-sm text-fg-muted">{s.subtitle(workspace.name)}</p>
    </motion.header>
  );
}

function QuickStart() {
  const studios = useStudios();
  const list = (studios.data ?? []).slice(0, 6);
  if (!list.length) return null;
  return (
    <Section id="quick" title={s.quickStart.title}>
      <p className="-mt-1 px-4 text-xs text-fg-faint">{s.quickStart.hint}</p>
      <motion.ul className="flex flex-wrap gap-2" initial="initial" animate="animate" variants={{ animate: { transition: { staggerChildren: 0.035 } } }}>
        {list.map((st) => (
          <motion.li key={st.id} variants={variants.listItem}>
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              transition={spring.snappy}
              onClick={() => {
                useComposer.getState().setStudio(st.id);
                useShell.getState().requestComposerFocus();
              }}
              className="flex h-9 items-center gap-2 rounded-[10px] border border-line bg-surface px-3 text-sm text-fg shadow-1 outline-none transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-2 focus-visible:shadow-[var(--focus-ring)]"
              title={st.description}
            >
              {createElement(studioIcon(st.icon), { className: "size-4 text-claude-strong" })}
              {st.name}
            </motion.button>
          </motion.li>
        ))}
      </motion.ul>
    </Section>
  );
}

function HomeMain({ workspace }: { workspace: Workspace }) {
  const active = useTasks({ workspaceId: workspace.id, statuses: ACTIVE_STATUSES, limit: 20 });
  const recent = useTasks({ workspaceId: workspace.id, limit: 12 });
  const approvals = useWorkspaceApprovals(workspace.id);

  // Live patches can turn an active task terminal before the list refetches: filter client-side too.
  const activeList = useMemo(() => (active.data ?? []).filter((t) => ACTIVE.includes(t.status)), [active.data]);
  const recentList = useMemo(() => (recent.data ?? []).filter((t) => !ACTIVE.includes(t.status)).slice(0, 6), [recent.data]);
  const noTasks = recent.isSuccess && recent.data.length === 0 && activeList.length === 0;
  const showRecent = recent.isPending || recent.isError || recentList.length > 0;

  return (
    <div className="mx-auto flex w-full max-w-[768px] flex-col px-8 pt-[9vh] pb-24">
      <Greeting workspace={workspace} />
      <TaskComposer workspace={workspace} className="mt-8" />
      <div className="mt-12 flex flex-col gap-10">
        <AnimatePresence initial={false} mode="popLayout">
          {activeList.length > 0 && <ActiveTasks key="active" tasks={activeList} workspaceId={workspace.id} />}
          {approvals.length > 0 && <WaitingForYou key="waiting" approvals={approvals} />}
          {noTasks ? (
            <QuickStart key="quick" />
          ) : (
            showRecent && (
              <RecentTasks key="recent" tasks={recentList} loading={recent.isPending} error={recent.error} onRetry={() => void recent.refetch()} />
            )
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[768px] flex-col items-center gap-8 px-8 pt-[9vh]" aria-hidden>
      <Skeleton width={220} height={30} />
      <Skeleton height={172} className="w-full rounded-[18px]" />
    </div>
  );
}

export default function HomePage() {
  const { workspace, workspaces, query } = useCurrentWorkspace();
  const repos = useRepos(workspace?.id);
  const [onboarding, setOnboarding] = useState(false);
  const [finished, setFinished] = useState<string | null>(null);
  useTaskLiveSync(workspace?.id);

  let view: "loading" | "error" | "onboarding" | "main";
  if (query.isPending) view = "loading";
  else if (query.isError && workspaces.length === 0) view = "error";
  else if (onboarding) view = "onboarding";
  else if (!workspace) view = "onboarding";
  else if (repos.isPending) view = "loading";
  else if (repos.isSuccess && repos.data.length === 0 && finished !== workspace.id && !readPref(onboardedKey(workspace.id), false)) view = "onboarding";
  else view = "main";

  const initialStep: OnboardingStep = !workspace ? "workspace" : "repo";

  return (
    <AnimatePresence mode="wait" initial={false}>
      {view === "loading" && (
        <motion.div key="loading" {...variants.fade}>
          <HomeSkeleton />
        </motion.div>
      )}
      {view === "error" && (
        <motion.div key="error" {...variants.fade} className="pt-[18vh]">
          <EmptyState
            icon={<RotateCw />}
            title={s.loadError.title}
            description={query.error instanceof Error ? query.error.message : undefined}
            action={
              <Button variant="secondary" icon={<RotateCw />} onClick={() => void query.refetch()}>
                {s.loadError.retry}
              </Button>
            }
          />
        </motion.div>
      )}
      {view === "onboarding" && (
        <motion.div key="onboarding" {...variants.fade}>
          <Onboarding
            workspace={workspace}
            initialStep={initialStep}
            onProgress={() => setOnboarding(true)}
            onFinish={() => {
              if (workspace) {
                writePref(onboardedKey(workspace.id), true);
                setFinished(workspace.id);
              }
              setOnboarding(false);
              useShell.getState().requestComposerFocus();
            }}
          />
        </motion.div>
      )}
      {view === "main" && workspace && (
        <motion.div key={`main:${workspace.id}`} {...variants.fade}>
          <HomeMain workspace={workspace} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
