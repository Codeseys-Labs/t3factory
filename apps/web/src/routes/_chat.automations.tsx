import { createFileRoute } from "@tanstack/react-router";

import { AutomationsPage } from "../components/tasks/automations/AutomationsPage";
import { validateAutomationsSearch } from "../components/tasks/taskRoutes";

export const Route = createFileRoute("/_chat/automations")({
  validateSearch: validateAutomationsSearch,
  component: AutomationsPage,
});
