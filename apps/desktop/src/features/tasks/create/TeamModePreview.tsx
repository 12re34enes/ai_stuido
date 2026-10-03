/**
 * The composer's "Ekip" mode preview: the chosen team's mini org chart (a calm baton runs down the
 * tree), a team picker (built-in templates and saved teams) and "Özelleştir", which opens the
 * team builder in a sheet — the edited spec is sent inline with the task, the template stays.
 */
import { PencilRuler, RotateCcw, Settings2, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useSettings } from "@/lib/queries";
import { spring, transition, variants } from "@/motion/tokens";
import { Badge, Button, Skeleton } from "@/ui";

import { DEFAULT_TEAM_ID, DEFAULT_TEAM_SETTING, useTeams } from "../../teams/api";
import { TeamBuilderSheet } from "../../teams/builder/TeamBuilderSheet";
import { MiniOrgChart } from "../../teams/chart/MiniOrgChart";
import { summaryText } from "../../teams/model/spec";
import { s as ts } from "../../teams/strings";
import { useComposer } from "./composerStore";
import { Chip, PickerPopover, type PickerItem } from "./Picker";

export function TeamModePreview({ workspaceId, error, onPicked }: { workspaceId: string; error?: string; onPicked?: () => void }) {
  const navigate = useNavigate();
  const teams = useTeams(workspaceId);
  const teamId = useComposer((st) => st.teamId);
  const custom = useComposer((st) => st.teamSpec);
  const [sheetOpen, setSheetOpen] = useState(false);
  const list = useMemo(() => teams.data ?? [], [teams.data]);
  const team = list.find((t) => t.id === teamId) ?? null;
  const spec = custom ?? team?.spec ?? null;

  // Default to the engine's default team (`engine.default_team_id`, "hizli-ekip" out of the box)
  // once the list is known, or when the chosen one disappeared; else the first team.
  const settings = useSettings();
  const configured = settings.data?.[DEFAULT_TEAM_SETTING];
  const defaultId = typeof configured === "string" && configured ? configured : DEFAULT_TEAM_ID;
  useEffect(() => {
    if (!teams.isSuccess || !list.length || settings.isPending) return;
    if (!teamId || !list.some((t) => t.id === teamId)) useComposer.getState().setTeam((list.find((t) => t.id === defaultId) ?? list[0]!).id);
  }, [defaultId, list, settings.isPending, teamId, teams.isSuccess]);

  const items: PickerItem[] = list.map((t) => ({
    value: t.id,
    label: t.name,
    description: summaryText(t.spec),
    icon: <Users />,
    group: t.builtin ? ts.builtinTemplates : ts.savedTeams,
    keywords: t.description,
  }));

  if (teams.isPending) {
    return (
      <div className="flex h-[104px] items-center gap-6 px-2" aria-hidden>
        <Skeleton width={168} height={84} className="rounded-lg" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton width={160} height={14} />
          <Skeleton width="70%" height={10} />
        </div>
      </div>
    );
  }

  if (teams.isError || list.length === 0) {
    return (
      <div className="flex h-[104px] flex-col items-center justify-center gap-2 text-center">
        <p className="text-xs text-fg-muted">{teams.isError ? ts.composer.pickerLoadFailed : ts.composer.noTeams}</p>
        <Button size="sm" variant="secondary" icon={<Users />} onClick={() => void navigate(teams.isError ? "/teams" : "/teams/new")}>
          {teams.isError ? ts.composer.manage : ts.newTeam}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-[104px] items-center gap-5" data-testid="team-mode-preview">
      <div className="relative h-[104px] w-[200px] shrink-0 rounded-xl border border-line-subtle bg-canvas-subtle px-3 py-2.5">
        <AnimatePresence mode="popLayout" initial={false}>
          {spec && (
            <motion.div key={`${team?.id ?? "x"}:${custom ? "custom" : "tpl"}:${spec.members.length}`} {...variants.fade} className="size-full">
              <MiniOrgChart spec={spec} animated className="size-full" aria-label={ts.preview(team?.name ?? ts.composer.mode)} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <PickerPopover
            label={ts.composer.picker}
            items={items}
            selected={[teamId ?? ""]}
            onSelect={(v) => {
              useComposer.getState().setTeam(v);
              onPicked?.();
            }}
            searchPlaceholder={ts.composer.pickerSearch}
            emptyText={ts.composer.pickerEmpty}
            width={340}
            footer={
              <button type="button" className="text-xs text-accent outline-none hover:underline focus-visible:shadow-[var(--focus-ring)]" onClick={() => void navigate("/teams")}>
                {ts.composer.manage}
              </button>
            }
            trigger={
              <Chip icon={<Users />} active aria-label={`${ts.composer.picker}: ${team?.name ?? ts.composer.choose}`} data-testid="team-picker">
                {team?.name ?? ts.composer.choose}
              </Chip>
            }
          />
          <AnimatePresence initial={false}>
            {custom && (
              <motion.span key="custom" className="flex items-center gap-1" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1, transition: spring.snappy }} exit={{ opacity: 0, scale: 0.8, transition: transition.exit }}>
                <Badge tone="accent" icon={<PencilRuler />}>
                  {ts.composer.customized}
                </Badge>
                <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => useComposer.getState().setTeamSpec(null)}>
                  {ts.composer.reset}
                </Button>
              </motion.span>
            )}
          </AnimatePresence>
          <Button size="sm" variant="ghost" icon={<Settings2 />} disabled={!spec} onClick={() => setSheetOpen(true)} className="ml-auto" data-testid="team-customize">
            {ts.composer.customize}
          </Button>
        </div>
        {spec && <p className="truncate text-xs text-fg-muted">{summaryText(spec)}</p>}
        {team?.description && <p className="line-clamp-1 text-xs text-fg-faint">{team.description}</p>}
        <AnimatePresence initial={false}>
          {error && (
            <motion.p key="err" role="alert" {...variants.fadeUp} className="text-xs text-danger">
              {error}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
      {spec && (
        <TeamBuilderSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          spec={spec}
          name={team?.name ?? ts.builder.untitled}
          onApply={(next) => useComposer.getState().setTeamSpec(next)}
          onSaved={(saved) => {
            useComposer.getState().setTeam(saved.id);
            setSheetOpen(false);
          }}
        />
      )}
    </div>
  );
}
