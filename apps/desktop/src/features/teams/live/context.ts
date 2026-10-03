/** Shared live-view context: state, selection and the session rows, for nodes and hover cards. */
import { createContext, useContext } from "react";

import type { TeamLiveState } from "../model/live";
import type { RunSession } from "../types";

export interface LiveContextValue {
  runId: string;
  state: TeamLiveState;
  sessions: Map<string, RunSession>;
  selected: string | null;
  select: (memberId: string | null) => void;
  openStream: (memberId: string) => void;
}

export const LiveContext = createContext<LiveContextValue | null>(null);

export function useLive(): LiveContextValue {
  const v = useContext(LiveContext);
  if (!v) throw new Error("useLive outside LiveContext");
  return v;
}
