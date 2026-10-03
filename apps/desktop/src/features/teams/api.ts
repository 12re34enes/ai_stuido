/**
 * Server state for teams (React Query over `lib/api`). Endpoints (studiod, under /api):
 *   GET/POST /engine/teams · GET/PUT/DELETE /engine/teams/{id} (?version=) ·
 *   GET /engine/teams/{id}/versions · POST /engine/teams/validate
 *   GET /engine/runs/{run_id}/team (?node_id=) · POST /engine/runs/{run_id}/team/members/{id}/message
 *   POST /engine/tasks (mode "team" + team_id | team) · GET /agents/profiles · GET /agents/sessions?run_id=
 * Saves answer 422 `Ekip geçersiz: …` (details.errors: TeamIssue[]) when invalid and 409 for built-ins;
 * `team.template.saved|deleted` events refresh the catalog. Payloads go through model/wire.ts.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";
import { useEventStream } from "@/lib/events";

import type { AgentProfile } from "../flows/types";
import { parseReport } from "./model/validate";
import { asList, parseRunView, parseTeam, parseTeams, parseVersions } from "./model/wire";
import type { MemberMessageResult, MessageDelivery, MessageMode, RunSession, Team, TeamCreate, TeamSpec, TeamUpdate, TeamValidationReport } from "./types";

export const teamKeys = {
  all: ["engine", "teams"] as const,
  list: (ws: string | null) => ["engine", "teams", "list", ws] as const,
  team: (id: string) => ["engine", "teams", "one", id] as const,
  version: (id: string, v: number) => ["engine", "teams", "one", id, "v", v] as const,
  versions: (id: string) => ["engine", "teams", "one", id, "versions"] as const,
  run: (runId: string, nodeId: string | null) => ["engine", "teams", "run", runId, nodeId] as const,
  sessions: (runId: string) => ["engine", "teams", "run", runId, "sessions"] as const,
  profiles: (ws: string | null) => ["agents", "profiles", ws] as const,
};

/** The team a mode=team task gets when it names none (engine setting, built-in default). */
export const DEFAULT_TEAM_SETTING = "engine.default_team_id";
export const DEFAULT_TEAM_ID = "hizli-ekip";

/** Retry transient errors only (never 404s or an unreachable studiod). */
export function retry(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

const enc = encodeURIComponent;

/** Built-in templates first (in the engine's order), then saved teams (newest first). */
export function sortTeams(list: readonly Team[]): Team[] {
  return [...list].sort((a, b) => {
    if (a.builtin !== b.builtin) return a.builtin ? -1 : 1;
    if (a.builtin) return 0;
    return (b.updated_at ?? "").localeCompare(a.updated_at ?? "");
  });
}

export function useTeams(workspaceId: string | null, enabled = true) {
  return useQuery({
    queryKey: teamKeys.list(workspaceId),
    queryFn: async () => sortTeams(parseTeams(await api.get<unknown>("/engine/teams", { workspace_id: workspaceId }))),
    enabled,
    retry,
    staleTime: 30_000,
  });
}

/** Keep the catalog fresh when teams are saved / deleted elsewhere (`team.template.saved|deleted`). */
export function useTeamCatalogEvents() {
  const qc = useQueryClient();
  useEventStream({ types: ["team.template.saved", "team.template.deleted"] }, (batch) => {
    const ids = new Set(batch.map((e) => (e.payload as { team_id?: unknown } | null)?.team_id).filter((v): v is string => typeof v === "string"));
    void qc.invalidateQueries({ queryKey: ["engine", "teams", "list"] });
    for (const id of ids) void qc.invalidateQueries({ queryKey: teamKeys.team(id) });
  });
}

export async function fetchTeam(id: string, version?: number): Promise<Team> {
  const t = parseTeam(await api.get<unknown>(`/engine/teams/${enc(id)}`, version ? { version } : undefined));
  if (!t) throw new Error("Ekip yanıtı okunamadı.");
  return t;
}

export function useTeam(id: string | null) {
  return useQuery({
    queryKey: teamKeys.team(id ?? ""),
    queryFn: () => fetchTeam(id!),
    enabled: !!id,
    retry,
    staleTime: Infinity,
  });
}

export function useTeamVersions(id: string | null) {
  return useQuery({
    queryKey: teamKeys.versions(id ?? ""),
    queryFn: async () => parseVersions(await api.get<unknown>(`/engine/teams/${enc(id!)}/versions`)),
    enabled: !!id,
    retry,
  });
}

function cacheTeam(qc: ReturnType<typeof useQueryClient>, team: Team) {
  qc.setQueryData(teamKeys.team(team.id), team);
  for (const [key, list] of qc.getQueriesData<Team[]>({ queryKey: ["engine", "teams", "list"] })) {
    if (Array.isArray(list)) qc.setQueryData(key, sortTeams([...list.filter((t) => t.id !== team.id), team]));
  }
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: TeamCreate) => {
      const t = parseTeam(await api.post<unknown>("/engine/teams", body));
      if (!t) throw new Error("Ekip yanıtı okunamadı.");
      return t;
    },
    onSuccess: (team) => {
      cacheTeam(qc, team);
      void qc.invalidateQueries({ queryKey: ["engine", "teams", "list"] });
    },
  });
}

export function useUpdateTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }: { id: string; body: TeamUpdate }) => {
      const t = parseTeam(await api.put<unknown>(`/engine/teams/${enc(id)}`, body));
      if (!t) throw new Error("Ekip yanıtı okunamadı.");
      return t;
    },
    onSuccess: (team) => {
      cacheTeam(qc, team);
      void qc.invalidateQueries({ queryKey: teamKeys.versions(team.id) });
      void qc.invalidateQueries({ queryKey: ["engine", "teams", "list"] });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/engine/teams/${enc(id)}`),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["engine", "teams", "list"] });
      const snapshots = qc.getQueriesData<Team[]>({ queryKey: ["engine", "teams", "list"] });
      for (const [key, list] of snapshots) if (Array.isArray(list)) qc.setQueryData(key, list.filter((t) => t.id !== id));
      return { snapshots };
    },
    onError: (_e, _id, ctx) => {
      for (const [key, list] of ctx?.snapshots ?? []) qc.setQueryData(key, list);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["engine", "teams", "list"] }),
  });
}

/**
 * A save refused as invalid (`422 "Ekip geçersiz: …"` with `details.errors: TeamIssue[]`) as a
 * validation report, so the builder can mark the members; null for any other error.
 */
export function reportFromSaveError(e: unknown): TeamValidationReport | null {
  if (!(e instanceof ApiError) || e.status !== 422 || !Array.isArray(e.details.errors)) return null;
  const report = parseReport({ ok: false, errors: e.details.errors, warnings: [] });
  return report && report.errors.length ? report : null;
}

/** Server-side validation; resolves null when the endpoint is unavailable (local checks remain). */
export async function validateTeam(spec: TeamSpec): Promise<TeamValidationReport | null> {
  try {
    return parseReport(await api.post<unknown>("/engine/teams/validate", spec));
  } catch (e) {
    if (isMissingEndpoint(e) || isUnreachable(e)) return null;
    throw e;
  }
}

// ----------------------------------------------------------------------------- runs

export function useTeamRun(runId: string | null, nodeId: string | null) {
  return useQuery({
    queryKey: teamKeys.run(runId ?? "", nodeId),
    queryFn: async () => {
      const view = parseRunView(await api.get<unknown>(`/engine/runs/${enc(runId!)}/team`, nodeId ? { node_id: nodeId } : undefined), runId!);
      if (!view) throw new Error("Ekip görünümü okunamadı.");
      return view;
    },
    enabled: !!runId,
    retry,
  });
}

export function useRunSessions(runId: string | null) {
  return useQuery({
    queryKey: teamKeys.sessions(runId ?? ""),
    queryFn: async () => asList(await api.get<unknown>("/agents/sessions", { run_id: runId! })) as RunSession[],
    enabled: !!runId,
    retry,
    staleTime: 10_000,
  });
}

const DELIVERIES: readonly MessageDelivery[] = ["steer", "queued", "turn", "direct"];

/** `MemberMessageBody {text, mode, node_id}` → `MemberMessageResult {member_id, session_id, delivered}`. */
export function useMemberMessage(runId: string, nodeId: string | null) {
  return useMutation({
    mutationFn: async ({ memberId, text, mode }: { memberId: string; text: string; mode: MessageMode }): Promise<MemberMessageResult> => {
      const raw = await api.post<Partial<MemberMessageResult> | undefined>(`/engine/runs/${enc(runId)}/team/members/${enc(memberId)}/message`, { text, mode, node_id: nodeId });
      const delivered = raw && DELIVERIES.includes(raw.delivered as MessageDelivery) ? (raw.delivered as MessageDelivery) : mode === "steer" ? "steer" : "queued";
      return { member_id: raw?.member_id ?? memberId, session_id: raw?.session_id ?? null, delivered };
    },
  });
}

// ----------------------------------------------------------------------------- tasks & pickers

export interface TeamTaskBody {
  workspace_id: string;
  title: string;
  prompt: string;
  mode: "team";
  team_id?: string | null;
  team?: TeamSpec | null;
  start?: boolean;
}

export function useStartTeamTask() {
  return useMutation({
    mutationFn: (body: TeamTaskBody) => api.post<{ task: { id: string; title: string; status: string } }>("/engine/tasks", body),
  });
}

export function useProfiles(workspaceId: string | null) {
  return useQuery({
    queryKey: teamKeys.profiles(workspaceId),
    queryFn: async () => asList(await api.get<unknown>("/agents/profiles", { workspace_id: workspaceId })) as AgentProfile[],
    retry,
    staleTime: 60_000,
  });
}
