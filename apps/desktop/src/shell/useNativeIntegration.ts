import { useEffect } from "react";
import { useNavigate } from "react-router";

import { deepLinkRoute, listenNative, nativeBridge, type DeepLink, type ShellAction } from "@/lib/native";
import { useActiveSessions, useLimits, usePendingApprovals } from "@/lib/queries";
import { useShell } from "@/lib/shell";
import { isAgentBusy } from "@/ui/agentStatus";

/**
 * Wires the Tauri shell into the app (no-ops in the browser build):
 * - deep links (`aistudio://approval/<id>` …) and shell actions (tray / menu bar) navigate;
 * - the tray icon mirrors pending approvals, active agents and critical state.
 */
export function useNativeIntegration(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const offLink = listenNative<DeepLink>(nativeBridge.onDeepLink, (link) => {
      const route = deepLinkRoute(link);
      if (route) void navigate(route);
    });
    const offAction = listenNative<ShellAction>(nativeBridge.onShellAction, (a) => {
      if (a.action === "new-task") {
        void navigate("/");
        useShell.getState().requestComposerFocus();
      } else if (a.action === "navigate" && a.route) {
        void navigate(a.route.startsWith("/") ? a.route : `/${a.route}`);
      }
    });
    return () => {
      offLink();
      offAction();
    };
  }, [navigate]);

  const approvals = usePendingApprovals().data;
  const sessions = useActiveSessions().data;
  const limits = useLimits().data;
  const pendingApprovals = approvals?.length ?? 0;
  const activeAgents = sessions?.filter((s) => isAgentBusy(s.state)).length ?? 0;
  const critical =
    (approvals?.some((a) => a.production || a.severity === "critical") ?? false) ||
    (sessions?.some((s) => s.state === "error") ?? false) ||
    (limits?.some((w) => w.status === "exhausted") ?? false);

  useEffect(() => {
    if (!nativeBridge.setTrayState) return;
    try {
      const r = nativeBridge.setTrayState({ pendingApprovals, activeAgents, critical });
      if (r instanceof Promise) r.catch(() => undefined);
    } catch {
      // tray unavailable: nothing to mirror
    }
  }, [activeAgents, critical, pendingApprovals]);
}
