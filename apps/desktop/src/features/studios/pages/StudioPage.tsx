import { Copy, History, Lock, MoreHorizontal, Pencil, ShieldCheck, Workflow } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, stagger, variants } from "@/motion/tokens";
import { Button, EmptyState, IconButton, Menu, MenuItem, ProviderMark, Skeleton, SkeletonText } from "@/ui";

import { useStudio, useStudios } from "../api";
import { BackLink, LoadError, Page, SectionHeader } from "../components/Page";
import { RunForm } from "../components/RunForm";
import { StudioVersionBadges } from "../components/StudioCard";
import { StudioIcon } from "../components/StudioIcon";
import { StudioTasks } from "../components/StudioTasks";
import { FlowPreview } from "../components/FlowPreview";
import { useShortcut } from "../hooks";
import { sharedIds } from "../icons";
import { stepCount, studioGates, studioTeam } from "../model";
import { gateDescriptions, nodeKindLabels, studioStrings as s } from "../strings";
import type { Studio } from "../types";
import { NewStudioDialog } from "./NewStudioDialog";

const panel = "rounded-xl border border-line bg-surface shadow-1";

function Hero({ studio }: { studio: Studio }) {
  const team = studioTeam(studio.graph);
  return (
    <motion.section layoutId={sharedIds.surface(studio.id)} transition={spring.layout} className={`${panel} relative overflow-hidden px-7 py-6`}>
      <div className="flex items-start gap-5">
        <StudioIcon name={studio.icon} size="lg" layoutId={sharedIds.icon(studio.id)} />
        <motion.div layout="position" transition={spring.layout} className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <motion.h1 layoutId={sharedIds.name(studio.id)} layout="position" transition={spring.layout} className="text-2xl text-fg">
              {studio.name}
            </motion.h1>
            <StudioVersionBadges studio={studio} size="md" />
          </div>
          <motion.p {...variants.fadeUp} className="max-w-[72ch] text-base leading-[1.6] text-fg-muted">
            {studio.description}
          </motion.p>
          <motion.dl {...variants.fadeUp} className="mt-1 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div className="flex items-center gap-2">
              <dt className="sr-only">{s.team}</dt>
              <dd className="flex items-center gap-1.5 text-fg-muted">
                <span className="flex -space-x-1">
                  {team.slice(0, 5).map((m) =>
                    m.provider ? <ProviderMark key={m.nodeId} provider={m.provider} variant="tile" size={18} label="" className="ring-2 ring-surface" /> : null,
                  )}
                </span>
                {s.agents(team.length)}
              </dd>
            </div>
            <div className="flex items-center gap-1.5 text-fg-muted">
              <Workflow className="size-3.5 text-fg-faint" aria-hidden />
              <dt className="sr-only">{s.flow}</dt>
              <dd>{s.steps(stepCount(studio.graph))}</dd>
            </div>
            <div className="text-fg-muted">
              <dt className="sr-only">{s.run}</dt>
              <dd>{s.inputs(studio.inputs?.length ?? 0)}</dd>
            </div>
          </motion.dl>
        </motion.div>
      </div>
    </motion.section>
  );
}

function TeamList({ studio }: { studio: Studio }) {
  const team = useMemo(() => studioTeam(studio.graph), [studio.graph]);
  return (
    <motion.ul className="flex flex-col" initial="initial" animate="animate" variants={stagger(0.035, 0.1)}>
      {team.map((m) => (
        <motion.li key={m.nodeId} variants={variants.listItem} className="flex items-center gap-3 border-b border-line-subtle py-2.5 last:border-0">
          {m.provider ? (
            <ProviderMark provider={m.provider} variant="tile" size={24} />
          ) : (
            <span className="grid size-6 place-items-center rounded-md bg-surface-sunken text-2xs text-fg-muted">{nodeKindLabels[m.kind]?.[0]}</span>
          )}
          <div className="flex min-w-0 flex-col">
            <span className={m.provider === "claude" ? "truncate font-serif text-sm text-fg" : m.provider === "codex" ? "truncate font-mono text-xs font-medium text-fg" : "truncate text-sm text-fg"}>
              {m.label}
            </span>
            <span className="truncate text-2xs text-fg-muted">{m.role}</span>
          </div>
        </motion.li>
      ))}
    </motion.ul>
  );
}

function GateList({ studio }: { studio: Studio }) {
  const gates = useMemo(() => studioGates(studio.graph), [studio.graph]);
  if (gates.length === 0) return <p className="py-2 text-xs text-fg-faint">{s.noGates}</p>;
  return (
    <motion.ul className="flex flex-col gap-2.5" initial="initial" animate="animate" variants={stagger(0.035, 0.15)}>
      {gates.map((g) => (
        <motion.li key={g.kind} variants={variants.listItem} className="flex items-start gap-2.5">
          <span className={g.locked ? "mt-px grid size-6 shrink-0 place-items-center rounded-md bg-warning-soft text-warning" : "mt-px grid size-6 shrink-0 place-items-center rounded-md bg-success-soft text-success"}>
            {g.locked ? <Lock className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm text-fg">
              {g.label}
              {g.count > 1 && <span className="ml-1 text-xs text-fg-faint">×{g.count}</span>}
            </span>
            <span className="text-xs text-fg-muted">{gateDescriptions[g.kind]}</span>
          </div>
        </motion.li>
      ))}
    </motion.ul>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className={`${panel} flex gap-5 px-7 py-6`}>
        <Skeleton className="size-14 rounded-[16px]" />
        <div className="flex flex-1 flex-col gap-3">
          <Skeleton width="30%" height={22} />
          <SkeletonText lines={2} />
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_400px] gap-6">
        <Skeleton height={340} className="rounded-xl" />
        <Skeleton height={420} className="rounded-xl" />
      </div>
    </div>
  );
}

export function StudioPage({ studioId }: { studioId: string }) {
  const navigate = useNavigate();
  const { data: studio, isError, error, refetch, isPlaceholderData } = useStudio(studioId);
  const { data: studios } = useStudios();
  const { workspace } = useCurrentWorkspace();
  const [copyOpen, setCopyOpen] = useState(false);
  const edit = () => void navigate(`/studios/${encodeURIComponent(studioId)}/edit`);
  useShortcut("⌘E", edit, !!studio);

  return (
    <Page wide>
      <motion.div {...variants.fade} className="flex h-8 items-center justify-between pb-5">
        <BackLink to="/studios">{s.back}</BackLink>
        {studio && (
          <motion.div {...variants.fade} className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" icon={<Pencil />} onClick={edit}>
              {s.edit}
            </Button>
            <Menu
              align="end"
              trigger={<IconButton label="Diğer" icon={<MoreHorizontal />} size="md" variant="ghost" />}
            >
              <MenuItem icon={<History />} onSelect={() => void navigate(`/studios/${encodeURIComponent(studioId)}/edit?panel=versions`)}>
                {s.history}
              </MenuItem>
              <MenuItem icon={<Copy />} onSelect={() => setCopyOpen(true)}>
                {s.copyAsNew}
              </MenuItem>
            </Menu>
          </motion.div>
        )}
      </motion.div>

      {isError && !studio ? (
        <LoadError title={s.notFound} error={error} onRetry={() => void refetch()} className="mt-12" />
      ) : !studio ? (
        <DetailSkeleton />
      ) : (
        <div className="flex flex-col gap-6">
          <Hero studio={studio} />
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
            <motion.div className="flex min-w-0 flex-col gap-6" initial="initial" animate="animate" variants={stagger(0.05, 0.08)}>
              <motion.section variants={variants.fadeUp} className={`${panel} flex flex-col gap-4 p-5`} aria-labelledby="studio-flow">
                <SectionHeader id="studio-flow" title={s.flow} hint={s.flowHint} />
                {isPlaceholderData ? (
                  <Skeleton height={300} className="rounded-lg" />
                ) : (
                  <FlowPreview graph={studio.graph} className="h-[300px]" aria-label={`${studio.name}: ${s.flow}`} />
                )}
              </motion.section>
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <motion.section variants={variants.fadeUp} className={`${panel} flex flex-col gap-2 p-5`} aria-labelledby="studio-team">
                  <SectionHeader id="studio-team" title={s.teamTitle} />
                  <TeamList studio={studio} />
                </motion.section>
                <motion.section variants={variants.fadeUp} className={`${panel} flex flex-col gap-3 p-5`} aria-labelledby="studio-gates">
                  <SectionHeader id="studio-gates" title={s.gatesTitle} />
                  <GateList studio={studio} />
                </motion.section>
              </div>
              <motion.section variants={variants.fadeUp} className={`${panel} flex flex-col gap-3 p-5`} aria-labelledby="studio-outputs">
                <SectionHeader id="studio-outputs" title={s.outputs} hint={s.outputsHint} />
                {workspace ? <StudioTasks workspaceId={workspace.id} studioId={studio.id} /> : <p className="text-xs text-fg-faint">{s.noWorkspaceHint}</p>}
              </motion.section>
            </motion.div>
            <motion.aside {...variants.fadeUp} className={`${panel} sticky top-6 flex flex-col gap-5 p-5`} aria-labelledby="studio-run">
              <SectionHeader id="studio-run" title={s.run} hint={s.runHint} />
              {workspace ? (
                isPlaceholderData ? (
                  <SkeletonText lines={6} />
                ) : (
                  <RunForm key={`${studio.id}:${studio.version ?? 1}:${workspace.id}`} studio={studio} workspace={workspace} />
                )
              ) : (
                <EmptyState size="sm" title={s.noWorkspace} description={s.noWorkspaceHint} />
              )}
            </motion.aside>
          </div>
        </div>
      )}
      <NewStudioDialog open={copyOpen} onOpenChange={setCopyOpen} studios={studios ?? []} initialTemplate={studioId} />
    </Page>
  );
}
