import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect } from "react";

import { api } from "@/lib/api";
import { isUnreachable, useConnection } from "@/lib/connection";
import { toast } from "@/ui";

import { shellStrings as s } from "./strings";

const ONLINE_INTERVAL = 15_000;
const OFFLINE_INTERVAL = 3_000;

let kick: (() => void) | null = null;

/**
 * Polls studiod (`GET /api/system`) — slowly while online, every few seconds while offline — and
 * refreshes all server state when it comes back. Returns a "retry now" function.
 */
export function useConnectionMonitor(): () => void {
  const qc = useQueryClient();
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      clearTimeout(timer);
      try {
        await api.get("/system");
        if (alive) useConnection.getState().setStatus("online");
      } catch (err) {
        if (alive) useConnection.getState().setStatus(isUnreachable(err) ? "offline" : "online");
      }
      if (!alive) return;
      timer = setTimeout(tick, useConnection.getState().status === "online" ? ONLINE_INTERVAL : OFFLINE_INTERVAL);
    };
    kick = () => void tick();
    void tick();
    const unsub = useConnection.subscribe((st, prev) => {
      if (prev.status === "offline" && st.status === "online") {
        void qc.invalidateQueries();
        toast.success(s.connection.reconnected, { id: "connection" });
      }
    });
    return () => {
      alive = false;
      kick = null;
      clearTimeout(timer);
      unsub();
    };
  }, [qc]);
  return useCallback(() => kick?.(), []);
}
