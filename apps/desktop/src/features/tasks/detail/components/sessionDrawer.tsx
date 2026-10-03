/** Opens an agent session's live stream in the shell drawer (SessionStream, compact). */
import { SessionStream } from "@/features/sessions/SessionStream";
import { openDrawer } from "@/lib/drawer";
import { ProviderMark, uiStrings } from "@/ui";

import type { SessionView } from "../types";

export function sessionTitle(sv: SessionView): string {
  return sv.label || sv.title || uiStrings.agentRole[sv.role] || sv.id;
}

export function openSessionDrawer(sv: SessionView) {
  openDrawer({
    id: `session:${sv.id}`,
    title: sessionTitle(sv),
    subtitle: [uiStrings.providers[sv.provider], sv.model].filter(Boolean).join(" · "),
    icon: <ProviderMark provider={sv.provider} variant="tile" size={20} />,
    content: <SessionStream sessionId={sv.id} compact />,
  });
}
