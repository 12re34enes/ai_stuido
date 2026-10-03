/**
 * Flows feature (/flows/*): list, schedules and the full-page editor. In-feature navigation
 * animates like page transitions; the editor instance survives /flows/new → /flows/:id after the
 * first save so the canvas doesn't reload.
 */
import { AnimatePresence, motion } from "motion/react";
import { useLocation } from "react-router";

import { variants } from "@/motion/tokens";

import { FlowEditorPage } from "./editor/FlowEditorPage";
import { FlowsListPage } from "./list/FlowsListPage";
import { SchedulesPage } from "./schedules/SchedulesPage";
import { parseFlowsRoute } from "./route";

export default function FlowsFeature() {
  const location = useLocation();
  const route = parseFlowsRoute(location.pathname, location.search);
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div key={route.page} variants={variants.page} initial="initial" animate="animate" exit="exit" className={route.page === "editor" ? "h-full" : "min-h-full"}>
        {route.page === "list" && <FlowsListPage />}
        {route.page === "schedules" && <SchedulesPage />}
        {route.page === "editor" && <FlowEditorPage flowId={route.flowId} mode={route.mode} studio={route.studio} blank={route.blank} />}
      </motion.div>
    </AnimatePresence>
  );
}
