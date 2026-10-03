/** Pending approvals of the current workspace, most urgent first. */
import { usePendingApprovals } from "@/lib/queries";
import type { Approval } from "@/lib/types";

const rank = (a: Approval) => (a.production ? 0 : a.severity === "critical" ? 1 : a.severity === "high" ? 2 : 3);

export function pendingForWorkspace(list: Approval[], workspaceId: string): Approval[] {
  return list
    .filter((a) => a.status === "pending" && a.workspace_id === workspaceId)
    .sort((a, b) => rank(a) - rank(b) || b.created_at.localeCompare(a.created_at));
}

export function useWorkspaceApprovals(workspaceId: string | null | undefined): Approval[] {
  const { data = [] } = usePendingApprovals();
  return workspaceId ? pendingForWorkspace(data, workspaceId) : [];
}
