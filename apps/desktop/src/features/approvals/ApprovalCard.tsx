/**
 * One approval with kind-specific detail and actions (plan editing, memory diff editing, remote
 * command classification, production emphasis, question answer, budget...). Shared: tasks,
 * menubar and the approvals page embed it.
 * STUB — implemented by the approvals workstream. Keep the props contract stable.
 */
import type { Approval } from "@/lib/types";

export interface ApprovalCardProps {
  approval: Approval;
  /** Compact = list/inline variant; full = detail page. */
  variant?: "compact" | "full";
  onDecided?: (approval: Approval) => void;
}

export function ApprovalCard({ approval }: ApprovalCardProps) {
  return <div className="rounded-md border border-line p-3">{approval.title}</div>;
}
