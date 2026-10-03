/**
 * Server state for the connections feature (studiod `/api/remote`, `/api/deploy`, `/api/git`).
 * Lists are kept fresh by live events (see `useConnectionsLive`), not by polling.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";
import { useEventStream } from "@/lib/events";

import { CONNECTION_EVENT_TYPES, connectionInvalidations } from "./logic";
import type {
  AuditPage,
  AuditQuery,
  ClassifyLanguage,
  ClassifyResponse,
  DbProfile,
  DbProfileCreate,
  DbProfileUpdate,
  DbQueryResult,
  DbTestResult,
  DeployProfile,
  DeployProfileCreate,
  DeployProfileUpdate,
  DeployRun,
  GitAccount,
  GitAccountCreate,
  Host,
  HostCreate,
  HostTestResult,
  HostUpdate,
  RemoteAgentInfo,
  RemoteRepo,
  SqlDialect,
  SshConfigEntry,
  SshImportRequest,
  SshImportResult,
  TrustResult,
  WorkspaceRepo,
} from "./types";

export const connKeys = {
  hosts: ["connections", "hosts"] as const,
  hostAgents: (id: string) => ["connections", "hosts", id, "agents"] as const,
  sshConfig: ["connections", "ssh-config"] as const,
  dbs: ["connections", "dbs"] as const,
  deployProfiles: ["connections", "deploy", "profiles"] as const,
  deployRuns: (profileId?: string) => ["connections", "deploy", "runs", profileId ?? "all"] as const,
  deployRun: (id: string) => ["connections", "deploy", "run", id] as const,
  git: ["connections", "git"] as const,
  gitRepos: (id: string) => ["connections", "git", id, "repos"] as const,
  audit: (q: AuditQuery) => ["connections", "audit", q] as const,
};

/** Never retry 404s (endpoint not built yet) or an unreachable studiod. */
export function retry(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

const enc = encodeURIComponent;

// ----------------------------------------------------------------------------- live

/** Mount once on the connections pages: live events invalidate the affected lists. */
export function useConnectionsLive(): void {
  const qc = useQueryClient();
  useEventStream({ types: CONNECTION_EVENT_TYPES, ephemeral: false }, (batch) => {
    for (const key of connectionInvalidations(batch)) void qc.invalidateQueries({ queryKey: key });
  });
}

// ----------------------------------------------------------------------------- hosts

export function useHosts() {
  return useQuery({ queryKey: connKeys.hosts, queryFn: () => api.get<Host[]>("/remote/hosts"), retry });
}

export function useHost(id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...connKeys.hosts, id],
    queryFn: () => api.get<Host>(`/remote/hosts/${enc(id)}`),
    retry,
    initialData: () => qc.getQueryData<Host[]>(connKeys.hosts)?.find((h) => h.id === id),
  });
}

export function useSaveHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: HostCreate | HostUpdate }) =>
      id ? api.patch<Host>(`/remote/hosts/${enc(id)}`, body) : api.post<Host>("/remote/hosts", body),
    onSuccess: (host) => {
      qc.setQueryData<Host[]>(connKeys.hosts, (old) => [...(old ?? []).filter((h) => h.id !== host.id), host]);
      qc.setQueryData([...connKeys.hosts, host.id], host);
      void qc.invalidateQueries({ queryKey: connKeys.hosts });
    },
  });
}

export function useDeleteHost() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/remote/hosts/${enc(id)}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<Host[]>(connKeys.hosts, (old) => (old ?? []).filter((h) => h.id !== id));
      void qc.invalidateQueries({ queryKey: connKeys.hosts });
    },
  });
}

export function useTestHost() {
  return useMutation({ mutationFn: (id: string) => api.post<HostTestResult>(`/remote/hosts/${enc(id)}/test`) });
}

export function useTrustHost() {
  return useMutation({
    mutationFn: ({ id, fingerprint, replace }: { id: string; fingerprint: string; replace: boolean }) =>
      api.post<TrustResult>(`/remote/hosts/${enc(id)}/trust`, { fingerprint, replace }),
  });
}

export function useHostAgents(id: string, enabled: boolean) {
  return useQuery({
    queryKey: connKeys.hostAgents(id),
    queryFn: () => api.get<RemoteAgentInfo[]>(`/remote/hosts/${enc(id)}/agents`),
    retry: false,
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useSshConfig(enabled: boolean) {
  return useQuery({
    queryKey: connKeys.sshConfig,
    queryFn: () => api.get<SshConfigEntry[]>("/remote/ssh-config"),
    retry: false,
    enabled,
    staleTime: 0,
  });
}

export function useImportSshConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SshImportRequest) => api.post<SshImportResult>("/remote/hosts/import-ssh-config", body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: connKeys.hosts });
      void qc.invalidateQueries({ queryKey: connKeys.sshConfig });
    },
  });
}

// ----------------------------------------------------------------------------- databases

export function useDbProfiles() {
  return useQuery({ queryKey: connKeys.dbs, queryFn: () => api.get<DbProfile[]>("/remote/db-profiles"), retry });
}

export function useDbProfile(id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...connKeys.dbs, id],
    queryFn: () => api.get<DbProfile>(`/remote/db-profiles/${enc(id)}`),
    retry,
    initialData: () => qc.getQueryData<DbProfile[]>(connKeys.dbs)?.find((d) => d.id === id),
  });
}

export function useSaveDbProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: DbProfileCreate | DbProfileUpdate }) =>
      id ? api.patch<DbProfile>(`/remote/db-profiles/${enc(id)}`, body) : api.post<DbProfile>("/remote/db-profiles", body),
    onSuccess: (db) => {
      qc.setQueryData<DbProfile[]>(connKeys.dbs, (old) => [...(old ?? []).filter((d) => d.id !== db.id), db]);
      qc.setQueryData([...connKeys.dbs, db.id], db);
      void qc.invalidateQueries({ queryKey: connKeys.dbs });
    },
  });
}

export function useDeleteDbProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/remote/db-profiles/${enc(id)}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<DbProfile[]>(connKeys.dbs, (old) => (old ?? []).filter((d) => d.id !== id));
      void qc.invalidateQueries({ queryKey: connKeys.dbs });
    },
  });
}

export function useTestDb() {
  return useMutation({ mutationFn: (id: string) => api.post<DbTestResult>(`/remote/db-profiles/${enc(id)}/test`) });
}

export function useRunQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, query, reason, maxRows }: { id: string; query: string; reason?: string; maxRows: number }) =>
      api.post<DbQueryResult>(`/remote/db-profiles/${enc(id)}/query`, { query, reason: reason || null, max_rows: maxRows }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["connections", "audit"] }),
  });
}

export function useClassify(language: ClassifyLanguage, dialect: SqlDialect, text: string) {
  return useQuery({
    queryKey: ["connections", "classify", language, dialect, text],
    queryFn: () => api.post<ClassifyResponse>("/remote/classify", { language, dialect, text }),
    enabled: text.trim().length > 0,
    retry: false,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

// ----------------------------------------------------------------------------- audit

export function useAudit(q: AuditQuery, enabled = true) {
  return useQuery({
    queryKey: connKeys.audit(q),
    queryFn: () => api.get<AuditPage>("/remote/audit", { ...q }),
    retry,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function fetchAuditPage(q: AuditQuery, beforeId: number) {
  return api.get<AuditPage>("/remote/audit", { ...q, before_id: beforeId });
}

// ----------------------------------------------------------------------------- deploy

export function useDeployProfiles() {
  return useQuery({ queryKey: connKeys.deployProfiles, queryFn: () => api.get<DeployProfile[]>("/deploy/profiles"), retry });
}

export function useDeployProfile(id: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...connKeys.deployProfiles, id],
    queryFn: () => api.get<DeployProfile>(`/deploy/profiles/${enc(id)}`),
    retry,
    initialData: () => qc.getQueryData<DeployProfile[]>(connKeys.deployProfiles)?.find((p) => p.id === id),
  });
}

export function useSaveDeployProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: DeployProfileCreate | DeployProfileUpdate }) =>
      id ? api.patch<DeployProfile>(`/deploy/profiles/${enc(id)}`, body) : api.post<DeployProfile>("/deploy/profiles", body),
    onSuccess: (p) => {
      qc.setQueryData<DeployProfile[]>(connKeys.deployProfiles, (old) => [...(old ?? []).filter((x) => x.id !== p.id), p]);
      qc.setQueryData([...connKeys.deployProfiles, p.id], p);
      void qc.invalidateQueries({ queryKey: connKeys.deployProfiles });
    },
  });
}

export function useDeleteDeployProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/deploy/profiles/${enc(id)}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<DeployProfile[]>(connKeys.deployProfiles, (old) => (old ?? []).filter((p) => p.id !== id));
      void qc.invalidateQueries({ queryKey: connKeys.deployProfiles });
    },
  });
}

export function useWorkspaceRepos(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["connections", "workspace-repos", workspaceId ?? ""],
    queryFn: () => api.get<WorkspaceRepo[]>(`/workspaces/${enc(workspaceId ?? "")}/repos`),
    enabled: Boolean(workspaceId),
    retry,
    staleTime: 60_000,
  });
}

export function useDeployRuns(profileId?: string) {
  return useQuery({
    queryKey: connKeys.deployRuns(profileId),
    queryFn: () => api.get<DeployRun[]>("/deploy/runs", { profile_id: profileId, limit: 50 }),
    retry,
  });
}

export function useDeployRun(id: string | null) {
  return useQuery({
    queryKey: connKeys.deployRun(id ?? ""),
    queryFn: () => api.get<DeployRun>(`/deploy/runs/${enc(id ?? "")}`),
    enabled: Boolean(id),
    retry,
  });
}

function useRunMutation<V>(fn: (v: V) => Promise<DeployRun>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (run) => {
      qc.setQueryData(connKeys.deployRun(run.id), run);
      void qc.invalidateQueries({ queryKey: ["connections", "deploy", "runs"] });
    },
  });
}

export function useStartDeploy() {
  return useRunMutation(({ profileId, ref, summary }: { profileId: string; ref?: string; summary?: string }) =>
    api.post<DeployRun>(`/deploy/profiles/${enc(profileId)}/run`, { ref: ref || null, summary: summary || null }),
  );
}

export function useRollbackDeploy() {
  return useRunMutation((id: string) => api.post<DeployRun>(`/deploy/runs/${enc(id)}/rollback`));
}

export function useCancelDeploy() {
  return useRunMutation((id: string) => api.post<DeployRun>(`/deploy/runs/${enc(id)}/cancel`));
}

// ----------------------------------------------------------------------------- git accounts

export function useGitAccounts() {
  return useQuery({ queryKey: connKeys.git, queryFn: () => api.get<GitAccount[]>("/git/accounts"), retry });
}

export function useAddGitAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: GitAccountCreate) => api.post<GitAccount>("/git/accounts", body),
    onSuccess: (acc) => {
      qc.setQueryData<GitAccount[]>(connKeys.git, (old) => [...(old ?? []).filter((a) => a.id !== acc.id), acc]);
      void qc.invalidateQueries({ queryKey: connKeys.git });
    },
  });
}

export function useVerifyGitAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<GitAccount>(`/git/accounts/${enc(id)}/verify`),
    onSuccess: (acc) => qc.setQueryData<GitAccount[]>(connKeys.git, (old) => (old ?? []).map((a) => (a.id === acc.id ? acc : a))),
  });
}

export function useDeleteGitAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/git/accounts/${enc(id)}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<GitAccount[]>(connKeys.git, (old) => (old ?? []).filter((a) => a.id !== id));
      void qc.invalidateQueries({ queryKey: connKeys.git });
    },
  });
}

export function useGitRepos(id: string, enabled: boolean) {
  return useQuery({
    queryKey: connKeys.gitRepos(id),
    queryFn: () => api.get<RemoteRepo[]>(`/git/accounts/${enc(id)}/repos`, { limit: 200 }),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
}
