/** Server state for Ayarlar (agents, limits, alerts, backup, system). Live via `useSettingsLive`. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { useEventStream } from "@/lib/events";

import { retry } from "@/features/connections/api";

import { SETTINGS_EVENT_TYPES, settingsInvalidations } from "./logic";
import type {
  AdapterHealth,
  AgentProfile,
  AlertDefaults,
  AlertRule,
  AlertRuleInput,
  AlertSettings,
  BackupInfo,
  BackupSettings,
  Channel,
  ChannelCreate,
  ChannelKindSpec,
  ChannelUpdate,
  DeliveryLogEntry,
  DeliveryOutcome,
  LimitsOverview,
  LinkCode,
  ProfileInput,
  QuietHours,
  RestoreResult,
  SystemInfo,
} from "./types";

const enc = encodeURIComponent;

export const setKeys = {
  profiles: ["settings", "profiles"] as const,
  health: (hostId: string | null) => ["settings", "health", hostId ?? "local"] as const,
  limits: ["settings", "limits"] as const,
  kinds: ["settings", "alerts", "kinds"] as const,
  channels: ["settings", "alerts", "channels"] as const,
  rules: ["settings", "alerts", "rules"] as const,
  defaults: ["settings", "alerts", "defaults"] as const,
  quiet: ["settings", "alerts", "quiet"] as const,
  log: (status: string) => ["settings", "alerts", "log", status] as const,
  backups: ["settings", "backup", "list"] as const,
  backupSettings: ["settings", "backup", "settings"] as const,
  system: ["settings", "system"] as const,
};

export function useSettingsLive(): void {
  const qc = useQueryClient();
  useEventStream({ types: SETTINGS_EVENT_TYPES, ephemeral: false }, (batch) => {
    for (const key of settingsInvalidations(batch)) void qc.invalidateQueries({ queryKey: key });
  });
}

// ----------------------------------------------------------------------------- agents

export function useProfiles() {
  return useQuery({ queryKey: setKeys.profiles, queryFn: () => api.get<AgentProfile[]>("/agents/profiles"), retry });
}

export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: ProfileInput }) =>
      id ? api.patch<AgentProfile>(`/agents/profiles/${enc(id)}`, body) : api.post<AgentProfile>("/agents/profiles", body),
    onSuccess: (p) => {
      qc.setQueryData<AgentProfile[]>(setKeys.profiles, (old) => (old?.some((x) => x.id === p.id) ? old.map((x) => (x.id === p.id ? p : x)) : [...(old ?? []), p]));
      void qc.invalidateQueries({ queryKey: setKeys.profiles });
    },
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/agents/profiles/${enc(id)}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<AgentProfile[]>(setKeys.profiles, (old) => (old ?? []).filter((p) => p.id !== id));
      void qc.invalidateQueries({ queryKey: setKeys.profiles });
    },
  });
}

export function useHealth(hostId: string | null, enabled = true) {
  return useQuery({
    queryKey: setKeys.health(hostId),
    queryFn: () => api.get<AdapterHealth[]>("/agents/health", { host_id: hostId ?? undefined }),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

// ----------------------------------------------------------------------------- limits

export function useLimitsOverview() {
  return useQuery({
    queryKey: setKeys.limits,
    // Older studiod builds answered a bare list of windows.
    queryFn: async () => {
      const data = await api.get<LimitsOverview | LimitsOverview["windows"]>("/limits");
      return Array.isArray(data) ? { windows: data, availability: {}, generated_at: new Date().toISOString() } : data;
    },
    retry,
    refetchInterval: 60_000,
  });
}

export function useRefreshLimits() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<LimitsOverview>("/limits/refresh"),
    onSuccess: (o) => {
      qc.setQueryData(setKeys.limits, o);
      void qc.invalidateQueries({ queryKey: ["limits"] });
    },
  });
}

// ----------------------------------------------------------------------------- alerts

export function useChannelKinds() {
  return useQuery({ queryKey: setKeys.kinds, queryFn: () => api.get<ChannelKindSpec[]>("/alerts/kinds"), retry, staleTime: Infinity });
}

export function useChannels() {
  return useQuery({ queryKey: setKeys.channels, queryFn: () => api.get<Channel[]>("/alerts/channels"), retry });
}

export const SAVE_CHANNEL_KEY = ["settings", "alerts", "save-channel"] as const;

export function useSaveChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: SAVE_CHANNEL_KEY,
    mutationFn: ({ id, body }: { id?: string; body: ChannelCreate | ChannelUpdate }) =>
      id ? api.patch<Channel>(`/alerts/channels/${enc(id)}`, body) : api.post<Channel>("/alerts/channels", body),
    onSuccess: (c) => {
      qc.setQueryData<Channel[]>(setKeys.channels, (old) => (old?.some((x) => x.id === c.id) ? old.map((x) => (x.id === c.id ? c : x)) : [...(old ?? []), c]));
      void qc.invalidateQueries({ queryKey: setKeys.channels });
    },
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/alerts/channels/${enc(id)}`),
    onSuccess: (_r, id) => {
      qc.setQueryData<Channel[]>(setKeys.channels, (old) => (old ?? []).filter((c) => c.id !== id));
      void qc.invalidateQueries({ queryKey: setKeys.channels });
      void qc.invalidateQueries({ queryKey: setKeys.rules });
    },
  });
}

export function useTestChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<DeliveryOutcome>(`/alerts/channels/${enc(id)}/test`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["settings", "alerts", "log"] }),
  });
}

export function useLinkChannel() {
  return useMutation({ mutationFn: (id: string) => api.post<LinkCode>(`/alerts/channels/${enc(id)}/link`) });
}

export function useRules() {
  return useQuery({ queryKey: setKeys.rules, queryFn: () => api.get<AlertRule[]>("/alerts/rules"), retry });
}

export function useSaveRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: Partial<AlertRuleInput> }) =>
      id ? api.patch<AlertRule>(`/alerts/rules/${enc(id)}`, body) : api.post<AlertRule>("/alerts/rules", body),
    onSuccess: (r) => {
      qc.setQueryData<AlertRule[]>(setKeys.rules, (old) => (old?.some((x) => x.id === r.id) ? old.map((x) => (x.id === r.id ? r : x)) : [...(old ?? []), r]));
      void qc.invalidateQueries({ queryKey: setKeys.rules });
    },
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/alerts/rules/${enc(id)}`),
    onSuccess: (_r, id) => qc.setQueryData<AlertRule[]>(setKeys.rules, (old) => (old ?? []).filter((r) => r.id !== id)),
  });
}

export function useAlertDefaults() {
  return useQuery({ queryKey: setKeys.defaults, queryFn: () => api.get<AlertDefaults>("/alerts/defaults"), retry });
}

export function useUpdateAlertSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<AlertSettings> & { clear_primary_channel?: boolean }) => api.put<AlertDefaults>("/alerts/defaults", body),
    onMutate: (body) => {
      qc.setQueryData<AlertDefaults>(setKeys.defaults, (old) => (old ? { ...old, settings: { ...old.settings, ...body } } : old));
    },
    onSuccess: (d) => qc.setQueryData(setKeys.defaults, d),
    onError: () => void qc.invalidateQueries({ queryKey: setKeys.defaults }),
  });
}

export function useQuietHours() {
  return useQuery({ queryKey: setKeys.quiet, queryFn: () => api.get<QuietHours>("/alerts/quiet-hours"), retry });
}

export function useSaveQuietHours() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: QuietHours) => api.put<QuietHours>("/alerts/quiet-hours", body),
    onSuccess: (q) => {
      qc.setQueryData(setKeys.quiet, q);
      void qc.invalidateQueries({ queryKey: setKeys.defaults });
    },
  });
}

export function useDeliveryLog(status: string) {
  return useQuery({
    queryKey: setKeys.log(status),
    queryFn: () => api.get<DeliveryLogEntry[]>("/alerts/log", { limit: 50, status: status || undefined }),
    retry,
  });
}

// ----------------------------------------------------------------------------- backup & system

export function useBackups() {
  return useQuery({ queryKey: setKeys.backups, queryFn: () => api.get<BackupInfo[]>("/backup"), retry });
}

export function useBackupSettings() {
  return useQuery({ queryKey: setKeys.backupSettings, queryFn: () => api.get<BackupSettings>("/backup/settings"), retry });
}

export function useSaveBackupSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Pick<BackupSettings, "interval_hours" | "keep">> & { dir?: string }) => api.put<BackupSettings>("/backup/settings", body),
    onSuccess: (b) => qc.setQueryData(setKeys.backupSettings, b),
  });
}

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<BackupInfo>("/backup"),
    onSuccess: (b) => {
      qc.setQueryData<BackupInfo[]>(setKeys.backups, (old) => [b, ...(old ?? []).filter((x) => x.name !== b.name)]);
      void qc.invalidateQueries({ queryKey: ["settings", "backup"] });
    },
  });
}

export function useRestoreBackup() {
  return useMutation({
    mutationFn: ({ name, safety }: { name: string; safety: boolean }) => api.post<RestoreResult>(`/backup/${enc(name)}/restore`, { safety_backup: safety }),
  });
}

export function useSystem() {
  return useQuery({ queryKey: setKeys.system, queryFn: () => api.get<SystemInfo>("/system"), retry });
}
