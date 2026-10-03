/**
 * Tasks feature routes. The list lives in ./list (tasks-list workstream); detail pages live in
 * ./detail (tasks-detail workstream).
 *
 * Shared-element transition: rows, home cards and the composer give their surface
 * `layoutId={taskLayoutId(id)}` and navigate with `state.morph`; the detail route renders a surface
 * with the same layoutId, so the card expands into the page, then the page content fades in.
 */
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { Route, Routes, useLocation, useParams } from "react-router";

import { duration, ease, spring, variants } from "@/motion/tokens";

import { installTaskCommands } from "./create/commands";
import { RunPage } from "./detail/RunPage";
import { TaskDetailPage } from "./detail/TaskDetailPage";
import { taskLayoutId } from "./list/status";
import { TaskListPage } from "./list/TaskListPage";

installTaskCommands();

function TaskDetailRoute() {
  const { taskId = "" } = useParams();
  const location = useLocation();
  const morph = !!(location.state as { morph?: boolean } | null)?.morph;
  return (
    <div className="relative min-h-full">
      {morph && (
        <>
          {/* Expanding card (shared with the clicked row / composer), then the canvas settles over it. */}
          <motion.div
            layoutId={taskLayoutId(taskId)}
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-surface"
            style={{ borderRadius: 0 }}
            transition={spring.gentle}
          />
          <motion.div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-canvas"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: duration.page * 0.7, duration: duration.standard, ease: ease.out } }}
          />
        </>
      )}
      <motion.div
        className="relative"
        initial={morph ? { opacity: 0, y: 8 } : false}
        animate={{ opacity: 1, y: 0, transition: { ...spring.gentle, delay: morph ? duration.page * 0.45 : 0 } }}
      >
        <TaskDetailPage taskId={taskId} />
      </motion.div>
    </div>
  );
}

function RunRoute() {
  const { runId = "" } = useParams();
  return <RunPage runId={runId} />;
}

function isTasksPath(pathname: string): boolean {
  return pathname === "/tasks" || pathname.startsWith("/tasks/");
}

/** In-feature transitions (list ↔ detail ↔ run) keyed by the route, not by search params. */
function routeKey(pathname: string): string {
  const rest = pathname.replace(/^\/tasks\/?/, "");
  if (!rest) return "list";
  if (rest.startsWith("runs/")) return `run:${rest.slice(5)}`;
  return `task:${rest}`;
}

export default function TasksPage() {
  const live = useLocation();
  // While the shell animates this page out, the URL already points elsewhere: keep the last
  // /tasks location so the leaving page stays as it was (and nested <Routes> still match).
  const [frozen, setFrozen] = useState(live);
  const inside = isTasksPath(live.pathname);
  if (inside && live !== frozen) setFrozen(live);
  const location = inside ? live : frozen;
  // First mounted after the URL already left /tasks (lazy chunk resolved late): nothing to show.
  if (!isTasksPath(location.pathname)) return null;
  const key = routeKey(location.pathname);
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div key={key} className="absolute inset-0 overflow-y-auto overscroll-contain" {...variants.fade}>
        <Routes location={location}>
          <Route index element={<TaskListPage />} />
          <Route path="runs/:runId" element={<RunRoute />} />
          <Route path=":taskId" element={<TaskDetailRoute />} />
        </Routes>
      </motion.div>
    </AnimatePresence>
  );
}
