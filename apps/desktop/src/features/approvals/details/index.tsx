/** Kind → detail renderer. */
import { FinalDetail, MemoryDetail, MergeDetail, PlanDetail } from "./code";
import type { DetailProps } from "./common";
import { BudgetDetail, CustomDetail, QuestionDetail } from "./input";
import { DeployDetail, RemoteDetail, ToolPermissionDetail } from "./ops";

export function KindDetail(props: DetailProps) {
  switch (props.approval.kind) {
    case "plan":
      return props.variant === "full" ? <PlanDetail {...props} /> : null;
    case "memory":
      return <MemoryDetail {...props} />;
    case "remote_command":
    case "db_write":
      return <RemoteDetail {...props} />;
    case "deploy":
      return <DeployDetail {...props} />;
    case "merge":
      return <MergeDetail {...props} />;
    case "final":
      return <FinalDetail {...props} />;
    case "tool_permission":
      return <ToolPermissionDetail {...props} />;
    case "question":
      return <QuestionDetail {...props} />;
    case "budget":
      return <BudgetDetail {...props} />;
    case "custom":
      return <CustomDetail {...props} />;
    default:
      return null;
  }
}
