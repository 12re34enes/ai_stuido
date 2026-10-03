/**
 * /teams — built-in team templates and saved teams as cards: a mini org chart, member counts, the
 * provider mix, and "Bu ekiple görev başlat". Opening a card goes to the builder.
 */
import { CircleAlert, Copy, Ellipsis, ExternalLink, Play, Plus, Search, Trash2, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useNow } from "@/hooks/useNow";
import { relativeTime } from "@/i18n/format";
import { isMissingEndpoint } from "@/lib/connection";
import { commandGroups, useRegisterCommands, type StudioCommand } from "@/lib/commands";
import { foldTurkish } from "@/lib/fuzzy";
import { useCurrentWorkspace } from "@/lib/workspace";
import { spring, transition } from "@/motion/tokens";
import { Badge, Button, Dialog, EmptyState, IconButton, Input, Menu, MenuItem, MenuSeparator, ProviderMark, Skeleton, toast, Tooltip } from "@/ui";
import { uiStrings } from "@/ui/strings";

import { errorText } from "../../flows/util";
import { useCreateTeam, useDeleteTeam, useTeamCatalogEvents, useTeams } from "../api";
import { MiniOrgChart } from "../chart/MiniOrgChart";
import { teamCounts } from "../model/spec";
import { StartTeamTaskDialog } from "../StartTeamTaskDialog";
import { s } from "../strings";
import type { Team } from "../types";

/** Provider mix: a glyph and a count per provider used in the team. */
function ProviderMix({ team }: { team: Team }) {
  const c = teamCounts(team.spec);
  const label = `${uiStrings.providers.claude} ×${c.claude} · ${uiStrings.providers.codex} ×${c.codex}`;
  return (
    <span className="flex shrink-0 items-center gap-2 text-2xs text-fg-muted tabular" role="img" aria-label={label} title={label}>
      {c.claude > 0 && (
        <span className="flex items-center gap-0.5">
          <ProviderMark provider="claude" size={11} label="" />×{c.claude}
        </span>
      )}
      {c.codex > 0 && (
        <span className="flex items-center gap-0.5">
          <ProviderMark provider="codex" size={11} label="" />×{c.codex}
        </span>
      )}
    </span>
  );
}

function TeamCard({ team, index, now, onStart, onDuplicate, onDelete }: { team: Team; index: number; now: number; onStart: (t: Team) => void; onDuplicate: (t: Team) => void; onDelete: (t: Team) => void }) {
  const navigate = useNavigate();
  const open = () => void navigate(`/teams/${encodeURIComponent(team.id)}/edit`);
  const c = teamCounts(team.spec);
  const counts = [c.advisors ? s.summary.advisors(c.advisors) : null, s.summary.workers(c.workers + c.leads), c.testers ? s.summary.testers(c.testers) : null].filter(Boolean).join(" · ");
  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { ...spring.smooth, delay: Math.min(index, 8) * 0.04 } }}
      exit={{ opacity: 0, scale: 0.96, transition: transition.exit }}
      transition={spring.layout}
      whileHover={{ y: -2 }}
      className="group/card relative flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-1 transition-[box-shadow,border-color] duration-200 hover:border-line-strong hover:shadow-2"
      data-testid={`team-card-${team.id}`}
    >
      <button type="button" onClick={open} aria-label={`${team.name} — ${s.open}`} className="absolute inset-0 z-0 rounded-xl outline-none focus-visible:shadow-[var(--focus-ring)]" />
      <div className="pointer-events-none relative h-[132px] border-b border-line-subtle bg-canvas-subtle px-5 py-3">
        <MiniOrgChart spec={team.spec} className="size-full" aria-label={s.preview(team.name)} />
      </div>
      <div className="pointer-events-none relative flex flex-1 flex-col gap-1 px-4 pt-3 pb-3.5">
        <div className="flex items-center gap-2 pr-7">
          <h3 className="truncate text-md leading-6 text-fg">{team.name}</h3>
          {team.builtin && <Badge tone="accent">{s.builtin}</Badge>}
        </div>
        <p className="line-clamp-2 min-h-8 text-xs text-fg-muted">{team.description || " "}</p>
        <div className="mt-1.5 flex items-center gap-2 text-2xs text-fg-muted">
          <span className="truncate">{counts}</span>
          <span className="pointer-events-auto ml-auto flex items-center">
            <ProviderMix team={team} />
          </span>
        </div>
        {!team.builtin && (
          <div className="flex items-center gap-2 text-2xs text-fg-faint">
            <span>{s.version(team.version)}</span>
            {team.updated_at && <span className="truncate">· {s.updated(relativeTime(team.updated_at, new Date(now)))}</span>}
          </div>
        )}
      </div>
      <div className="absolute top-[140px] right-2.5 z-10 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
        <Tooltip content={s.startWithTeam} side="top">
          <IconButton size="sm" variant="secondary" label={s.startWithTeamNamed(team.name)} icon={<Play />} onClick={() => onStart(team)} data-testid={`team-start-${team.id}`} />
        </Tooltip>
        <Menu align="end" trigger={<IconButton size="sm" label={s.more} icon={<Ellipsis />} />}>
          <MenuItem icon={<ExternalLink />} onSelect={open}>
            {team.builtin ? s.open : s.edit}
          </MenuItem>
          <MenuItem icon={<Copy />} onSelect={() => onDuplicate(team)}>
            {s.duplicate}
          </MenuItem>
          {!team.builtin && (
            <>
              <MenuSeparator />
              <MenuItem icon={<Trash2 />} tone="danger" onSelect={() => onDelete(team)}>
                {s.delete}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </motion.article>
  );
}

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-1">
      <Skeleton className="h-[132px] rounded-none" />
      <div className="flex flex-col gap-2 px-4 py-3.5">
        <Skeleton height={14} width="60%" />
        <Skeleton height={10} width="85%" />
        <Skeleton height={10} width="40%" />
      </div>
    </div>
  );
}

export function TeamsListPage() {
  const navigate = useNavigate();
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const teams = useTeams(workspaceId);
  useTeamCatalogEvents();
  const create = useCreateTeam();
  const remove = useDeleteTeam();
  const now = useNow(60_000);
  const [query, setQuery] = useState("");
  const [toDelete, setToDelete] = useState<Team | null>(null);
  const [starting, setStartingTeam] = useState<Team | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const setStarting = useCallback((t: Team) => {
    setStartingTeam(t);
    setStartOpen(true);
  }, []);

  const builtins = useMemo(() => (teams.data ?? []).filter((t) => t.builtin), [teams.data]);
  const saved = useMemo(() => {
    const q = foldTurkish(query.trim());
    const list = (teams.data ?? []).filter((t) => !t.builtin);
    return q ? list.filter((t) => foldTurkish(`${t.name} ${t.description}`).includes(q)) : list;
  }, [query, teams.data]);
  const savedTotal = (teams.data ?? []).filter((t) => !t.builtin).length;

  const duplicate = async (t: Team) => {
    try {
      const copy = await create.mutateAsync({ workspace_id: workspaceId, name: `${t.name}${s.copySuffix}`, description: t.description, spec: t.spec });
      toast.success(s.duplicated, { description: copy.name, action: { label: s.open, onClick: () => void navigate(`/teams/${encodeURIComponent(copy.id)}/edit`) } });
    } catch (e) {
      toast.error(s.builder.saveFailed, { description: errorText(e) });
    }
  };

  const confirmDelete = async () => {
    const t = toDelete;
    if (!t) return;
    setToDelete(null);
    try {
      await remove.mutateAsync(t.id);
      toast.success(s.deleted, { description: t.name });
    } catch (e) {
      toast.error(s.builder.saveFailed, { description: errorText(e) });
    }
  };

  const commands = useMemo<StudioCommand[]>(
    () =>
      (teams.data ?? []).slice(0, 12).map((t, i) => ({
        id: `teams.start.${t.id}`,
        title: s.startWithTeamNamed(t.name),
        subtitle: t.description || undefined,
        group: commandGroups.actions,
        icon: Play,
        order: 40 + i,
        keywords: ["ekip", "team", "görev", "başlat", t.name],
        run: () => setStarting(t),
      })),
    [setStarting, teams.data],
  );
  useRegisterCommands(commands);

  const missing = teams.isError && isMissingEndpoint(teams.error);

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-10 px-8 pt-8 pb-16" data-testid="teams-list">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex max-w-xl flex-col gap-1.5">
          <h1 className="text-2xl text-fg">{s.pageTitle}</h1>
          <p className="text-sm text-fg-muted">{s.pageSubtitle}</p>
        </div>
        <Button variant="primary" icon={<Plus />} onClick={() => void navigate("/teams/new")} data-testid="new-team">
          {s.newTeam}
        </Button>
      </header>

      {teams.isPending ? (
        <div className="grid grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : teams.isError ? (
        <EmptyState
          icon={<CircleAlert />}
          title={s.loadError}
          description={missing ? s.missingApi : errorText(teams.error)}
          action={
            <Button size="sm" onClick={() => void teams.refetch()}>
              {s.retry}
            </Button>
          }
        />
      ) : (
        <>
          <section className="flex flex-col gap-4" aria-labelledby="saved-teams">
            <div className="flex items-center justify-between gap-4">
              <h2 id="saved-teams" className="text-lg text-fg">
                {s.savedTeams}
                {savedTotal > 0 && <span className="ml-2 font-sans text-sm text-fg-faint tabular">{savedTotal}</span>}
              </h2>
              {savedTotal > 3 && <Input size="sm" icon={<Search />} placeholder={s.searchTeams} aria-label={s.searchTeams} value={query} onChange={(e) => setQuery(e.target.value)} wrapperClassName="w-64" />}
            </div>
            {savedTotal === 0 ? (
              <div className="rounded-xl border border-dashed border-line-strong">
                <EmptyState
                  icon={<Users />}
                  title={s.emptyTitle}
                  description={s.emptyBody}
                  action={
                    <Button size="sm" variant="primary" icon={<Plus />} onClick={() => void navigate("/teams/new")}>
                      {s.newTeam}
                    </Button>
                  }
                />
              </div>
            ) : saved.length === 0 ? (
              <p className="py-6 text-center text-sm text-fg-muted">{s.noMatches}</p>
            ) : (
              <motion.div className="grid grid-cols-3 gap-4" data-testid="team-grid">
                <AnimatePresence mode="popLayout">
                  {saved.map((t, i) => (
                    <TeamCard key={t.id} team={t} index={i} now={now} onStart={setStarting} onDuplicate={(x) => void duplicate(x)} onDelete={setToDelete} />
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
          </section>

          {builtins.length > 0 && (
            <section className="flex flex-col gap-4" aria-labelledby="builtin-teams">
              <div className="flex flex-col gap-1">
                <h2 id="builtin-teams" className="text-lg text-fg">
                  {s.builtinTemplates}
                </h2>
                <p className="text-sm text-fg-muted">{s.builtinHint}</p>
              </div>
              <div className="grid grid-cols-3 gap-4" data-testid="builtin-grid">
                {builtins.map((t, i) => (
                  <TeamCard key={t.id} team={t} index={i} now={now} onStart={setStarting} onDuplicate={(x) => void duplicate(x)} onDelete={setToDelete} />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {starting && <StartTeamTaskDialog open={startOpen} onOpenChange={setStartOpen} workspaceId={workspaceId} teamId={starting.id} teamName={starting.name} spec={starting.spec} />}

      <Dialog
        open={toDelete !== null}
        onOpenChange={(o) => !o && setToDelete(null)}
        title={toDelete ? s.deleteTitle(toDelete.name) : ""}
        description={s.deleteBody}
        footer={
          <>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              {s.cancel}
            </Button>
            <Button variant="danger" onClick={() => void confirmDelete()} data-testid="confirm">
              {s.delete}
            </Button>
          </>
        }
      />
    </div>
  );
}
