/** Reachability of studiod, fed by the shell's health poller and the live event stream. */
import { create } from "zustand";

import { ApiError } from "./api";

export type ConnectionStatus = "connecting" | "online" | "offline";

interface ConnectionState {
  status: ConnectionStatus;
  /** Epoch ms of the last status change. */
  since: number;
  /** True once studiod answered at least once in this app session. */
  everOnline: boolean;
  setStatus: (status: ConnectionStatus) => void;
}

export const useConnection = create<ConnectionState>()((set, get) => ({
  status: "connecting",
  since: Date.now(),
  everOnline: false,
  setStatus: (status) => {
    if (get().status === status) return;
    set({ status, since: Date.now(), everOnline: get().everOnline || status === "online" });
  },
}));

/** Whether an error from `api` means "studiod is not reachable" (vs. a normal API error). */
export function isUnreachable(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504) return true;
    // The Vite dev proxy answers a bare 500 (no studiod error body) when studiod is down.
    return err.status === 500 && err.code === "http_error";
  }
  // Non-JSON bodies (e.g. the dev proxy's error page) fail to parse: treat as unreachable.
  return err instanceof SyntaxError || err instanceof TypeError;
}

/** Whether an endpoint simply does not exist (yet): widgets hide instead of erroring. */
export function isMissingEndpoint(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 405 || err.status === 501);
}
