import { createFileRoute } from "@tanstack/react-router";

import { TasksPage } from "../components/tasks/home/TasksPage";
import { validateTasksSearch } from "../components/tasks/taskRoutes";

export const Route = createFileRoute("/_chat/tasks/")({
  validateSearch: validateTasksSearch,
  component: TasksPage,
});
