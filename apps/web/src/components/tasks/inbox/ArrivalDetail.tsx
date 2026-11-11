import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type FactoryIntakeArrivalAction,
  type FactoryTaskAssignment,
  type FactoryTaskSummary,
  type FactoryTaskType,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { factoryIntake, useFactoryTaskCommand } from "../../../state/factoryTasks";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { AssigneeChip, assigneeText, ProjectChip, SourceChip } from "../kit";
import { TaskAssigneePicker, taskErrorMessage, useTaskAssigneeChip, useTaskSetup } from "../shared";
import type { ArrivalEntry } from "./inboxData";

const TYPES: Record<FactoryTaskType, string> = {
  task: "Task",
  bug: "Bug",
  feature: "Feature",
  docs: "Docs",
  research: "Research",
};

export function ArrivalDetail({
  entry,
  project,
  onAccepted,
}: {
  entry: ArrivalEntry;
  project: string;
  onAccepted: (task: FactoryTaskSummary) => void;
}) {
  const { arrival, environmentId } = entry;
  const [type, setType] = useState<FactoryTaskType>(arrival.suggestion?.type ?? "task");
  const [assignment, setAssignment] = useState<FactoryTaskAssignment>(
    arrival.suggestion?.assignee.assignment ?? { mode: "unassigned" },
  );
  const [commandId, setCommandId] = useState(() => CommandId.make(randomUUID()));
  const [busy, setBusy] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [editing, setEditing] = useState(arrival.suggestion === null);
  const [error, setError] = useState<string | null>(null);
  const setup = useTaskSetup({ environmentId, projectId: arrival.projectId, type, assignment });
  const suggested = useTaskAssigneeChip(
    arrival.suggestion?.assignee ?? {
      assignment: { mode: "unassigned" },
      key: "unassigned",
      resolved: null,
    },
    environmentId,
  );
  const target = { environmentId, commandId, id: arrival.id, version: arrival.version };
  const now = useNowMinute();
  const command = useArrivalCommand(target, { type: "accept", taskType: type, assignment });
  const decline = useArrivalCommand(target, { type: "decline" });
  const duplicate = useArrivalCommand(target, { type: "duplicate", of: null });
  const tomorrow = useArrivalCommand(target, { type: "snooze", until: snoozeUntil(now, 1) });
  const nextWeek = useArrivalCommand(target, { type: "snooze", until: snoozeUntil(now, 7) });
  const unsnooze = useArrivalCommand(target, { type: "unsnooze" });
  const send = async (selected: typeof command) => {
    if (busy || !selected.permission) return;
    setError(null);
    setBusy(true);
    const result = await selected.run();
    setBusy(false);
    setCommandId(CommandId.make(randomUUID()));
    if (result._tag === "Failure") setError(taskErrorMessage(squashAtomCommandFailure(result)));
    else if (result.value.task) onAccepted(result.value.task);
  };
  const sourceUrl = arrival.url && /^https?:\/\//iu.test(arrival.url) ? arrival.url : null;
  return (
    <>
      {sourceUrl ? (
        <a href={sourceUrl} target="_blank" rel="noreferrer">
          <SourceChip
            kind={arrival.sourceKind === "issues" ? "issue" : "feed"}
            label={arrival.label}
          />
        </a>
      ) : (
        <SourceChip
          kind={arrival.sourceKind === "issues" ? "issue" : "feed"}
          label={arrival.label}
        />
      )}
      <h2 className="mt-3 font-semibold text-xl">{arrival.title}</h2>
      {arrival.snoozedUntil ? (
        <p className="mt-2 text-muted-foreground text-sm">
          Snoozed until {new Date(arrival.snoozedUntil).toLocaleString()}
        </p>
      ) : null}
      <div className="mt-3">
        <ProjectChip name={project} />
      </div>
      <p className="mt-6 whitespace-pre-wrap break-words text-muted-foreground text-sm">
        {arrival.body}
      </p>
      {arrival.bodyTruncated ? (
        <p className="mt-2 text-muted-foreground text-xs">Read the full item at its source.</p>
      ) : null}
      {arrival.suggestion ? (
        <section aria-label="Suggestion" className="mt-6 space-y-2 rounded-lg border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm">
              Suggested: {TYPES[arrival.suggestion.type]} → {assigneeText(suggested)}
            </p>
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label="Change type or assignee"
              disabled={busy || !command.permission}
              onClick={() => setEditing(!editing)}
            >
              {editing ? "Hide changes" : "Change"}
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            From the rule {arrival.suggestion.ruleName} (Suggest)
          </p>
        </section>
      ) : null}
      {editing ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Select
            value={type}
            onValueChange={(value) => {
              if (value && value in TYPES) setType(value as FactoryTaskType);
            }}
            disabled={busy}
          >
            <SelectTrigger size="sm" aria-label="Task type">
              <SelectValue>{TYPES[type]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(TYPES).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {busy ? (
            <AssigneeChip assignee={setup.assignee} />
          ) : (
            <TaskAssigneePicker
              environmentId={environmentId}
              projectId={arrival.projectId}
              type={type}
              value={assignment}
              onChange={setAssignment}
              trigger={
                <AssigneeChip
                  assignee={setup.assignee}
                  render={<button type="button" aria-label="Assignee" />}
                />
              }
            />
          )}
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || !command.permission} onClick={() => void send(command)}>
          Accept
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !(arrival.state === "snoozed" ? unsnooze : tomorrow).permission}
          onClick={() =>
            arrival.state === "snoozed" ? void send(unsnooze) : setSnoozing(!snoozing)
          }
        >
          {arrival.state === "snoozed" ? "Unsnooze" : "Snooze"}
        </Button>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={busy || !decline.permission}
          onClick={() => void send(decline)}
        >
          Decline
        </Button>
        <Button
          size="sm"
          variant="ghost-muted"
          disabled={busy || !duplicate.permission}
          onClick={() => void send(duplicate)}
        >
          Mark duplicate
        </Button>
      </div>
      {snoozing && arrival.state !== "snoozed" ? (
        <div aria-label="Snooze until" className="mt-3 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !tomorrow.permission}
            onClick={() => void send(tomorrow)}
          >
            Tomorrow
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !nextWeek.permission}
            onClick={() => void send(nextWeek)}
          >
            Next week
          </Button>
        </div>
      ) : null}
      {!command.permission ? (
        <p className="mt-3 text-muted-foreground text-sm">
          Ask the owner of this environment for access.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-destructive-foreground text-sm">
          {error}
        </p>
      ) : null}
    </>
  );
}

function useArrivalCommand(
  target: {
    environmentId: ArrivalEntry["environmentId"];
    commandId: CommandId;
    id: string;
    version: number;
  },
  action: FactoryIntakeArrivalAction,
) {
  return useFactoryTaskCommand(
    factoryIntake.resolveIntakeArrival,
    {
      environmentId: target.environmentId,
      input: {
        commandId: target.commandId,
        id: target.id,
        expectedVersion: target.version,
        action,
      },
    },
    { reportFailure: false },
  );
}

function snoozeUntil(now: string, days: number) {
  const date = new Date(`${now}:00Z`);
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}
