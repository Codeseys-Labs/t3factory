import { createFileRoute } from "@tanstack/react-router";

import { TaskDetailPage } from "../components/tasks/detail/TaskDetailPage";
import { validateTaskDetailSearch } from "../components/tasks/taskRoutes";

export const Route = createFileRoute("/_chat/tasks/$environmentId/$displayId")({
  validateSearch: validateTaskDetailSearch,
  component: TaskDetailPage,
});
