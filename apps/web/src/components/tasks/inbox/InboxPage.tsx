import { PageHeader } from "../kit";
import { TaskPageFrame } from "../TaskPageFrame";

export function InboxPage() {
  return <TaskPageFrame header={<PageHeader title="Inbox" />} />;
}
