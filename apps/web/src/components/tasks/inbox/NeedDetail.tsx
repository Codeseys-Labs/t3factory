import type { FactoryTaskNeed } from "@t3tools/client-runtime/state/factory-task-view";
import {
  factoryTaskFailedRun,
  presentFactoryTaskActivity,
  presentFactoryTaskActor,
  presentFactoryTaskRunRecovery,
} from "@t3tools/client-runtime/state/factory-task-view";
import type { FactoryTaskSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useContext, useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

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
  useGiveUpResult,
  useTaskActions,
  useTaskAssigneeChip,
  useTaskCatalog,
  useTaskPermissions,
} from "../shared";
import { openTaskSetup } from "../taskDialogs";

export function NeedDetail({ need }: { need: FactoryTaskNeed }) {
  const detail = useFactoryTaskDetail(need.ref);
  const registry = useContext(RegistryContext);
  if (detail._tag === "Initial")
    return (
      <p role="status">
        <T>Loading task…</T>
      </p>
    );
  if (detail._tag === "Failure")
    return (
      <div role="alert" className="space-y-3">
        <p>
          <T>Couldn't load this task.</T>
        </p>
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
          <T>Reload task</T>
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
      <T>Open task</T>
    </Link>
  );
}

function NeedAction({ need, task }: { need: FactoryTaskNeed; task: FactoryTaskSummary }) {
  const chip = useTaskAssigneeChip(task.assignee, task.ref.environmentId);
  const permissions = useTaskPermissions(task.ref.environmentId);
  const messages = useMessages();
  const gt = useGT();
  if ((need.reason === "approve" || need.reason === "question") && need.threadId)
    return (
      <TaskAsk
        environmentId={task.ref.environmentId}
        threadId={need.threadId}
        requestId={need.requestId}
        from={assigneeText(chip, messages)}
      />
    );
  if (need.reason === "failed") {
    const failedRun = factoryTaskFailedRun(task);
    return (
      <section
        aria-label={failedRun?.state === "held" ? gt("Held run") : gt("Failed run")}
        className="space-y-4 rounded-lg border border-destructive/32 bg-error-surface p-4"
      >
        <p className="whitespace-pre-wrap break-words text-sm">{failedRun?.note || need.detail}</p>
        {failedRun?.purpose === "planning" && failedRun.state === "failed" ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!permissions.breakDown}
              onClick={() => openTaskSetup(task.ref, "break-down")}
            >
              <T>Break down</T>
            </Button>
          </div>
        ) : (
          <RecoverRun task={task} />
        )}
      </section>
    );
  }
  if (need.reason === "review" || need.reason === "changed")
    return <ReviewResult key={task.result?.revision} task={task} />;
  if (need.reason === "plan") return <ReviewPlan task={task} />;
  if (need.reason === "unconfirmed") return <CheckDelivery need={need} task={task} />;
  if (need.reason === "lost") return <StopLostRun need={need} task={task} />;
  return <p className="text-muted-foreground text-sm">{need.detail}</p>;
}

/** Retry and Reassign, or Save again and Give up result on a run whose result was not saved. */
function RecoverRun({ task }: { task: FactoryTaskSummary }) {
  const actions = useTaskActions();
  const permissions = useTaskPermissions(task.ref.environmentId);
  const [busy, setBusy] = useState(false);
  const giveUp = useGiveUpResult(task);
  const run = factoryTaskFailedRun(task);
  const recovery = presentFactoryTaskRunRecovery(run);
  if (recovery.length === 0) return null;
  if (recovery[0]?.kind === "save-again")
    return (
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !permissions.saveAgain}
          onClick={() => {
            setBusy(true);
            void actions.saveAgain(task).then(() => setBusy(false));
          }}
        >
          <T>Save again</T>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !permissions.giveUp || run === null}
          onClick={() => run && giveUp.open(run)}
        >
          <T>Give up result</T>
        </Button>
        {giveUp.dialog}
      </div>
    );
  return (
    <div className="flex gap-2">
      <Button
        size="sm"
        disabled={!permissions.retry}
        onClick={() => openTaskSetup(task.ref, "retry")}
      >
        <T>Retry</T>
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={!permissions.retry}
        onClick={() => openTaskSetup(task.ref, "retry")}
      >
        <T>Reassign</T>
      </Button>
    </div>
  );
}

/** A run that still says running with no agent left to end it. Stop settles it for a Retry. */
function StopLostRun({ need, task }: { need: FactoryTaskNeed; task: FactoryTaskSummary }) {
  const actions = useTaskActions();
  const permissions = useTaskPermissions(task.ref.environmentId);
  const [busy, setBusy] = useState(false);
  const gt = useGT();
  return (
    <section
      aria-label={gt("Lost run")}
      className="space-y-3 rounded-lg border border-destructive/32 bg-error-surface p-4"
    >
      <h3 className="font-medium text-sm">
        <T>
          Run <Var>{task.run?.ordinal ?? ""}</Var> lost its agent
        </T>
      </h3>
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
        <T>Stop</T>
      </Button>
    </section>
  );
}

/** A sent Publish or Merge whose outcome is unknown. Check reads the host; it sends nothing. */
function CheckDelivery({ need, task }: { need: FactoryTaskNeed; task: FactoryTaskSummary }) {
  const actions = useTaskActions();
  const permissions = useTaskPermissions(task.ref.environmentId);
  const [busy, setBusy] = useState(false);
  const gt = useGT();
  return (
    <section aria-label={gt("Unconfirmed")} className="space-y-3 rounded-lg border bg-card p-4">
      <h3 className="font-medium text-sm">
        <T>Unconfirmed</T>
      </h3>
      <p className="text-muted-foreground text-sm">{need.detail}</p>
      <Button
        size="sm"
        disabled={busy || !permissions.check}
        onClick={() => {
          setBusy(true);
          void actions.check(task).then(() => setBusy(false));
        }}
      >
        <T>Check</T>
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
  const gt = useGT();
  if (read._tag === "Initial")
    return (
      <p role="status">
        <T>Loading result…</T>
      </p>
    );
  if (read._tag === "Failure")
    return (
      <div role="alert" className="space-y-3">
        <p>
          <T>Couldn't load the result.</T>
        </p>
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
          <T>Reload result</T>
        </Button>
      </div>
    );
  const result = read.value.result;
  if (result.state === "accepted")
    return (
      <p className="text-sm">
        <T>
          Accepted · rev <Var>{result.acceptedRevision ?? result.revision}</Var>
        </T>
      </p>
    );
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
              ? gt("PR #{number}", { number: pullRequest.number })
              : result.kind === "document"
                ? gt("Document")
                : gt("Code changes")
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
            aria-label={gt("What should change")}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
            placeholder={gt("What should change?")}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              type="submit"
              disabled={busy || !note.trim() || !permissions.requestChanges}
            >
              <T>Send</T>
            </Button>
            <Button size="sm" variant="outline" type="button" onClick={() => setChanging(false)}>
              <T>Cancel</T>
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
  const gt = useGT();
  if (read._tag === "Initial")
    return (
      <p role="status">
        <T>Loading plan…</T>
      </p>
    );
  if (read._tag === "Failure")
    return (
      <div role="alert" className="space-y-3">
        <p>
          <T>Couldn't load the plan.</T>
        </p>
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
          <T>Reload plan</T>
        </Button>
      </div>
    );
  const plan = read.value.proposal;
  if (!plan || plan.status !== "proposed")
    return (
      <p role="status">
        <T>The plan changed. Open the task to see it.</T>
      </p>
    );
  return (
    <section aria-label={gt("Plan ready")} className="space-y-3 rounded-lg border bg-card p-4">
      <h3 className="font-medium text-sm">
        <T>
          Plan ready: <Var>{plan.items.length}</Var> sub-tasks
        </T>
      </h3>
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
        <T>Approve plan</T>
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
  const messages = useMessages();
  const gt = useGT();
  return (
    <section aria-label={gt("Recent activity")} className="mt-8 space-y-3">
      <h3 className="font-medium text-sm">
        <T>Recent activity</T>
      </h3>
      {read._tag === "Failure" ? (
        <div role="alert" className="flex items-center gap-2 text-muted-foreground text-xs">
          <T>Couldn't load recent activity.</T>
          <Button size="xs" variant="outline" onClick={() => registry.refresh(latest)}>
            <T>Reload</T>
          </Button>
        </div>
      ) : read._tag === "Initial" ? (
        <p role="status" className="text-muted-foreground text-xs">
          <T>Loading activity…</T>
        </p>
      ) : (
        read.value.entries.map((entry) => (
          <RecentEntry
            key={entry.id}
            entry={entry}
            text={presentFactoryTaskActivity(entry, catalog, messages)}
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
