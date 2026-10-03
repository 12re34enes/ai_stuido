/**
 * Live team state for one run: the REST team view (+ the run's agent sessions) seeds the reducer,
 * then the run's event stream folds forward through model/wire → model/live. Pulses expire on a
 * timer; the view and sessions are refetched when the stream reveals something new (the team
 * started, an unknown session joined).
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { useEventStream, type StudioEvent } from "@/lib/events";

import { teamKeys, useRunSessions, useTeamRun } from "../api";
import { applySessions, initialLiveState, prunePulses, pulseTtl, reduceTeamEvent, seedFromView, type TeamLiveState } from "../model/live";
import { parseTeamEvent } from "../model/wire";
import type { RunSession, TeamRunView } from "../types";

export function useTeamLive(runId: string, nodeId: string | null) {
  const qc = useQueryClient();
  const view = useTeamRun(runId, nodeId);
  const sessions = useRunSessions(runId);
  const [state, setState] = useState<TeamLiveState>(() => initialLiveState(runId, nodeId));
  const known = useRef(new Set<string>());

  // Re-seed whenever the REST view or the session rows change (adjusting state while rendering,
  // so the first paint already has them).
  const [seededFrom, setSeededFrom] = useState<{ view: TeamRunView | undefined; sessions: RunSession[] | undefined }>({ view: undefined, sessions: undefined });
  if (view.data !== seededFrom.view || sessions.data !== seededFrom.sessions) {
    const fresh = view.data !== seededFrom.view ? view.data : undefined;
    setSeededFrom({ view: view.data, sessions: sessions.data });
    setState((s) => {
      let next = fresh ? seedFromView(s, fresh) : s;
      if (sessions.data) next = applySessions(next, sessions.data);
      return next;
    });
  }

  useEffect(() => {
    for (const sv of sessions.data ?? []) known.current.add(sv.id);
  }, [sessions.data]);

  const hasSpec = useRef(false);
  const lastViewRefetch = useRef(0);
  useEffect(() => {
    hasSpec.current = state.spec !== null;
  });

  const onBatch = useCallback(
    (batch: StudioEvent[]) => {
      const now = Date.now();
      const parsed = batch.map(parseTeamEvent).filter((e) => e !== null);
      if (!parsed.length) return;
      let refetchView = false;
      let refetchSessions = false;
      for (const e of parsed) {
        if ((e.type === "started" || e.type === "member" || e.type === "assignment") && !hasSpec.current) refetchView = true;
        if (e.type === "finished") refetchView = true;
        if ((e.type === "member" || e.type === "session") && e.sessionId && !known.current.has(e.sessionId)) {
          known.current.add(e.sessionId);
          refetchSessions = true;
        }
      }
      setState((s) => parsed.reduce((acc, e) => reduceTeamEvent(acc, e, now), s));
      if (refetchView && now - lastViewRefetch.current > 2000) {
        lastViewRefetch.current = now;
        void qc.invalidateQueries({ queryKey: teamKeys.run(runId, nodeId) });
      }
      if (refetchSessions) setTimeout(() => void qc.invalidateQueries({ queryKey: teamKeys.sessions(runId) }), 400);
    },
    [nodeId, qc, runId],
  );

  useEventStream(runId ? { run_id: runId, ephemeral: false } : null, onBatch);

  // Expire pulses (batons after one trip, speech bubbles a little later).
  const oldest = state.pulses.length ? Math.min(...state.pulses.map((p) => p.at + pulseTtl(p))) : null;
  useEffect(() => {
    if (oldest === null) return;
    const t = setTimeout(() => setState((s) => prunePulses(s)), Math.max(50, oldest - Date.now() + 20));
    return () => clearTimeout(t);
  }, [oldest]);

  return { state, view, sessions };
}
