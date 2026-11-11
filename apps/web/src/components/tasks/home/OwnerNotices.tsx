import type { FactoryTaskOwnerStatus } from "@t3tools/client-runtime/state/factory-task-list";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironmentPresentation } from "../../../state/presentation";
import { Button } from "../../ui/button";

interface OwnerState {
  readonly environmentId: EnvironmentId;
  readonly status: FactoryTaskOwnerStatus;
  readonly hasTasks: boolean;
}
interface MoreState {
  readonly environmentId: EnvironmentId;
  readonly capped: boolean;
  readonly available: boolean;
}

/**
 * What each machine's list is doing, beside the tasks that did load: loading, offline, no access,
 * an older server or a failed read, and a quiet Load more where a machine has more pages.
 */
export function OwnerNotices({
  owners,
  more,
  onRetry,
  onLoadMore,
}: {
  owners: readonly OwnerState[];
  more: readonly MoreState[];
  onRetry: () => void;
  onLoadMore: (environmentId: EnvironmentId) => void;
}) {
  const notices = owners.filter((owner) => owner.status !== "current");
  if (notices.length === 0 && more.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col gap-1 px-6 pb-3">
      {notices.map((owner) => (
        <OwnerNotice key={owner.environmentId} owner={owner} onRetry={onRetry} />
      ))}
      {more.map((entry) => (
        <MoreNotice
          key={entry.environmentId}
          entry={entry}
          several={owners.length > 1}
          onLoadMore={onLoadMore}
        />
      ))}
    </div>
  );
}

function useMachineLabel(environmentId: EnvironmentId) {
  return (
    useEnvironmentPresentation(environmentId).presentation?.entry.target.label ?? "This machine"
  );
}

function ownerSentence(status: FactoryTaskOwnerStatus, machine: string, hasTasks: boolean) {
  switch (status) {
    case "loading":
      return `Loading tasks from ${machine}…`;
    case "offline":
      return hasTasks
        ? `${machine} is offline. Its tasks are shown as they were last seen.`
        : `${machine} is offline.`;
    case "forbidden":
      return `Ask the owner of ${machine} for access to its tasks.`;
    case "unsupported":
      return `Update the server on ${machine} to use tasks.`;
    case "failed":
      return `Tasks from ${machine} failed to load.`;
    case "current":
      return "";
  }
}

function OwnerNotice({ owner, onRetry }: { owner: OwnerState; onRetry: () => void }) {
  const machine = useMachineLabel(owner.environmentId);
  return (
    <p
      role={owner.status === "failed" ? "alert" : "status"}
      className="flex min-h-7 items-center gap-2 text-muted-foreground text-xs"
    >
      <span>{ownerSentence(owner.status, machine, owner.hasTasks)}</span>
      {owner.status === "failed" ? (
        <Button variant="ghost" size="xs" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </p>
  );
}

function MoreNotice({
  entry,
  several,
  onLoadMore,
}: {
  entry: MoreState;
  several: boolean;
  onLoadMore: (environmentId: EnvironmentId) => void;
}) {
  const machine = useMachineLabel(entry.environmentId);
  if (entry.capped)
    return (
      <p className="min-h-7 text-muted-foreground text-xs">
        {`Showing the newest tasks${several ? ` from ${machine}` : ""}. Filter to find older ones.`}
      </p>
    );
  return (
    <div className="flex min-h-7 items-center">
      <Button
        variant="ghost-muted"
        size="xs"
        disabled={!entry.available}
        onClick={() => onLoadMore(entry.environmentId)}
      >
        {several ? `Load more from ${machine}` : "Load more"}
      </Button>
    </div>
  );
}
