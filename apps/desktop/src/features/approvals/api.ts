/**
 * Approvals server state (backend `approvals/module.py`). The pending list shares the shell's
 * query key, so the top-bar counter, the inbox, the menu bar and inline cards stay in sync.
 * Decisions are optimistic: the card leaves the pending list at once and comes back on error.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { api, ApiError } from "@/lib/api";
import { useEventStream, type StudioEvent } from "@/lib/events";
import { queryKeys } from "@/lib/queries";
import type { Approval, ApprovalStatus } from "@/lib/types";

import { quietRetry } from "../sessions/api";

/** Backend Approval incl. the decision payload (lib/types omits it). */
export interface ApprovalRecord extends Approval {
  decision_payload?: Record<string, unknown> | null;
}

export const approvalKeys = {
  pending: queryKeys.approvals,
  decided: ["approvals", "decided"] as const,
  one: (id: string) => ["approvals", "one", id] as const,
};

const DECIDED: ApprovalStatus[] = ["approved", "rejected", "expired", "cancelled"];

function asList(data: unknown): ApprovalRecord[] {
  if (Array.isArray(data)) return data as ApprovalRecord[];
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as ApprovalRecord[]) : [];
}

export function usePendingApprovalList() {
  return useQuery({
    queryKey: approvalKeys.pending,
    queryFn: async () => asList(await api.get<unknown>("/approvals", { status: "pending" })),
    retry: quietRetry,
  });
}

/** Decided approvals: the list endpoint filters one status at a time, so ask for each. */
export function useDecidedApprovals(enabled = true) {
  return useQuery({
    queryKey: approvalKeys.decided,
    queryFn: async () => {
      const lists = await Promise.all(DECIDED.map((status) => api.get<unknown>("/approvals", { status, limit: 200 })));
      return lists.flatMap(asList).sort((a, b) => Date.parse(b.decided_at ?? b.created_at) - Date.parse(a.decided_at ?? a.created_at));
    },
    retry: quietRetry,
    enabled,
  });
}

export function useApproval(id: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: approvalKeys.one(id ?? ""),
    queryFn: () => api.get<ApprovalRecord>(`/approvals/${encodeURIComponent(id ?? "")}`),
    enabled: Boolean(id),
    retry: quietRetry,
    // Open instantly from a list card, then refresh.
    initialData: () => findCached(qc, id),
    initialDataUpdatedAt: 0,
  });
}

/** The title of the task an approval belongs to (the header shows it instead of the raw id). */
export function useTaskTitle(taskId: string | null | undefined) {
  return useQuery({
    queryKey: ["approvals", "task-title", taskId ?? ""] as const,
    queryFn: () => api.get<{ task: { title: string } }>(`/engine/tasks/${encodeURIComponent(taskId ?? "")}`),
    select: (d) => d.task.title,
    enabled: Boolean(taskId),
    retry: quietRetry,
    staleTime: 5 * 60_000,
  });
}

function findCached(qc: QueryClient, id: string | undefined): ApprovalRecord | undefined {
  if (!id) return undefined;
  return (
    qc.getQueryData<ApprovalRecord[]>(approvalKeys.pending)?.find((a) => a.id === id) ??
    qc.getQueryData<ApprovalRecord[]>(approvalKeys.decided)?.find((a) => a.id === id)
  );
}

export interface DecideVars {
  approval: ApprovalRecord;
  approve: boolean;
  note?: string | null;
  payload?: Record<string, unknown> | null;
}

/** Apply a decided approval to every cache (pending → decided, detail updated). */
export function applyDecided(qc: QueryClient, decided: ApprovalRecord) {
  qc.setQueryData<ApprovalRecord[]>(approvalKeys.pending, (old) => old?.filter((a) => a.id !== decided.id));
  qc.setQueryData<ApprovalRecord[]>(approvalKeys.decided, (old) => (old ? [decided, ...old.filter((a) => a.id !== decided.id)] : old));
  qc.setQueryData(approvalKeys.one(decided.id), decided);
}

export function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ approval, approve, note, payload }: DecideVars) =>
      api.post<ApprovalRecord>(`/approvals/${encodeURIComponent(approval.id)}/decision`, {
        approve,
        note: note?.trim() || null,
        channel: "app",
        decision_payload: payload ?? null,
      }),
    onMutate: async ({ approval, approve, note, payload }) => {
      await qc.cancelQueries({ queryKey: approvalKeys.pending });
      const previous = qc.getQueryData<ApprovalRecord[]>(approvalKeys.pending);
      const previousOne = qc.getQueryData<ApprovalRecord>(approvalKeys.one(approval.id));
      applyDecided(qc, {
        ...approval,
        status: approve ? "approved" : "rejected",
        decided_by: "user",
        decision_note: note?.trim() || null,
        decision_payload: payload ?? null,
        channel: "app",
        decided_at: new Date().toISOString(),
      });
      return { previous, previousOne };
    },
    onError: (err, { approval }, ctx) => {
      // Someone else (another channel) decided first: keep it out of the pending list.
      if (err instanceof ApiError && err.status === 409) {
        void qc.invalidateQueries({ queryKey: approvalKeys.decided });
        void qc.invalidateQueries({ queryKey: approvalKeys.one(approval.id) });
        return;
      }
      if (ctx?.previous) qc.setQueryData(approvalKeys.pending, ctx.previous);
      if (ctx?.previousOne) qc.setQueryData(approvalKeys.one(approval.id), ctx.previousOne);
      void qc.invalidateQueries({ queryKey: approvalKeys.decided });
    },
    onSuccess: (decided) => {
      if (decided && typeof decided === "object" && "id" in decided) applyDecided(qc, decided);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: approvalKeys.pending }),
  });
}

/** Route approval events into the caches: new requests appear, decisions move across. */
export function applyApprovalEvents(qc: QueryClient, batch: StudioEvent[], fetchOne: (id: string) => Promise<ApprovalRecord>) {
  for (const ev of batch) {
    const id = typeof ev.payload.approval_id === "string" ? ev.payload.approval_id : null;
    if (!id) continue;
    if (ev.type === "approval.requested") {
      void fetchOne(id)
        .then((a) => {
          qc.setQueryData<ApprovalRecord[]>(approvalKeys.pending, (old) => (old && !old.some((x) => x.id === a.id) ? [a, ...old] : old));
          qc.setQueryData(approvalKeys.one(a.id), a);
        })
        .catch(() => void qc.invalidateQueries({ queryKey: approvalKeys.pending }));
    } else if (ev.type === "approval.decided") {
      const status = ev.payload.status as ApprovalStatus | undefined;
      const known = qc.getQueryData<ApprovalRecord[]>(approvalKeys.pending)?.find((a) => a.id === id) ?? qc.getQueryData<ApprovalRecord>(approvalKeys.one(id));
      if (known && status) {
        applyDecided(qc, {
          ...known,
          status,
          decided_by: typeof ev.payload.decided_by === "string" ? ev.payload.decided_by : known.decided_by,
          channel: typeof ev.payload.channel === "string" ? ev.payload.channel : known.channel,
          decision_note: typeof ev.payload.note === "string" ? ev.payload.note : known.decision_note,
          decided_at: known.decided_at ?? ev.ts,
        });
      } else {
        void qc.invalidateQueries({ queryKey: approvalKeys.pending });
        void qc.invalidateQueries({ queryKey: approvalKeys.one(id) });
      }
      void qc.invalidateQueries({ queryKey: approvalKeys.decided, refetchType: "none" });
    }
  }
}

/** Mount on approval pages: keeps lists and detail live without refetch storms. */
export function useApprovalsLive() {
  const qc = useQueryClient();
  const onBatch = useCallback(
    (batch: StudioEvent[]) => applyApprovalEvents(qc, batch, (id) => api.get<ApprovalRecord>(`/approvals/${encodeURIComponent(id)}`)),
    [qc],
  );
  useEventStream({ types: ["approval.*"], ephemeral: false }, onBatch);
}
