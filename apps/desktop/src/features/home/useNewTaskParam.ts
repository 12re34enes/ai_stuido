import { useEffect } from "react";
import { useSearchParams } from "react-router";

import { useShell } from "@/lib/shell";

/**
 * `/?new=1` (sent by the menu bar and quick palette windows via showMainWindow) focuses the
 * task composer once, then drops the parameter so a refresh doesn't re-trigger it.
 */
export function useNewTaskParam(): void {
  const [params, setParams] = useSearchParams();
  const requested = params.get("new") === "1";
  useEffect(() => {
    if (!requested) return;
    useShell.getState().requestComposerFocus();
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("new");
        return next;
      },
      { replace: true },
    );
  }, [requested, setParams]);
}
