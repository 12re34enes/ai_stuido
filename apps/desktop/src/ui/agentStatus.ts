import type { AgentState } from "@/lib/types";

import type { DotStatus } from "./StatusDot";

/** Map a backend AgentState to the status dot vocabulary. */
export function agentDotStatus(state: AgentState): DotStatus {
  switch (state) {
    case "starting":
    case "thinking":
    case "responding":
    case "running_tool":
      return "running";
    case "waiting_permission":
    case "waiting_user":
      return "waiting";
    case "done":
      return "success";
    case "error":
      return "error";
    case "interrupted":
      return "offline";
    default:
      return "idle";
  }
}

/** Whether a session in this state counts as active work. */
export function isAgentBusy(state: AgentState): boolean {
  const s = agentDotStatus(state);
  return s === "running" || s === "waiting";
}
