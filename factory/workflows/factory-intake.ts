// Every five minutes, turns the new issues of each project with intake on into Ready tasks.
import {
  INTAKE_PREFIX,
  IntakeBinding,
  StartOutcome,
  TaskRef,
  capturedKey,
  createTask,
  isStored,
  readAll,
  seenKey,
  startPool,
  startTask,
} from "./lib/records.ts";

const { workflow, step, skip, every, within, issues, store, Tick } = T3;

const Binding = Schema.Struct({
  projectId: Schema.String,
  labels: Schema.Array(Schema.String),
  autoStart: Schema.Boolean,
});

const NewIssue = Schema.Struct({
  key: Schema.String,
  displayKey: Schema.String,
  title: Schema.String,
  url: Schema.String,
});

const CapturedIssue = Schema.Struct({
  taskId: Schema.String,
  number: Schema.Number,
  projectId: Schema.String,
  issueKey: Schema.String,
});

const Failure = Schema.Struct({ projectId: Schema.String, reason: Schema.String });

/**
 * The issue as a Ready task and its seen record, written together; null when another run saw it
 * first. This run's marker comes first, so a step that runs again gives back the task it wrote.
 */
const captureIssue = Effect.fn("factoryIntake.captureIssue")(function* (
  runId: string,
  projectId: string,
  issue: typeof NewIssue.Type,
) {
  const seen = seenKey(projectId, issue.key);
  const marker = capturedKey(runId, `${projectId}/${issue.key}`);
  return yield* store.transaction(
    Effect.gen(function* () {
      if (!(yield* isStored(marker)) && (yield* isStored(seen))) return null;
      const title = issue.title.trim() === "" ? issue.displayKey : issue.title;
      const created = yield* createTask(
        {
          projectId,
          title: title.trim().slice(0, 200),
          description: issue.url,
          lane: "ready",
          parentId: null,
          blockedBy: [],
          assignee: null,
          model: null,
          source: { _tag: "issue", url: issue.url, displayKey: issue.displayKey },
        },
        marker,
      );
      if ("problem" in created) return yield* Effect.fail(created.problem);
      yield* store.entry(seen, TaskRef).set({ v: 1, taskId: created.task.id });
      return { taskId: created.task.id, number: created.task.number };
    }),
  );
});

export default [
  workflow(
    "factory-intake",
    {
      version: 1,
      payload: Tick,
      returns: Schema.Struct({
        captured: Schema.Array(CapturedIssue),
        failed: Schema.Array(Failure),
      }),
      triggers: [every("5 minutes")],
    },
    Effect.fn(function* (_tick, run) {
      const bindings = yield* step(
        "bindings",
        { returns: Schema.Array(Binding) },
        Effect.map(readAll(INTAKE_PREFIX, IntakeBinding), (rows) =>
          rows
            .filter((row) => row.value.enabled)
            .map((row) => ({
              projectId: row.key.slice(INTAKE_PREFIX.length),
              labels: row.value.labels,
              autoStart: row.value.autoStart,
            })),
        ),
      );
      const captured: Array<typeof CapturedIssue.Type> = [];
      const failed: Array<typeof Failure.Type> = [];
      for (const { projectId, labels, autoStart } of bindings) {
        const listing = yield* step.try(
          `issues/${projectId}`,
          { returns: Schema.Array(NewIssue) },
          Effect.gen(function* () {
            const listed = yield* issues.list({
              project: projectId,
              state: "open",
              labels,
              limit: 50,
            });
            const unseen: Array<typeof NewIssue.Type> = [];
            for (const issue of listed) {
              if (yield* isStored(seenKey(projectId, issue.key))) continue;
              const { key, displayKey, title, url } = issue;
              unseen.push({ key, displayKey, title, url });
            }
            return unseen;
          }),
        );
        if (listing.outcome === "failed") {
          failed.push({ projectId, reason: listing.reason });
          continue;
        }
        for (const issue of listing.value) {
          const capture = yield* step.try(
            `capture/${projectId}/${issue.key}`,
            {
              returns: Schema.NullOr(
                Schema.Struct({ taskId: Schema.String, number: Schema.Number }),
              ),
            },
            captureIssue(run.id, projectId, issue),
          );
          if (capture.outcome === "failed") {
            failed.push({ projectId, reason: capture.reason });
            continue;
          }
          const task = capture.value;
          if (task === null) continue;
          captured.push({ ...task, projectId, issueKey: issue.key });
          if (!autoStart) continue;
          const started = yield* within(
            startPool(task.taskId),
            { limit: 1 },
            step.try(
              `start/${projectId}/${issue.key}`,
              { returns: StartOutcome },
              startTask(task.taskId, "factory-intake", {
                runId: run.id,
                slot: `start/${projectId}/${issue.key}`,
              }),
            ),
          );
          if (started.outcome === "failed") failed.push({ projectId, reason: started.reason });
        }
      }
      if (captured.length === 0 && failed.length === 0) return yield* skip("no new issues");
      return { captured, failed };
    }),
  ),
];
