import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../components/tasks/inbox/InboxPage";
import { validateInboxSearch } from "../components/tasks/taskRoutes";

export const Route = createFileRoute("/_chat/inbox")({
  validateSearch: validateInboxSearch,
  component: InboxPage,
});
