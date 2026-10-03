/**
 * The home composer's draft. Lives outside React so palette commands ("Yeni görev: Kurul") can set
 * the mode before the page mounts, and the draft survives navigating away and back.
 */
import { create } from "zustand";

import { readPref, writePref } from "@/lib/storage";

import type { TeamSpec } from "../../teams/types";
import { MODES, type BuiltinMode } from "../list/types";

export type ScheduleChoice = "now" | "reset" | "at";

/** Composer modes: the built-in flow modes plus "Ekip" (a team runs the task, spec §25). */
export type ComposerMode = BuiltinMode | "team";
export const COMPOSER_MODES: readonly ComposerMode[] = [...MODES, "team"];

export interface BudgetDraft {
  fiveHour: string;
  weekly: string;
  duration: string;
  turns: string;
}

export interface ComposerDraft {
  title: string;
  prompt: string;
  mode: ComposerMode;
  /** mode "team": the saved team / built-in template… */
  teamId: string | null;
  /** …or its spec customized for this task (sent inline as `team`, wins over `team_id`). */
  teamSpec: TeamSpec | null;
  studioId: string | null;
  studioInputs: Record<string, string>;
  /** null = every repo of the workspace. */
  repoIds: string[] | null;
  baseRef: string | null;
  flowId: string | null;
  budget: BudgetDraft;
  priority: number;
  schedule: ScheduleChoice;
  /** `datetime-local` value (local time) when schedule = "at". */
  scheduledAt: string;
}

interface ComposerState extends ComposerDraft {
  advancedOpen: boolean;
  /** Workspace the workspace-bound choices (repos, branch, flow, studio values) belong to. */
  workspaceId: string | null;
  /** Switch the draft to a workspace, dropping choices that belonged to another one. */
  bindWorkspace: (workspaceId: string) => void;
  set: (patch: Partial<ComposerDraft>) => void;
  setMode: (mode: ComposerMode) => void;
  /** Pick a team (drops a customization of the previous one). */
  setTeam: (teamId: string | null) => void;
  setTeamSpec: (spec: TeamSpec | null) => void;
  setStudio: (studioId: string | null) => void;
  setStudioInput: (name: string, value: string) => void;
  setBudget: (patch: Partial<BudgetDraft>) => void;
  setAdvancedOpen: (open: boolean) => void;
  /** Clear the draft after a successful submit (keeps the mode). */
  reset: () => void;
}

export const EMPTY_BUDGET: BudgetDraft = { fiveHour: "", weekly: "", duration: "", turns: "" };

function initialMode(): ComposerMode {
  const saved = readPref<string>("composer.mode", "duo");
  return (COMPOSER_MODES as readonly string[]).includes(saved) ? (saved as ComposerMode) : "duo";
}

const blank = (): Omit<ComposerDraft, "mode" | "teamId"> => ({
  title: "",
  prompt: "",
  teamSpec: null,
  studioId: null,
  studioInputs: {},
  repoIds: null,
  baseRef: null,
  flowId: null,
  budget: { ...EMPTY_BUDGET },
  priority: 0,
  schedule: "now",
  scheduledAt: "",
});

export const useComposer = create<ComposerState>()((set) => ({
  ...blank(),
  mode: initialMode(),
  teamId: readPref<string | null>("composer.team", null),
  advancedOpen: false,
  workspaceId: null,
  bindWorkspace: (workspaceId) =>
    set((s) => (s.workspaceId === workspaceId ? s : { workspaceId, repoIds: null, baseRef: null, flowId: null, studioInputs: {}, teamSpec: null })),
  set: (patch) => set(patch),
  setMode: (mode) => {
    writePref("composer.mode", mode);
    set({ mode, flowId: null });
  },
  setTeam: (teamId) => {
    writePref("composer.team", teamId);
    set({ teamId, teamSpec: null });
  },
  setTeamSpec: (teamSpec) => set({ teamSpec }),
  setStudio: (studioId) => set({ studioId, studioInputs: {} }),
  setStudioInput: (name, value) => set((s) => ({ studioInputs: { ...s.studioInputs, [name]: value } })),
  setBudget: (patch) => set((s) => ({ budget: { ...s.budget, ...patch } })),
  setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
  reset: () => set((s) => ({ ...blank(), mode: s.mode, teamId: s.teamId, advancedOpen: false })),
}));

/** Whether any advanced option differs from its default (shown as a dot on "Gelişmiş"). */
export function hasAdvanced(d: Pick<ComposerDraft, "budget" | "priority" | "schedule" | "flowId">): boolean {
  return (
    d.priority !== 0 ||
    d.schedule !== "now" ||
    d.flowId !== null ||
    Object.values(d.budget).some((v) => v.trim() !== "")
  );
}
