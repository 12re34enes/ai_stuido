/** Debounced builder validation: local rules right away when the server can't, else the server's report. */
import { useCallback, useEffect, useRef } from "react";

import { validateTeam } from "../api";
import { validateTeamLocal } from "../model/validate";
import { useBuilder, useBuilderStore } from "./store";

export function useAutoValidate(enabled = true) {
  const store = useBuilderStore();
  const revision = useBuilder((st) => st.revision);
  const serverOk = useRef<boolean | null>(null);
  const run = useCallback(
    async (explicit = false) => {
      const st = store.getState();
      const rev = st.revision;
      const local = validateTeamLocal(st.spec);
      if (serverOk.current === false) {
        st.setReport(local, { explicit, revision: rev });
        return local;
      }
      try {
        const server = await validateTeam(st.spec);
        serverOk.current = server !== null;
        const report = server ?? local;
        if (store.getState().revision === rev) store.getState().setReport(report, { explicit, revision: rev });
        return report;
      } catch {
        if (store.getState().revision === rev) store.getState().setReport(local, { explicit, revision: rev });
        return local;
      }
    },
    [store],
  );
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => void run(), serverOk.current === false ? 0 : 650);
    return () => clearTimeout(t);
  }, [enabled, revision, run]);
  return run;
}
