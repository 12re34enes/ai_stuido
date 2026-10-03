/** Open a session's live stream in the right drawer (spec §19 "Sağ çekmece: canlı çıktı"). */
import { openDrawer } from "@/lib/drawer";
import { ProviderMark, uiStrings } from "@/ui";

import type { SessionView } from "./api";
import { SessionStream } from "./SessionStream";
import { sessionTitle } from "./format";

export function openSessionDrawer(session: Pick<SessionView, "id" | "provider" | "label" | "title" | "role" | "model">, opts: { subagent?: string | null } = {}) {
  openDrawer({
    id: `session:${session.id}`,
    title: sessionTitle(session),
    subtitle: [session.model, uiStrings.agentRole[session.role]].filter(Boolean).join(" · "),
    icon: <ProviderMark provider={session.provider} size={16} label="" />,
    content: <SessionStream sessionId={session.id} compact focusSubagent={opts.subagent} />,
  });
}
