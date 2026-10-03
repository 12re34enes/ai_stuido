/** Static option lists for inspector pickers. */
import type { SelectOption } from "@/ui";
import { uiStrings } from "@/ui/strings";

import type { AgentRole } from "../../types";

export const ROLE_OPTIONS: SelectOption<AgentRole>[] = (Object.keys(uiStrings.agentRole) as AgentRole[]).map((r) => ({ value: r, label: uiStrings.agentRole[r] }));

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
