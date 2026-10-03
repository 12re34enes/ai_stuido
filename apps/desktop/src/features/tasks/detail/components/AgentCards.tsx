/**
 * Provider-styled agent cards of a node: context ring, tokens, model / effort chips and the
 * session's own subagents (badge + tree on hover). Clicking a card opens its live session in the
 * drawer; picking a subagent opens the drawer scrolled to that subagent's block.
 */
import { AnimatePresence, motion } from "motion/react";

import { SessionCard } from "@/features/sessions/SessionCard";
import { variants } from "@/motion/tokens";

import type { SessionView } from "../types";
import { openSessionDrawer, sessionTitle } from "./sessionDrawer";

export function AgentCards({
  sessions,
  lastLines,
  effort,
}: {
  sessions: SessionView[];
  lastLines: ReadonlyMap<string, string>;
  /** The node's configured effort (cards fall back to it when the session does not say). */
  effort?: string | null;
}) {
  return (
    <motion.ul layout className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-3">
      <AnimatePresence initial={false} mode="popLayout">
        {sessions.map((sv) => (
          <motion.li key={sv.id} layout {...variants.listItem} className="flex">
            <SessionCard
              session={sv}
              title={sessionTitle(sv)}
              effort={effort}
              lastLine={lastLines.get(sv.id) ?? null}
              onClick={() => openSessionDrawer(sv)}
              onSelectSubagent={(sub) => openSessionDrawer(sv, { subagent: sub })}
              className="w-full"
            />
          </motion.li>
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}
