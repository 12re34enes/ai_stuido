/** A session's provider from whatever session record is already cached (never fetches). */
import { useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/queries";
import type { Provider, SessionRecord } from "@/lib/types";

import { sessionKeys } from "../api";

export function useSessionProvider(sessionId: string | null | undefined): Provider | undefined {
  const qc = useQueryClient();
  if (!sessionId) return undefined;
  const one = qc.getQueryData<SessionRecord>(sessionKeys.one(sessionId));
  if (one?.provider) return one.provider;
  for (const key of [sessionKeys.all, queryKeys.activeSessions]) {
    const hit = qc.getQueryData<SessionRecord[]>(key)?.find((s) => s.id === sessionId);
    if (hit?.provider) return hit.provider;
  }
  return undefined;
}
