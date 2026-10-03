/**
 * Tasks feature routes. The list lives here (tasks-list workstream); detail pages live in
 * ./detail (tasks-detail workstream).
 */
import { Route, Routes, useParams } from "react-router";

import { RunPage } from "./detail/RunPage";
import { TaskDetailPage } from "./detail/TaskDetailPage";

function TaskDetailRoute() {
  const { taskId = "" } = useParams();
  return <TaskDetailPage taskId={taskId} />;
}

function RunRoute() {
  const { runId = "" } = useParams();
  return <RunPage runId={runId} />;
}

function TaskList() {
  return (
    <div className="p-8">
      <h1 className="text-xl">Görevler</h1>
    </div>
  );
}

export default function TasksPage() {
  return (
    <Routes>
      <Route index element={<TaskList />} />
      <Route path="runs/:runId" element={<RunRoute />} />
      <Route path=":taskId" element={<TaskDetailRoute />} />
    </Routes>
  );
}
