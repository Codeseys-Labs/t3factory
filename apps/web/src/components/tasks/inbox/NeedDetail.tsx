import type { FactoryTaskNeed } from "@t3tools/client-runtime/state/factory-task-view";
import {
  presentFactoryTaskActivity,
  presentFactoryTaskActor,
} from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useState } from "react";

import { useRelativeTimeState } from "../../../hooks/useRelativeTimeState";
import {
  factoryTasks,
  useFactoryTaskDetail,
  useFactoryTaskPlan,
  useFactoryTaskResult,
} from "../../../state/factoryTasks";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { ActivityItem, assigneeText, ResultCard } from "../kit";
import {
  TaskAsk,
  TaskAssigneeChip,
  useTaskActions,
  useTaskAssigneeChip,
  useTaskCatalog,
  useTaskPermissions,
} from "../shared";
import { openTaskSetup } from "../taskDialogs";

export function NeedDetail({ need }: { need: FactoryTaskNeed }) {
  const detail = useFactoryTaskDetail(need.ref);
  const registry = useContext(RegistryContext);
  if (detail._tag === "Initial") return <p role="status">Loading task…</p>;
  if (detail._tag === "Failure")
    return (
      <div role="alert" className="space-y-3">
        <p>Couldn't load this task.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            registry.refresh(
              factoryTasks.readTask({
                environmentId: need.ref.environmentId,
                input: { task: { ref: need.ref } },
              }),
            )
          }
        >
          Reload task
        </Button>
      </div>
    );
  const { task } = detail.value;
  return (
    <>
      <p className="text-muted-foreground text-xs">{task.displayId}</p>
      <h2 className="mt-3 font-semibold text-xl">{task.title}</h2>
      <div className="mt-4 mb-6 flex items-center justify-between gap-3">
        <TaskAssigneeChip assignee={task.assignee} environmentId={task.ref.environmentId} />
        <OpenTask task={task} />
      </div>
      <NeedAction need={need} task={task} />
      <RecentActivity task={task} />
    </>
  );
}

function OpenTask({ task }: { task: FactoryTaskSummary }) {
  return (
    <Link
      to="/tasks/$environmentId/$displayId"
      params={{ environmentId: task.ref.environmentId, displayId: task.displayId }}
      className="text-muted-foreground text-xs hover:text-foreground"
    >
      Open task
    </Link>
  );
}

function NeedAction({ need, task }: { need: FactoryTaskNeed; task: FactoryTaskSummary }) {
  const chip = useTaskAssigneeChip(task.assignee, task.ref.environmentId);
  const permissions = useTaskPermissions(task.ref.environmentId);
  if ((need.reason === "approve" || need.reason === "question") && need.threadId)
    return (
      <TaskAsk
        environmentId={task.ref.environmentId}
        threadId={need.threadId}
        requestId={need.requestId}
        from={assigneeText(chip)}
      />
    );
  if (need.reason === "failed")
    return (
      <section
        aria-label="Failed run"
        className="space-y-4 rounded-lg border border-destructive/32 bg-error-surface p-4"
      >
        <p className="whitespace-pre-wrap break-words text-sm">{task.run?.note || need.detail}</p>
        {task.run?.purpose === "planning" && task.run.state === "failed" ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!permissions.breakDown}
              onClick={() => openTaskSetup(task.ref, "break-down")}
            >
              Break down
            </Button>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!permissions.retry}
              onClick={() => openTaskSetup(task.ref, "retry")}
            >
              Retry
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!permissions.retry}
              onClick={() => openTaskSetup(task.ref, "retry")}
            >
              Reassign
            </Button>
          </div>
        )}
      </section>
    );
  if (need.reason === "review" || need.reason === "changed")
    return <ReviewResult key={task.result?.revision} task={task} />;
  if (need.reason === "plan") return <ReviewPlan task={task} />;
  if (need.reason === "unconfirmed") return <CheckDelivery need={need} task={task} />;
  if (need.reason === "lost") return <StopLostRun need={need} task={task} />;
  return <p className="text-muted-foreground text-sm">{need.detail}</p>;
}

/** A run that still says running with no agent left to end it. Stop settles it for a Retry. */
function StopLostRun({ need, task }: { need: FactoryTaskNeed; task: FactoryTaskSummary }) {
  const actions = useTaskActions();
  const permissions = useTaskPermissions(task.ref.environmentId);
  const [busy, setBusy] = useState(false);
  return (
    <section
      aria-label="Lost run"
      className="space-y-3 rounded-lg border border-destructive/32 bg-error-surface p-4"
    >
      <h3 className="font-medium text-sm">Run {task.run?.ordinal ?? ""} lost its agent</h3>
      <p className="text-muted-foreground text-sm">{need.detail}</p>
      <Button
        size="sm"
        variant="destructive"
        disabled={busy || !permissions.stop}
        onClick={() => {
          setBusy(true);
          void actions.stop(task).then(() => setBusy(false));
        }}
      >
        Stop
      </Button>
    </section>
  );
}

/** A sent Publish or Merge whose outcome is unknown. Check reads the host; it sends nothing. */
function CheckDelivery({ need, task }: { need: FactoryTaskNeed; task: FactoryTaskSummary }) {
  const actions = useTaskActions();
  const permissions = useTaskPermissions(task.ref.environmentId);
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="Unconfirmed" className="space-y-3 rounded-lg border bg-card p-4">
      <h3 className="font-medium text-sm">Unconfirmed</h3>
      <p className="text-muted-foreground text-sm">{need.detail}</p>
      <Button
        size="sm"
        disabled={busy || !permissions.check}
        onClick={() => {
          setBusy(true);
          void actions.check(task).then(() => setBusy(false));
        }}
      >
        Check
      </Button>
    </section>
  );
}

function ReviewResult({ task }: { task: FactoryTaskSummary }) {
  const read = useFactoryTaskResult(task.ref);
  const registry = useContext(RegistryContext);
  const actions = useTaskActions();
  const permissions = useTaskPermissions(task.ref.environmentId);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState("");
  if (read._tag === "Initial") return <p role="status">Loading result…</p>;
  if (read._tag === "Failure")
    return (
      <div role="alert" className="space-y-3">
        <p>Couldn't load the result.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            registry.refresh(
              factoryTasks.readTaskResult({
                environmentId: task.ref.environmentId,
                input: { ref: task.ref },
              }),
            )
          }
        >
          Reload result
        </Button>
      </div>
    );
  const result = read.value.result;
  if (result.state === "accepted")
    return <p className="text-sm">Accepted · rev {result.acceptedRevision ?? result.revision}</p>;
  const pullRequest = result.pullRequest ?? null;
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true);
    await operation();
    setBusy(false);
  };
  return (
    <div className="space-y-3">
      <div className="[&>div]:flex-wrap">
        <ResultCard
          kind={pullRequest ? "pull-request" : result.kind}
          title={
            pullRequest
              ? `PR #${pullRequest.number}`
              : result.kind === "document"
                ? "Document"
                : "Code changes"
          }
          meta={result.summary}
          review="pending"
          revisionLabel={`rev ${result.revision}`}
          pending={busy}
          {...(permissions.accept
            ? { onAccept: () => void run(() => actions.accept(task, result.revision)) }
            : {})}
          {...(permissions.requestChanges ? { onRequestChanges: () => setChanging(true) } : {})}
        />
      </div>
      {read.value.text ? (
        <p className="whitespace-pre-wrap break-words text-sm">{read.value.text}</p>
      ) : null}
      {changing ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (note.trim() && !busy)
              void run(async () => {
                const sent = await actions.requestChanges(task, result.revision, note.trim());
                if (sent !== null) setChanging(false);
              });
          }}
        >
          <Textarea
            aria-label="What should change"
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            placeholder="What should change?"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={busy || !note.trim() || !permissions.requestChanges}
            >
              Send
            </Button>
            <Button size="sm" variant="outline" type="button" onClick={() => setChanging(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ReviewPlan({ task }: { task: FactoryTaskSummary }) {
  const read = useFactoryTaskPlan(task.ref);
  const registry = useContext(RegistryContext);
  const actions = useTaskActions();
  const permissions = useTaskPermissions(task.ref.environmentId);
  const [busy, setBusy] = useState(false);
  if (read._tag === "Initial") return <p role="status">Loading plan…</p>;
  if (read._tag === "Failure")
    return (
      <div role="alert" className="space-y-3">
        <p>Couldn't load the plan.</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            registry.refresh(
              factoryTasks.readTaskPlanProposal({
                environmentId: task.ref.environmentId,
                input: { ref: task.ref },
              }),
            )
          }
        >
          Reload plan
        </Button>
      </div>
    );
  const plan = read.value.proposal;
  if (!plan || plan.status !== "proposed")
    return <p role="status">The plan changed. Open the task to see it.</p>;
  return (
    <section aria-label="Plan ready" className="space-y-3 rounded-lg border bg-card p-4">
      <h3 className="font-medium text-sm">Plan ready: {plan.items.length} sub-tasks</h3>
      <ol className="list-decimal space-y-2 ps-5 text-sm">
        {plan.items.map((item) => (
          <li key={item.key}>
            <p>{item.title}</p>
            {item.description ? (
              <p className="text-muted-foreground text-xs">{item.description}</p>
            ) : null}
          </li>
        ))}
      </ol>
      <Button
        size="sm"
        disabled={busy || !permissions.resolvePlan}
        onClick={() => {
          setBusy(true);
          void actions.resolvePlan(task, plan, "approve").then(() => setBusy(false));
        }}
      >
        Approve plan
      </Button>
    </section>
  );
}

function RecentActivity({ task }: { task: FactoryTaskSummary }) {
  const registry = useContext(RegistryContext);
  const latest = factoryTasks.readTaskActivity({
    environmentId: task.ref.environmentId,
    input: { ref: task.ref, order: "newest", limit: 3 },
  });
  const read = useAtomValue(latest);
  const catalog = useTaskCatalog(task.ref.environmentId);
  return (
    <section aria-label="Recent activity" className="mt-8 space-y-3">
      <h3 className="font-medium text-sm">Recent activity</h3>
      {read._tag === "Failure" ? (
        <div role="alert" className="flex items-center gap-2 text-muted-foreground text-xs">
          Couldn't load recent activity.
          <Button size="xs" variant="outline" onClick={() => registry.refresh(latest)}>
            Reload
          </Button>
        </div>
      ) : read._tag === "Initial" ? (
        <p role="status" className="text-muted-foreground text-xs">
          Loading activity…
        </p>
      ) : (
        read.value.entries.map((entry) => (
          <RecentEntry
            key={entry.id}
            entry={entry}
            text={presentFactoryTaskActivity(entry, catalog)}
            author={presentFactoryTaskActor(entry.actor, catalog)}
          />
        ))
      )}
    </section>
  );
}

function RecentEntry({
  entry,
  text,
  author,
}: {
  entry: Parameters<typeof presentFactoryTaskActivity>[0];
  text: string;
  author: string;
}) {
  const relative = useRelativeTimeState(entry.at);
  return (
    <ActivityItem
      kind="event"
      text={text}
      author={author}
      time={
        relative.status !== "relative"
          ? ""
          : relative.suffix
            ? `${relative.value} ${relative.suffix}`
            : relative.value
      }
    />
  );
}
