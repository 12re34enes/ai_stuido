/**
 * Server state for the sessions feature (backend `agents/api.py`, `/api/remote/hosts`,
 * `/api/workspaces/{id}/repos`). Endpoints that do not exist yet answer 404: the hooks then
 * error quietly (no retries) and the UI hides the dependent piece.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";
import { queryKeys } from "@/lib/queries";
import type { AgentRole, AgentState, Environment, Provider, SessionRecord, Usage } from "@/lib/types";

export interface SessionView extends SessionRecord {
  /** A CLI process is attached in this studiod. */
  live?: boolean;
}

export interface AgentProfile {
  id: string;
  workspace_id: string | null;
  name: string;
  provider: Provider;
  model: string | null;
  effort: string | null;
  role: AgentRole;
  instructions: string;
  color: string | null;
  builtin?: boolean;
}

export interface AdapterHealth {
  provider: Provider;
  installed: boolean;
  binary: string | null;
  version: string | null;
  logged_in: boolean | null;
  compatible: boolean | null;
  tested_range: string | null;
  message: string | null;
}

export interface NativeLocation {
  kind: "local" | "remote";
  host_id: string | null;
}

export interface DiscoveredSession {
  provider: Provider;
  native_id: string;
  location: NativeLocation;
  cwd: string | null;
  title: string | null;
  model: string | null;
  branch: string | null;
  message_count: number | null;
  created_at: string | null;
  updated_at: string | null;
  file_path: string | null;
  running: boolean;
  imported_session_id: string | null;
}

export interface RemoteHost {
  id: string;
  workspace_id: string | null;
  name: string;
  hostname: string;
  port: number;
  username: string;
  environment: Environment;
  permission_level: string;
}

export interface Repo {
  id: string;
  workspace_id: string;
  name: string;
  path: string;
  host_id: string | null;
  default_branch: string;
}

export interface StartSessionBody {
  workspace_id: string;
  spec: { provider: Provider; cwd: string; location: NativeLocation; model?: string | null; title?: string | null };
  profile_id?: string | null;
  label?: string | null;
  initial_prompt?: string | null;
}

export const sessionKeys = {
  all: ["agents", "sessions", "all"] as const,
  one: (id: string) => ["agents", "sessions", "one", id] as const,
  profiles: (workspaceId: string | null) => ["agents", "profiles", workspaceId] as const,
  health: (hostId: string | null) => ["agents", "health", hostId] as const,
  discover: (hostId: string | null, cwd: string) => ["agents", "discover", hostId, cwd] as const,
  hosts: ["remote", "hosts"] as const,
  repos: (workspaceId: string | null) => ["workspaces", workspaceId, "repos"] as const,
};

/** Never retry 404s or "studiod is down"; retry other failures twice. */
export function quietRetry(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

export function useSessions() {
  return useQuery({
    queryKey: sessionKeys.all,
    queryFn: () => api.get<SessionView[]>("/agents/sessions"),
    retry: quietRetry,
  });
}

export function useSession(id: string | undefined) {
  return useQuery({
    queryKey: sessionKeys.one(id ?? ""),
    queryFn: () => api.get<SessionView>(`/agents/sessions/${encodeURIComponent(id ?? "")}`),
    enabled: Boolean(id),
    retry: quietRetry,
  });
}

export function useProfiles(workspaceId: string | null) {
  return useQuery({
    queryKey: sessionKeys.profiles(workspaceId),
    queryFn: () => api.get<AgentProfile[]>("/agents/profiles", { workspace_id: workspaceId ?? undefined }),
    retry: quietRetry,
    staleTime: 60_000,
  });
}

export function useAgentHealth(hostId: string | null = null) {
  return useQuery({
    queryKey: sessionKeys.health(hostId),
    queryFn: () => api.get<AdapterHealth[]>("/agents/health", { host_id: hostId ?? undefined }),
    retry: quietRetry,
    staleTime: 5 * 60_000,
  });
}

export function useDiscover(hostId: string | null, cwd: string, enabled = true) {
  return useQuery({
    queryKey: sessionKeys.discover(hostId, cwd),
    queryFn: () => api.get<DiscoveredSession[]>("/agents/discover", { host_id: hostId ?? undefined, cwd: cwd || undefined }),
    retry: quietRetry,
    enabled,
    staleTime: 30_000,
  });
}

export function useRemoteHosts() {
  return useQuery({
    queryKey: sessionKeys.hosts,
    queryFn: () => api.get<RemoteHost[]>("/remote/hosts"),
    retry: quietRetry,
    staleTime: 60_000,
  });
}

export function useRepos(workspaceId: string | null) {
  return useQuery({
    queryKey: sessionKeys.repos(workspaceId),
    queryFn: () => api.get<Repo[]>(`/workspaces/${encodeURIComponent(workspaceId ?? "")}/repos`),
    enabled: Boolean(workspaceId),
    retry: quietRetry,
    staleTime: 60_000,
  });
}

/** Insert or replace a session in every cached list/detail. */
export function upsertSession(qc: QueryClient, s: SessionView) {
  qc.setQueryData<SessionView[]>(sessionKeys.all, (old) => (old ? [s, ...old.filter((x) => x.id !== s.id)] : old));
  qc.setQueryData(sessionKeys.one(s.id), s);
}

export function useStartSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: StartSessionBody) => api.post<SessionView>("/agents/sessions", body),
    onSuccess: (s) => {
      upsertSession(qc, s);
      void qc.invalidateQueries({ queryKey: queryKeys.activeSessions });
    },
  });
}

export function useImportSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { workspace_id: string; session: DiscoveredSession }) => {
      // The import body is NativeSessionInfo: drop the discovery-only field.
      const { imported_session_id: _ignored, ...session } = body.session;
      return api.post<SessionView>("/agents/import", { workspace_id: body.workspace_id, session });
    },
    onSuccess: (s, vars) => {
      upsertSession(qc, s);
      // Mark it imported in every cached discovery list.
      qc.setQueriesData<DiscoveredSession[]>({ queryKey: ["agents", "discover"] }, (old) =>
        old?.map((d) => (d.provider === vars.session.provider && d.native_id === vars.session.native_id ? { ...d, imported_session_id: s.id } : d)),
      );
    },
  });
}

export function useSessionControl(sessionId: string) {
  const qc = useQueryClient();
  const path = `/agents/sessions/${encodeURIComponent(sessionId)}`;
  const send = useMutation({ mutationFn: (text: string) => api.post<{ turn_id: string }>(`${path}/send`, { text }) });
  const steer = useMutation({ mutationFn: (text: string) => api.post<void>(`${path}/steer`, { text }) });
  const interrupt = useMutation({ mutationFn: () => api.post<void>(`${path}/interrupt`) });
  const close = useMutation({
    mutationFn: () => api.post<SessionView>(`${path}/close`),
    onSuccess: (s) => {
      upsertSession(qc, s);
      void qc.invalidateQueries({ queryKey: queryKeys.activeSessions });
    },
  });
  return { send, steer, interrupt, close };
}

/** Patch a cached session (list + detail) from a live event. */
export function patchSession(qc: QueryClient, id: string, patch: Partial<SessionView>) {
  qc.setQueryData<SessionView[]>(sessionKeys.all, (old) => old?.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  qc.setQueryData<SessionView>(sessionKeys.one(id), (old) => (old ? { ...old, ...patch } : old));
}

export type { AgentState, Usage };
