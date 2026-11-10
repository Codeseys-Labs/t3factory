import { Link, useParams } from "@tanstack/react-router";

import { PageHeader } from "../kit";
import { TaskPageFrame } from "../TaskPageFrame";

export function TaskDetailPage() {
  const { displayId } = useParams({ from: "/_chat/tasks/$environmentId/$displayId" });
  return (
    <TaskPageFrame
      header={
        <PageHeader
          breadcrumb={[{ label: "Tasks", render: <Link to="/tasks" /> }, { label: displayId }]}
        />
      }
    />
  );
}
