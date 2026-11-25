// A Factory task as durable work: plan it, do its parts side by side, then review and merge each
// part's pull request. Also the ways in for agents and the CLI: capturing a task, starting one.
import {
  FACTORY_TASK,
  FactoryTaskRunInput,
  ModelChoice,
  NO_PROJECT,
  PackConfig,
  StartOutcome,
  TaskLane,
  addNote,
  capturedKey,
  createTask,
  readConfig,
  startPool,
  startTask,
  taskTags,
} from "./lib/records.ts";

const { workflow, step, agent, ask, invoke, stop, title, tags, within, pullRequests } = T3;

const Plan = Schema.Struct({
  summary: Schema.String,
  parts: Schema.Array(Schema.Struct({ title: Schema.String, brief: Schema.String })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(6),
  ),
});

const PartPayload = Schema.Struct({
  taskId: Schema.String,
  number: Schema.Number,
  part: Schema.Number,
  title: Schema.String,
  brief: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelChoice),
  config: PackConfig,
});

const PartResult = Schema.Struct({
  outcome: Schema.Literals(["accepted", "merged"]),
  prUrl: Schema.NullOr(Schema.String),
});

const TaskResult = Schema.Struct({
  parts: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      outcome: Schema.Literals(["accepted", "merged", "stopped", "skipped", "cancelled"]),
      prUrl: Schema.NullOr(Schema.String),
    }),
  ),
});

const Done = Schema.Struct({
  summary: Schema.String,
  prUrl: Schema.NullOr(Schema.String),
});

const Review = Schema.Struct({
  verdict: Schema.Literals(["approve", "changes"]),
  notes: Schema.String,
});

const CapturePayload = Schema.Struct({
  title: Schema.String,
  description: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.NullOr(Schema.String)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  blockedBy: Schema.optional(Schema.Array(Schema.String)),
  lane: Schema.optional(TaskLane),
  assignee: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(ModelChoice)),
  issue: Schema.optional(Schema.Struct({ url: Schema.String, displayKey: Schema.String })),
  start: Schema.optional(Schema.Boolean),
});

const Problem = Schema.Struct({ problem: Schema.String });

const Captured = Schema.Union([
  Problem,
  Schema.Struct({ taskId: Schema.String, number: Schema.Number }),
]);

const Started = Schema.Struct({
  taskId: Schema.String,
  attempt: Schema.Number,
  runId: Schema.String,
});

const factoryTaskPart = workflow(
  "factory-task-part",
  {
    version: 1,
    payload: PartPayload,
    returns: PartResult,
    asks: { accept: "Accept the result?", stuck: "Review did not pass", merge: "Merge?" },
  },
  Effect.fn(function* (input) {
    const { config } = input;
    const label = `T-${input.number} part ${input.part + 1}`;
    const pool = `factory-task:${input.taskId}`;
    const slot = { limit: config.concurrency };
    yield* tags(taskTags(input.taskId, input.projectId, "doing"));
    if (input.projectId === null) return yield* stop(NO_PROJECT);
    const project = input.projectId;
    const workerModel = config.workerModel ?? input.model;
    const done = yield* within(
      pool,
      slot,
      agent("do", {
        project,
        title: `${label}: ${input.title}`,
        brief: [
          `Do part ${input.part + 1} of task T-${input.number}: ${input.title}`,
          "",
          input.brief,
          "",
          "Make the change in this worktree and check that it works.",
          "If the project is a Git repository with a remote, commit, push a branch, open a pull request and return its URL as `prUrl`. Otherwise return `prUrl: null`.",
          ...(config.baseRef === null
            ? []
            : [
                `Open the pull request against the branch \`${config.baseRef.replace(/^(?:origin\/|refs\/heads\/)/, "")}\`.`,
              ]),
          "Return a short `summary` of what you changed.",
        ].join("\n"),
        workspace: { type: "worktree", baseRef: config.baseRef ?? "HEAD" },
        runtimeMode: "full-access",
        ...(workerModel === null ? {} : { model: workerModel }),
        timeout: config.stepTimeout,
        returns: Done,
      }),
    );
    const { summary, prUrl: reported } = done.value;
    if (reported === null) {
      const accepted = yield* ask("accept", {
        title: `Accept ${label}: ${input.title}?`,
        kind: "accept",
        choices: ["Accept", "Redo"],
        data: { summary },
      });
      if (Option.isNone(accepted) || accepted.value.choice !== "Accept") {
        return yield* stop("not accepted");
      }
      return { outcome: "accepted", prUrl: null } as const;
    }

    const prUrl = yield* step(
      "pull-request",
      { returns: Schema.NullOr(Schema.String) },
      Effect.gen(function* () {
        const wanted = reported.trim().replace(/\/+$/, "").toLowerCase();
        if (wanted === "") return null;
        const listed = yield* pullRequests.list({ project, state: "all", limit: 500 });
        const found = listed.find(
          (entry) => entry.url.trim().replace(/\/+$/, "").toLowerCase() === wanted,
        );
        return found === undefined ? null : found.url;
      }),
    );
    if (prUrl === null) return yield* stop("pull request is not this project's");

    const pr = { project, url: prUrl };
    const links = [{ label: "Pull request", url: prUrl }];
    const reviewModel = config.reviewModel ?? input.model;
    yield* tags(taskTags(input.taskId, project, "review"));
    for (let r = 0; r <= config.fixRounds; r++) {
      const standing = yield* pullRequests.wait(`checks/${r}`, pr, {
        until: "checks",
        timeout: config.checksTimeout,
      });
      if (Option.isSome(standing) && standing.value.state === "merged") {
        return { outcome: "merged", prUrl } as const;
      }
      if (Option.isSome(standing) && standing.value.state === "closed") {
        return yield* stop("pull request closed");
      }
      let problem: string;
      if (
        Option.isSome(standing) &&
        (standing.value.checks === "passing" || standing.value.checks === "none")
      ) {
        const review = yield* within(
          pool,
          slot,
          agent(`review/${r}`, {
            project,
            title: `${label} review: ${input.title}`,
            brief: [
              `Review pull request ${prUrl}. It does part ${input.part + 1} of task T-${input.number}: ${input.title}`,
              "",
              "Its brief:",
              "",
              input.brief,
              "",
              "Change nothing. Read its diff and check that it does what the brief asks, works, and changes nothing else.",
              'Return `verdict: "approve"` when it can be merged as it is, or `verdict: "changes"` with `notes` saying what must change.',
            ].join("\n"),
            ...(reviewModel === null ? {} : { model: reviewModel }),
            timeout: config.stepTimeout,
            returns: Review,
          }),
        );
        if (review.value.verdict === "approve") break;
        problem = `A review asked for changes:\n\n${review.value.notes}`;
      } else {
        problem = Option.isNone(standing)
          ? `Its checks were still running after ${config.checksTimeout}.`
          : "Its checks are failing: read them on the pull request to find out why.";
      }
      if (r < config.fixRounds) {
        yield* within(
          pool,
          slot,
          agent(`fix/${r}`, {
            thread: done.thread,
            brief: [
              `Pull request ${prUrl} is not ready to merge. ${problem}`,
              "",
              "Fix it in your worktree, check it, and push to the same branch. Then say what you changed.",
            ].join("\n"),
            timeout: config.stepTimeout,
          }),
        );
        continue;
      }
      const stuck = yield* ask("stuck", {
        title: `${label} did not pass review: ${input.title}`,
        kind: "stuck",
        choices: ["Merge anyway", "Stop"],
        data: { prUrl, problem },
        links,
      });
      if (Option.isNone(stuck) || stuck.value.choice !== "Merge anyway") {
        return yield* stop("review did not pass");
      }
    }

    if (config.askMerge || config.mergeNeedsPerson) {
      const question = {
        title: `Merge ${label}: ${input.title}?`,
        kind: "merge",
        choices: ["Merge", "Hold"],
        links,
      } as const;
      const merge = yield* ask("approve-merge", question);
      if (Option.isNone(merge) || merge.value.choice !== "Merge") return yield* stop("merge held");
      // Only an answer given in the app carries a session; the server drops one a sender supplies.
      if (config.mergeNeedsPerson && merge.value.answeredBySession === undefined) {
        const person = yield* ask("approve-merge/person", question);
        if (
          Option.isNone(person) ||
          person.value.choice !== "Merge" ||
          person.value.answeredBySession === undefined
        ) {
          return yield* stop("merge held");
        }
      }
    }
    yield* step(
      "merge",
      { returns: Schema.Void },
      Effect.gen(function* () {
        const detail = yield* pullRequests.read(pr);
        if (detail.state === "merged") return;
        yield* pullRequests.act(pr, "merge", { mergeMethod: config.mergeMethod });
      }),
    );
    return { outcome: "merged", prUrl } as const;
  }),
);

const factoryTask = workflow(
  FACTORY_TASK,
  {
    version: 1,
    payload: FactoryTaskRunInput,
    returns: TaskResult,
    asks: { plan: "Approve the plan?" },
  },
  Effect.fn(function* (input, run) {
    yield* title(`T-${input.number} ${input.title}`);
    yield* tags(taskTags(input.taskId, input.projectId, "planning"));
    const config = yield* step("config", { returns: PackConfig }, readConfig(input.projectId));
    if (input.projectId === null) return yield* stop(NO_PROJECT);
    const planModel = config.planModel ?? input.model;
    const plan = yield* agent("plan", {
      project: input.projectId,
      title: `T-${input.number} plan: ${input.title}`,
      brief: [
        `Plan task T-${input.number}: ${input.title}`,
        ...(input.description.trim() === "" ? [] : ["", input.description]),
        ...(input.issueUrl === null ? [] : ["", `Issue: ${input.issueUrl}`]),
        "",
        "Change nothing: no edits, commits, branches or pull requests. Read what you need, then split the work into 1 to 6 parts that separate agents can do at the same time, each in its own worktree of this project.",
        "Each agent sees only its part's brief, so make every brief complete: what to change, where, and how to check it.",
        "Return a short summary of the plan and the parts, each with a title and its brief.",
      ].join("\n"),
      interactionMode: "plan",
      ...(planModel === null ? {} : { model: planModel }),
      timeout: config.stepTimeout,
      returns: Plan,
    });
    if (config.askPlan) {
      const answer = yield* ask("approve-plan", {
        title: `Start T-${input.number} ${input.title} in ${plan.value.parts.length} parts?`,
        kind: "plan",
        choices: ["Start", "Drop"],
        data: plan.value,
      });
      if (Option.isNone(answer) || answer.value.choice !== "Start") {
        return yield* stop("plan not approved");
      }
    }

    yield* tags(taskTags(input.taskId, input.projectId, "doing"));
    // All at once: each part takes a place in the task's pool only while one of its agents works.
    const parts = yield* Effect.all(
      plan.value.parts.map((part, i) =>
        Effect.map(
          invoke(`part-${i}`, factoryTaskPart, {
            taskId: input.taskId,
            number: input.number,
            part: i,
            title: part.title,
            brief: part.brief,
            projectId: input.projectId,
            model: input.model,
            config,
          }),
          (ended) =>
            ended.outcome === "completed"
              ? { title: part.title, outcome: ended.value.outcome, prUrl: ended.value.prUrl }
              : { title: part.title, outcome: ended.outcome, prUrl: null },
        ),
      ),
      { concurrency: "unbounded" },
    );
    const note = [
      `Attempt ${input.attempt} ended:`,
      ...parts.map(
        (part) => `- ${part.title}: ${part.outcome}${part.prUrl === null ? "" : ` ${part.prUrl}`}`,
      ),
    ].join("\n");
    yield* step(
      "finish",
      { returns: Schema.Void },
      addNote(input.taskId, note, FACTORY_TASK, capturedKey(run.id, "finish")),
    );
    yield* tags(taskTags(input.taskId, input.projectId, "done"));
    return { parts };
  }),
);

const factoryCapture = workflow(
  "factory-capture",
  {
    version: 1,
    payload: CapturePayload,
    returns: Schema.Union([
      Schema.Struct({
        taskId: Schema.String,
        number: Schema.Number,
        runId: Schema.NullOr(Schema.String),
      }),
      Problem,
    ]),
  },
  Effect.fn(function* (input, run) {
    const captured = yield* step(
      "capture",
      { returns: Captured },
      Effect.map(
        createTask(
          {
            projectId: input.projectId ?? null,
            title: input.title,
            description: input.description ?? "",
            lane: input.lane ?? "backlog",
            parentId: input.parentId ?? null,
            blockedBy: input.blockedBy ?? [],
            assignee: input.assignee ?? null,
            model: input.model ?? null,
            source:
              input.issue === undefined
                ? { _tag: "local" }
                : { _tag: "issue", url: input.issue.url, displayKey: input.issue.displayKey },
          },
          capturedKey(run.id, "capture"),
        ),
        (created) =>
          "problem" in created ? created : { taskId: created.task.id, number: created.task.number },
      ),
    );
    if ("problem" in captured) return { problem: captured.problem };
    if (input.start !== true) return { ...captured, runId: null };
    const started = yield* within(
      startPool(captured.taskId),
      { limit: 1 },
      step(
        "start",
        { returns: StartOutcome },
        startTask(factoryTask, captured.taskId, "factory-capture"),
      ),
    );
    return { ...captured, runId: started.outcome === "dropped" ? null : started.runId };
  }),
);

const factoryStart = workflow(
  "factory-start",
  { version: 1, payload: Schema.Struct({ taskId: Schema.String }), returns: Started },
  Effect.fn(function* (input) {
    const started = yield* within(
      startPool(input.taskId),
      { limit: 1 },
      step(
        "start",
        { returns: StartOutcome },
        startTask(factoryTask, input.taskId, "factory-start"),
      ),
    );
    if (started.outcome === "dropped") return yield* stop("task is dropped");
    if (started.outcome === "running") return yield* stop("already running");
    return { taskId: input.taskId, attempt: started.attempt, runId: started.runId };
  }),
);

export default [factoryTaskPart, factoryTask, factoryCapture, factoryStart];
