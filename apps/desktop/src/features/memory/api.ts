/**
 * Server state of the memory feature (`/api/memory/{workspace_id}/…`) and proposal decisions via
 * `/api/approvals/{id}/decision`. Live events (`memory.*`, `approval.*`) keep every view fresh.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { isMissingEndpoint, isUnreachable } from "@/lib/connection";
import { useEventStream, type StudioEvent } from "@/lib/events";

import type { AgentRole, Boundaries, ContextResult, MemoryCommit, MemoryDiff, MemoryDoc, MemoryProposal, WriteResult } from "./types";

const enc = encodeURIComponent;
/** Doc paths keep their slashes in the URL (`/docs/decisions/x.md`). */
const encPath = (path: string) => path.split("/").map(enc).join("/");

export const memoryKeys = {
  all: (ws: string) => ["memory", ws] as const,
  docs: (ws: string) => ["memory", ws, "docs"] as const,
  doc: (ws: string, path: string, commit?: string) => ["memory", ws, "doc", path, commit ?? "head"] as const,
  history: (ws: string, path?: string) => ["memory", ws, "history", path ?? "*"] as const,
  diff: (ws: string, base: string, head: string, path?: string) => ["memory", ws, "diff", base, head, path ?? "*"] as const,
  proposals: (ws: string) => ["memory", ws, "proposals"] as const,
  boundaries: (ws: string) => ["memory", ws, "boundaries"] as const,
  boundaryWarnings: (ws: string) => ["memory", ws, "boundary-warnings"] as const,
  context: (ws: string, role: AgentRole) => ["memory", ws, "context", role] as const,
};

function retry(count: number, err: unknown): boolean {
  return !isMissingEndpoint(err) && !isUnreachable(err) && count < 2;
}

const base = (ws: string) => `/memory/${enc(ws)}`;

export function useMemoryDocs(ws: string | undefined) {
  return useQuery({
    queryKey: memoryKeys.docs(ws ?? ""),
    queryFn: () => api.get<MemoryDoc[]>(`${base(ws!)}/docs`, { content: false }),
    enabled: !!ws,
    retry,
  });
}

export function useMemoryDoc(ws: string | undefined, path: string | undefined, commit?: string) {
  return useQuery({
    queryKey: memoryKeys.doc(ws ?? "", path ?? "", commit),
    queryFn: () => api.get<MemoryDoc>(`${base(ws!)}/docs/${encPath(path!)}`, { commit }),
    enabled: !!ws && !!path,
    retry,
    staleTime: commit ? Infinity : 5_000,
  });
}

export function fetchDocAt(ws: string, path: string, commit: string) {
  return api.get<MemoryDoc>(`${base(ws)}/docs/${encPath(path)}`, { commit });
}

export function useWriteDoc(ws: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, content, message }: { path: string; content: string; message?: string }) =>
      api.put<WriteResult>(`${base(ws!)}/docs/${encPath(path)}`, { content, message: message || null }),
    onSuccess: (res) => {
      if (!ws) return;
      qc.setQueryData(memoryKeys.doc(ws, res.doc.path), res.doc);
      void qc.invalidateQueries({ queryKey: memoryKeys.docs(ws) });
      void qc.invalidateQueries({ queryKey: ["memory", ws, "history"] });
      if (res.doc.layer === "boundaries") void qc.invalidateQueries({ queryKey: memoryKeys.boundaries(ws) });
      void qc.invalidateQueries({ queryKey: ["memory", ws, "context"] });
    },
  });
}

export function useHistory(ws: string | undefined, path?: string) {
  return useQuery({
    queryKey: memoryKeys.history(ws ?? "", path),
    queryFn: () => api.get<MemoryCommit[]>(`${base(ws!)}/history`, { path, limit: 200 }),
    enabled: !!ws,
    retry,
  });
}

export function useDiff(ws: string | undefined, baseSha: string | undefined, head: string | undefined, path?: string) {
  return useQuery({
    queryKey: memoryKeys.diff(ws ?? "", baseSha ?? "", head ?? "", path),
    queryFn: () => api.get<MemoryDiff>(`${base(ws!)}/diff`, { base: baseSha, head, path }),
    enabled: !!ws && !!baseSha && !!head,
    retry,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
}

export function useRestore(ws: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commit: string) => api.post<{ head: string | null }>(`${base(ws!)}/restore`, { commit }),
    onSuccess: () => ws && void qc.invalidateQueries({ queryKey: memoryKeys.all(ws) }),
  });
}

export function useProposals(ws: string | undefined) {
  return useQuery({
    queryKey: memoryKeys.proposals(ws ?? ""),
    queryFn: () => api.get<MemoryProposal[]>(`${base(ws!)}/proposals`, { limit: 200 }),
    enabled: !!ws,
    retry,
  });
}

export interface ProposalDecision {
  proposal: MemoryProposal;
  approve: boolean;
  note?: string;
  /** The user's edited text (sent as decision_payload.content). */
  content?: string;
}

export function useDecideProposal(ws: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ proposal, approve, note, content }: ProposalDecision) =>
      api.post(`/approvals/${enc(proposal.approval_id!)}/decision`, {
        approve,
        note: note?.trim() || null,
        decision_payload: content !== undefined ? { content } : null,
      }),
    onMutate: async ({ proposal, approve, note, content }) => {
      if (!ws) return;
      const key = memoryKeys.proposals(ws);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<MemoryProposal[]>(key);
      // Optimistic: the card leaves the inbox at once; the server settles it moments later.
      qc.setQueryData<MemoryProposal[]>(key, (old) =>
        (old ?? []).map((p) =>
          p.id === proposal.id
            ? {
                ...p,
                status: approve ? "applied" : "rejected",
                edited: content !== undefined && content !== p.new_content,
                new_content: content ?? p.new_content,
                note: note?.trim() || p.note,
                decided_at: new Date().toISOString(),
              }
            : p,
        ),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ws && ctx?.previous) qc.setQueryData(memoryKeys.proposals(ws), ctx.previous);
    },
    onSettled: () => {
      if (!ws) return;
      void qc.invalidateQueries({ queryKey: memoryKeys.proposals(ws) });
      void qc.invalidateQueries({ queryKey: ["approvals", "pending"] });
    },
  });
}

export function useBoundaries(ws: string | undefined) {
  return useQuery({
    queryKey: memoryKeys.boundaries(ws ?? ""),
    queryFn: () => api.get<Boundaries>(`${base(ws!)}/boundaries`),
    enabled: !!ws,
    retry,
  });
}

/** Warnings from the latest `memory.boundaries_invalid` event (kept in the query cache). */
export function useBoundaryWarnings(ws: string | undefined) {
  return useQuery<string[]>({
    queryKey: memoryKeys.boundaryWarnings(ws ?? ""),
    queryFn: () => [],
    enabled: false,
    initialData: [],
  });
}

export function useAgentContext(ws: string | undefined, role: AgentRole) {
  return useQuery({
    queryKey: memoryKeys.context(ws ?? "", role),
    queryFn: () => api.get<ContextResult>(`${base(ws!)}/context`, { role }),
    enabled: !!ws,
    retry,
    placeholderData: keepPreviousData,
  });
}

// ----------------------------------------------------------------------------- live

export const MEMORY_EVENT_TYPES = ["memory.*", "approval.*"];

/** Route memory/approval events into cache invalidations. Exported for tests. */
export function applyMemoryEvents(qc: QueryClient, ws: string, batch: StudioEvent[]): void {
  const keys = new Set<string>();
  for (const ev of batch) {
    if (ev.workspace_id && ev.workspace_id !== ws) continue;
    const p = ev.payload as Record<string, unknown>;
    switch (ev.type) {
      case "memory.updated":
      case "memory.initialized":
        keys.add("docs").add("history").add("context");
        if (typeof p.path === "string") void qc.invalidateQueries({ queryKey: memoryKeys.doc(ws, p.path) });
        if (p.layer === "boundaries") keys.add("boundaries");
        break;
      case "memory.proposed":
        keys.add("proposals");
        break;
      case "memory.applied":
        keys.add("proposals").add("docs").add("history").add("context");
        if (typeof p.path === "string") void qc.invalidateQueries({ queryKey: memoryKeys.doc(ws, p.path) });
        if (p.layer === "boundaries") keys.add("boundaries");
        break;
      case "memory.rejected":
      case "memory.conflict":
        keys.add("proposals");
        break;
      case "memory.restored":
        void qc.invalidateQueries({ queryKey: memoryKeys.all(ws) });
        break;
      case "memory.boundaries_invalid":
        qc.setQueryData(memoryKeys.boundaryWarnings(ws), Array.isArray(p.warnings) ? p.warnings.map(String) : []);
        break;
      default:
        if (ev.type.startsWith("approval.") && (p.kind === "memory" || p.kind === undefined)) keys.add("proposals");
    }
  }
  for (const k of keys) {
    if (k === "history") void qc.invalidateQueries({ queryKey: ["memory", ws, "history"] });
    else if (k === "context") void qc.invalidateQueries({ queryKey: ["memory", ws, "context"] });
    else void qc.invalidateQueries({ queryKey: ["memory", ws, k] });
  }
}

export function useMemoryLive(ws: string | undefined): void {
  const qc = useQueryClient();
  useEventStream(ws ? { types: MEMORY_EVENT_TYPES, workspace_id: ws, ephemeral: false } : null, (batch) => {
    if (ws) applyMemoryEvents(qc, ws, batch);
  });
}
