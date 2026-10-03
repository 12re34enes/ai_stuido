/** Provider-styled agent cards of a node; clicking one opens its live session in the drawer. */
import { AnimatePresence, motion } from "motion/react";

import { variants } from "@/motion/tokens";
import { AgentCard } from "@/ui";

import type { SessionView } from "../types";
import { openSessionDrawer, sessionTitle } from "./sessionDrawer";

export function AgentCards({ sessions, lastLines }: { sessions: SessionView[]; lastLines: ReadonlyMap<string, string> }) {
  return (
    <motion.ul layout className="grid grid-cols-[repeat(auto-fill,minmax(272px,1fr))] gap-3">
      <AnimatePresence initial={false} mode="popLayout">
        {sessions.map((sv) => (
          <motion.li key={sv.id} layout {...variants.listItem}>
            <AgentCard
              provider={sv.provider}
              title={sessionTitle(sv)}
              model={sv.model}
              role={sv.role}
              state={sv.state}
              lastLine={lastLines.get(sv.id) ?? null}
              usage={sv.last_usage}
              onClick={() => openSessionDrawer(sv)}
            />
          </motion.li>
        ))}
      </AnimatePresence>
    </motion.ul>
  );
}
