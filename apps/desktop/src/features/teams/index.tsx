/**
 * Teams feature (/teams/*, spec §25): the teams list, the org-chart builder (/teams/new,
 * /teams/:id/edit) and the full-page live team view (/teams/live/:runId). In-feature navigation
 * animates like page transitions; the builder survives /teams/new → /teams/:id/edit after the
 * first save so the canvas doesn't reload.
 */
import { AnimatePresence, motion } from "motion/react";
import { useLocation } from "react-router";

import { variants } from "@/motion/tokens";

import { TeamBuilderPage } from "./builder/TeamBuilderPage";
import { installTeamCommands } from "./commands";
import { TeamsListPage } from "./list/TeamsListPage";
import { TeamLivePage } from "./live/TeamLivePage";
import { parseTeamsRoute } from "./route";

installTeamCommands();

export default function TeamsFeature() {
  const location = useLocation();
  const route = parseTeamsRoute(location.pathname, location.search);
  const key = route.page === "live" ? `live:${route.runId}` : route.page;
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div key={key} variants={variants.page} initial="initial" animate="animate" exit="exit" className={route.page === "list" ? "min-h-full" : "h-full"}>
        {route.page === "list" && <TeamsListPage />}
        {route.page === "builder" && <TeamBuilderPage teamId={route.teamId} version={route.version} fromTeamId={route.fromTeamId} />}
        {route.page === "live" && <TeamLivePage runId={route.runId} nodeId={route.nodeId} />}
      </motion.div>
    </AnimatePresence>
  );
}
