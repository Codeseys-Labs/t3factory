import type { FactoryTaskOwnerStatus } from "@t3tools/client-runtime/state/factory-task-list";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";

import { useEnvironmentPresentation } from "../../../state/presentation";
import { m, type MessageResolver } from "../../../i18n/messages";
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
  const gt = useGT();
  return (
    useEnvironmentPresentation(environmentId).presentation?.entry.target.label ?? gt("This machine")
  );
}

function ownerSentence(
  status: FactoryTaskOwnerStatus,
  machine: string,
  hasTasks: boolean,
  resolve: MessageResolver = m,
) {
  switch (status) {
    case "loading":
      return resolve(msg("Loading tasks from {machine}…", { machine }));
    case "offline":
      return hasTasks
        ? resolve(
            msg("{machine} is offline. Its tasks are shown as they were last seen.", {
              machine,
            }),
          )
        : resolve(msg("{machine} is offline.", { machine }));
    case "forbidden":
      return resolve(msg("Ask the owner of {machine} for access to its tasks.", { machine }));
    case "unsupported":
      return resolve(msg("Update the server on {machine} to use tasks.", { machine }));
    case "failed":
      return resolve(msg("Tasks from {machine} failed to load.", { machine }));
    case "current":
      return "";
  }
}

function OwnerNotice({ owner, onRetry }: { owner: OwnerState; onRetry: () => void }) {
  const machine = useMachineLabel(owner.environmentId);
  const messages = useMessages();
  return (
    <p
      role={owner.status === "failed" ? "alert" : "status"}
      className="flex min-h-7 items-center gap-2 text-muted-foreground text-xs"
    >
      <span>{ownerSentence(owner.status, machine, owner.hasTasks, messages)}</span>
      {owner.status === "failed" ? (
        <Button variant="ghost" size="xs" onClick={onRetry}>
          <T>Try again</T>
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
  const gt = useGT();
  if (entry.capped)
    return (
      <p className="min-h-7 text-muted-foreground text-xs">
        {several
          ? gt("Showing the newest tasks from {machine}. Filter to find older ones.", {
              machine,
            })
          : gt("Showing the newest tasks. Filter to find older ones.")}
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
        {several ? gt("Load more from {machine}", { machine }) : gt("Load more")}
      </Button>
    </div>
  );
}
