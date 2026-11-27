// @effect-diagnostics globalDateInEffect:off globalDate:off nodeBuiltinImport:off cryptoRandomUUIDInEffect:off - a workflow file runs in the loader, which provides no platform services.
// The records the pack shares with the server's FactoryTasks service, the store work both
// workflow files do with them, and the review gates every workflow that merges goes through.
// Everything here that touches the store is for inside a `step`.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import {
  GLOBAL_WRITE_ROW_REFUSED,
  WRITE_NEEDS_BASE,
  WRITE_NEEDS_MODEL,
  baseFromLsRemote,
  baseUnread,
  headUnusable,
  isFullSha,
  mergeMark,
  namesFolder,
  placementFor,
  placementsAgree,
  placementsDiffer,
  writePlacementFor,
  wrongBase,
} from "./placement.ts";

const { ask, pullRequests, runs, sleep, start, step, stop, store } = T3;

const PREFIX = "factory/v1/";
const SEQ_KEY = `${PREFIX}seq`;
const TASK_PREFIX = `${PREFIX}task/`;
export const INTAKE_PREFIX = `${PREFIX}intake/`;
export const FACTORY_TASK = "factory-task";
const FACTORY_KIND_WORKFLOWS = {
  software: FACTORY_TASK,
  knowledge: "factory-brief",
  research: "factory-experiment",
} as const;
const NO_SCRATCH =
  "Start this task once from the Work page so the server can set up its scratch folder.";

// The wire schemas' bounds and patterns (packages/contracts), which a workflow file cannot import.
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 8000;
const BLOCKED_BY_MAX = 50;
const ASSIGNEE_MAX = 100;
const NOTE_MAX = 4000;
const INSTANCE_ID_MAX = 64;
const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const PATH_MAX = 1024;
const LABEL_MAX = 200;
const INLINE_MAX = 65536;
const REASON_MAX = 4000;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonBlank = Schema.String.check(
  Schema.makeFilter((text: string) => text.trim().length > 0, { expected: "a non-blank string" }),
);
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const TaskLane = Schema.Literals(["backlog", "ready", "doing", "review", "done", "dropped"]);
const FactoryTaskKind = Schema.Literals(["software", "knowledge", "research"]);

export const ModelChoice = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean]) }),
    ),
  ),
});
type ModelChoice = typeof ModelChoice.Type;

/** `model` as the wire keeps it, trimmed; undefined when the wire would refuse it. */
const wireModel = (model: ModelChoice): ModelChoice | undefined => {
  const instanceId = model.instanceId.trim();
  const name = model.model.trim();
  const options = model.options?.map((option) => ({
    id: option.id.trim(),
    value: typeof option.value === "string" ? option.value.trim() : option.value,
  }));
  if (
    instanceId.length > INSTANCE_ID_MAX ||
    !INSTANCE_ID_PATTERN.test(instanceId) ||
    name === "" ||
    options?.some((option) => option.id === "" || option.value === "")
  ) {
    return undefined;
  }
  return { instanceId, model: name, ...(options === undefined ? {} : { options }) };
};

const TaskSource = Schema.Union([
  Schema.TaggedStruct("local", {}),
  Schema.TaggedStruct("issue", { url: Schema.String, displayKey: Schema.String }),
  Schema.TaggedStruct("promoted", { fromTaskId: Schema.String, artifactSha256: Sha256 }),
  Schema.TaggedStruct("signal", {
    feedId: Schema.String,
    candidateId: Sha256,
    revision: PositiveInt,
    sha256: Sha256,
  }),
]);

export const FactoryTask = Schema.Struct({
  v: Schema.Literal(1),
  id: Schema.String,
  number: PositiveInt,
  rev: PositiveInt,
  projectId: Schema.NullOr(NonBlank),
  title: Schema.String.check(
    Schema.makeFilter(
      (title: string) => title.trim().length >= 1 && title.trim().length <= TITLE_MAX,
      { expected: `1 to ${TITLE_MAX} characters after trimming` },
    ),
  ),
  description: Schema.String.check(Schema.isMaxLength(DESCRIPTION_MAX)),
  lane: TaskLane,
  laneSetAt: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  blockedBy: Schema.Array(Schema.String).check(Schema.isMaxLength(BLOCKED_BY_MAX)),
  assignee: Schema.NullOr(Schema.String.check(Schema.isMaxLength(ASSIGNEE_MAX))),
  model: Schema.NullOr(
    ModelChoice.check(
      Schema.makeFilter((model: ModelChoice) => wireModel(model) !== undefined, {
        expected: "a model the wire accepts",
      }),
    ),
  ),
  source: TaskSource,
  kind: Schema.optionalKey(FactoryTaskKind),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type FactoryTask = typeof FactoryTask.Type;

const FactoryAttempt = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  n: PositiveInt,
  key: Schema.String,
  workflow: Schema.String,
  runId: Schema.NullOr(Schema.String),
  requestedBy: Schema.String,
  startedAt: Schema.String,
  // Only the pack writes this, once the attempt's run began; the server never rewrites it after.
  prUrls: Schema.optionalKey(Schema.Array(Schema.String)),
});
type FactoryAttempt = typeof FactoryAttempt.Type;

const FactoryNote = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  id: Schema.String,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(NOTE_MAX)),
  by: Schema.String,
  at: Schema.String,
});

export const IntakeBinding = Schema.Struct({
  v: Schema.Literal(1),
  enabled: Schema.Boolean,
  labels: Schema.Array(Schema.String),
  autoStart: Schema.Boolean,
  authors: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,39}$/))).check(
      Schema.isMaxLength(100),
    ),
  ),
});

/** What an intake-seen record and a capture marker hold: the task they name. */
export const TaskRef = Schema.Struct({ v: Schema.Literal(1), taskId: Schema.String });

const FactoryArtifact = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  attempt: PositiveInt,
  sha256: Sha256,
  kind: Schema.Literals(["deliverable", "brief", "protocol", "evaluator", "results", "file"]),
  location: Schema.Union([
    Schema.TaggedStruct("file", { path: Schema.String.check(Schema.isMaxLength(PATH_MAX)) }),
    Schema.TaggedStruct("inline", { text: Schema.String.check(Schema.isMaxLength(INLINE_MAX)) }),
  ]),
  bytes: NonNegativeInt,
  label: Schema.String.check(Schema.isMaxLength(LABEL_MAX)),
  step: Schema.String,
  runId: Schema.String,
  at: Schema.String,
});
type FactoryArtifact = typeof FactoryArtifact.Type;

const FactoryReceipt = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  attempt: PositiveInt,
  sha256: Sha256,
  kind: Schema.Literals([
    "sealed",
    "critiqued",
    "accepted",
    "rejected",
    "delivered",
    "uncertain",
    "promoted",
  ]),
  by: Schema.Literals(["person", "agent", "pack"]),
  runId: Schema.String,
  at: Schema.String,
  detail: Schema.optionalKey(
    Schema.Struct({
      url: Schema.optionalKey(Schema.String),
      commentId: Schema.optionalKey(Schema.String),
      reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(REASON_MAX))),
      taskId: Schema.optionalKey(Schema.String),
    }),
  ),
});
type FactoryReceipt = typeof FactoryReceipt.Type;

const Workspace = Schema.Literals(["worktree", "root", "scratch"]);

/** Where the server found a task's project can be worked on; only FactoryTasks writes it. */
const FactoryTarget = Schema.Struct({
  v: Schema.Literal(1),
  projectId: Schema.NullOr(Schema.String),
  workspace: Workspace,
  workspaceRoot: Schema.NullOr(Schema.String),
  problem: Schema.NullOr(Schema.String),
  checkedAt: Schema.String,
});

/** The project a run's agents work in, and how: `projectId` is the scratch project for scratch. */
export const RunTarget = Schema.Struct({
  workspace: Workspace,
  projectId: Schema.String,
  workspaceRoot: Schema.NullOr(Schema.String),
});

const TargetOrProblem = Schema.Union([RunTarget, Schema.Struct({ problem: Schema.String })]);

export const FactoryTaskRunInput = Schema.Struct({
  taskId: Schema.String,
  number: Schema.Number,
  attempt: Schema.Number,
  title: Schema.String,
  description: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelChoice),
  issueUrl: Schema.NullOr(Schema.String),
});
export type FactoryTaskRunInput = typeof FactoryTaskRunInput.Type;

type TaskWorkflow = Parameters<typeof start<FactoryTaskRunInput>>[0];

// `start` reads only the name and version. A workflow file cannot import another for its
// definition: the loader would register that file's workflows twice.
export const FACTORY_TASK_VERSION = 4;
const workflowRef = (name: string) =>
  ({ name, version: name === FACTORY_TASK ? FACTORY_TASK_VERSION : 1 }) as unknown as TaskWorkflow;

type DurationInput = Parameters<typeof Duration.fromInput>[0];
const DurationText = Schema.String.pipe(
  Schema.refine(
    (text): text is Extract<DurationInput, string> =>
      Option.isSome(Duration.fromInput(text as DurationInput)),
    { expected: 'a duration such as "45 minutes"' },
  ),
);

const ID_MAX = 200;
const PlacementId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(ID_MAX),
  Schema.makeFilter((value: string) => value === value.trim(), { expected: "an unpadded id" }),
);
const ReadOnlyOn = Schema.Struct({
  environment: PlacementId,
  project: PlacementId.check(
    Schema.makeFilter((value: string) => !namesFolder(value), {
      expected: "a project id, not a folder",
    }),
  ),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
});
const WriteOn = ReadOnlyOn;

const configFields = {
  concurrency: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  askPlan: Schema.Boolean,
  askMerge: Schema.Boolean,
  mergeNeedsPerson: Schema.Boolean,
  planModel: Schema.NullOr(ModelChoice),
  workerModel: Schema.NullOr(ModelChoice),
  reviewModel: Schema.NullOr(ModelChoice),
  baseRef: Schema.NullOr(Schema.String),
  stepTimeout: DurationText,
  checksTimeout: DurationText,
  fixRounds: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 })),
  mergeMethod: Schema.Literals(["merge", "squash", "rebase", "fast-forward"]),
  protectedPaths: Schema.Array(Schema.String),
  lowRiskPaths: Schema.Array(Schema.String),
};

export const PackConfig = Schema.Struct({
  v: Schema.Literal(1),
  ...configFields,
  readOnlyOn: Schema.optionalKey(ReadOnlyOn),
  writeOn: Schema.optionalKey(WriteOn),
});
export type PackConfig = typeof PackConfig.Type;

const StoredConfig = Schema.Struct({
  v: Schema.optionalKey(Schema.Literal(1)),
  concurrency: Schema.optionalKey(configFields.concurrency),
  askPlan: Schema.optionalKey(configFields.askPlan),
  askMerge: Schema.optionalKey(configFields.askMerge),
  mergeNeedsPerson: Schema.optionalKey(configFields.mergeNeedsPerson),
  planModel: Schema.optionalKey(configFields.planModel),
  workerModel: Schema.optionalKey(configFields.workerModel),
  reviewModel: Schema.optionalKey(configFields.reviewModel),
  baseRef: Schema.optionalKey(configFields.baseRef),
  stepTimeout: Schema.optionalKey(configFields.stepTimeout),
  checksTimeout: Schema.optionalKey(configFields.checksTimeout),
  fixRounds: Schema.optionalKey(configFields.fixRounds),
  mergeMethod: Schema.optionalKey(configFields.mergeMethod),
  protectedPaths: Schema.optionalKey(configFields.protectedPaths),
  lowRiskPaths: Schema.optionalKey(configFields.lowRiskPaths),
  readOnlyOn: Schema.optionalKey(Schema.NullOr(ReadOnlyOn)),
  writeOn: Schema.optionalKey(Schema.NullOr(WriteOn)),
});

const DEFAULT_CONFIG: PackConfig = {
  v: 1,
  concurrency: 2,
  askPlan: true,
  askMerge: true,
  mergeNeedsPerson: false,
  planModel: null,
  workerModel: null,
  reviewModel: null,
  baseRef: null,
  stepTimeout: "2 hours",
  checksTimeout: "1 hour",
  fixRounds: 2,
  mergeMethod: "squash",
  protectedPaths: [],
  lowRiskPaths: [],
};

/** How a start from the pack went: begun, refused for a live run, or refused for a dropped task. */
export const StartOutcome = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("started"),
    attempt: Schema.Number,
    runId: Schema.String,
  }),
  Schema.Struct({ outcome: Schema.Literal("running"), runId: Schema.String }),
  Schema.Struct({ outcome: Schema.Literal("dropped") }),
]);

/** The pool that lets one start of a task through at a time. */
export const startPool = (taskId: string) => `factory-start:${taskId}`;

/** The lock on a project folder that agents work in directly, shared by every task on it. */
export const rootPool = (projectId: string) => `factory-root:${projectId}`;

const taskKey = (taskId: string) => `${TASK_PREFIX}${taskId}`;
const attemptPrefix = (taskId: string) => `${PREFIX}attempt/${taskId}/`;
const attemptSegment = (n: number) => String(n).padStart(4, "0");
const attemptKey = (taskId: string, n: number) => `${attemptPrefix(taskId)}${attemptSegment(n)}`;
const artifactKey = (taskId: string, attempt: number, sha256: string) =>
  `${PREFIX}artifact/${taskId}/${attemptSegment(attempt)}/${sha256}`;
const receiptKey = (taskId: string, attempt: number, kind: string, sha256: string) =>
  `${PREFIX}receipt/${taskId}/${attemptSegment(attempt)}/${kind}-${sha256.slice(0, 16)}`;
const targetKey = (projectId: string | null) => `${PREFIX}target/${projectId ?? "scratch"}`;
export const seenKey = (projectId: string, issueKey: string) =>
  `${PREFIX}intake-seen/${projectId}/${issueKey}`;
export const capturedKey = (runId: string, slot: string) => `${PREFIX}captured/${runId}/${slot}`;

export const now = Effect.clockWith((clock) =>
  Effect.map(clock.currentTimeMillis, (millis) => new Date(millis).toISOString()),
);

type Decodable = Parameters<typeof Schema.decodeUnknownOption>[0];

/** Whether anything is stored at `key`, whether or not it decodes. */
export const isStored = (key: string) =>
  Effect.map(store.entry(key, Schema.Json).get, Option.isSome);

/** The record at `key`, or none when it is missing or does not decode. */
const readRecord = Effect.fn("factoryPack.readRecord")(function* <S extends Decodable>(
  key: string,
  schema: S,
) {
  const found = yield* store.entry(key, Schema.Json).get;
  return Option.flatMap(found, Schema.decodeUnknownOption(schema));
});

/** Every record under `prefix` that decodes, in key order; one that does not is skipped. */
export const readAll = Effect.fn("factoryPack.readAll")(function* <S extends Decodable>(
  prefix: string,
  schema: S,
) {
  const decode = Schema.decodeUnknownOption(schema);
  const rows = yield* store.entries(prefix, Schema.Json);
  return rows.flatMap((row) =>
    Option.match(decode(row.value), {
      onNone: () => [],
      onSome: (value) => [{ key: row.key, value }],
    }),
  );
});

export const readTask = (taskId: string) => readRecord(taskKey(taskId), FactoryTask);

/** Every attempt recorded for `taskId` that decodes, in number order. */
export const listAttempts = (taskId: string) =>
  Effect.map(readAll(attemptPrefix(taskId), FactoryAttempt), (rows) =>
    rows.map((row) => row.value),
  );

const decodeStoredConfig = Schema.decodeUnknownEffect(StoredConfig);
const GLOBAL_CONFIG_KEY = `${PREFIX}config`;
const GLOBAL_ROW_REFUSED =
  "The Factory config at factory/v1/config is not valid: readOnlyOn names one project on another machine, so it belongs in factory/v1/config/<projectId>.";

/** A config row's fields; a row that is there and does not decode fails, naming its key. */
const readConfigRow = Effect.fn("factoryPack.readConfigRow")(function* (key: string) {
  const found = yield* store.entry(key, Schema.Json).get;
  if (Option.isNone(found)) return undefined;
  const raw = found.value;
  if (key === GLOBAL_CONFIG_KEY && raw !== null && typeof raw === "object") {
    if ("readOnlyOn" in raw && raw.readOnlyOn !== null) {
      return yield* Effect.fail(GLOBAL_ROW_REFUSED);
    }
    if ("writeOn" in raw && raw.writeOn !== null) {
      return yield* Effect.fail(GLOBAL_WRITE_ROW_REFUSED);
    }
  }
  const { readOnlyOn, writeOn, ...fields } = yield* decodeStoredConfig(raw).pipe(
    Effect.mapError((error) => `The Factory config at ${key} is not valid: ${error.message}`),
  );
  if (!placementsAgree(readOnlyOn ?? undefined, writeOn ?? undefined)) {
    return yield* Effect.fail(placementsDiffer(key));
  }
  return {
    ...fields,
    ...(readOnlyOn == null ? {} : { readOnlyOn }),
    ...(writeOn == null ? {} : { writeOn }),
  };
});

/** The global config with the project's fields over it, over the defaults. */
export const readConfig = Effect.fn("factoryPack.readConfig")(function* (projectId: string | null) {
  const global = yield* readConfigRow(GLOBAL_CONFIG_KEY);
  const project =
    projectId === null ? undefined : yield* readConfigRow(`${PREFIX}config/${projectId}`);
  const config: PackConfig = { ...DEFAULT_CONFIG, ...global, ...project, v: 1 };
  return config;
});

type NewTask = Omit<
  FactoryTask,
  "v" | "id" | "number" | "rev" | "laneSetAt" | "createdAt" | "updatedAt"
>;

const isTaskKind = Schema.is(FactoryTaskKind);

/** `fields` as the service would store them, or why the service would answer `invalid`. */
const checkedTask = (
  fields: Omit<NewTask, "kind"> & { readonly kind?: string },
): { readonly task: NewTask } | { readonly problem: string } => {
  const { kind, ...rest } = fields;
  const title = fields.title.trim();
  const projectId = fields.projectId === null ? null : fields.projectId.trim();
  const blockedBy = [...new Set(fields.blockedBy)];
  const model = fields.model === null ? null : wireModel(fields.model);
  if (kind !== undefined && !isTaskKind(kind)) {
    return { problem: "A task's kind is software, knowledge or research." };
  }
  if (title.length === 0 || title.length > TITLE_MAX) {
    return { problem: `A task's title is 1 to ${TITLE_MAX} characters.` };
  }
  if (projectId === "") return { problem: "A task's project id cannot be blank." };
  if (fields.description.length > DESCRIPTION_MAX) {
    return { problem: `A task's description is at most ${DESCRIPTION_MAX} characters.` };
  }
  if (blockedBy.length > BLOCKED_BY_MAX) {
    return { problem: `A task is blocked by at most ${BLOCKED_BY_MAX} tasks.` };
  }
  if (fields.assignee !== null && fields.assignee.length > ASSIGNEE_MAX) {
    return { problem: `A task's assignee is at most ${ASSIGNEE_MAX} characters.` };
  }
  if (model === undefined) {
    return {
      problem:
        "A task's model needs an `instanceId` of letters, digits, `_` and `-` starting with a letter, a non-blank `model`, and a non-blank `id` and `value` for each option.",
    };
  }
  return {
    task: { ...rest, projectId, title, blockedBy, model, ...(kind === undefined ? {} : { kind }) },
  };
};

/** One more than `seq`, written back; a damaged `seq` counts from the highest task number. */
const nextNumber = Effect.gen(function* () {
  const seq = store.entry(SEQ_KEY, Schema.Json);
  const stored = Option.getOrElse(yield* seq.get, () => 0);
  let last = 0;
  if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
    last = stored;
  } else {
    for (const row of yield* readAll(TASK_PREFIX, FactoryTask)) {
      last = Math.max(last, row.value.number);
    }
  }
  yield* seq.set(last + 1);
  return last + 1;
});

/**
 * Writes a new task under the next number, or says why `fields` cannot be one. `marker` makes it
 * once per caller: a second call with the same marker gives back the task the first one wrote.
 */
export const createTask = Effect.fn("factoryPack.createTask")(function* (
  fields: Parameters<typeof checkedTask>[0],
  marker: string,
) {
  const checked = checkedTask(fields);
  if ("problem" in checked) return checked;
  const { task } = checked;
  return yield* store.transaction(
    Effect.gen(function* () {
      const marked = yield* readRecord(marker, TaskRef);
      if (Option.isSome(marked)) {
        const earlier = yield* readTask(marked.value.taskId);
        if (Option.isSome(earlier)) return { task: earlier.value };
      }
      for (const id of [
        ...(task.parentId === null ? [] : [task.parentId]),
        ...task.blockedBy,
        ...(task.source._tag === "promoted" ? [task.source.fromTaskId] : []),
      ]) {
        if (Option.isNone(yield* readTask(id))) return { problem: `There is no task ${id}.` };
      }
      const number = yield* nextNumber;
      const at = yield* now;
      const record: FactoryTask = {
        v: 1,
        id: crypto.randomUUID(),
        number,
        rev: 1,
        ...task,
        laneSetAt: at,
        createdAt: at,
        updatedAt: at,
      };
      yield* store.entry(taskKey(record.id), FactoryTask).set(record);
      yield* store.entry(marker, TaskRef).set({ v: 1, taskId: record.id });
      return { task: record };
    }),
  );
});

const highest = (attempts: ReadonlyArray<FactoryAttempt>) =>
  attempts.reduce<FactoryAttempt | undefined>(
    (last, attempt) => (last === undefined || attempt.n > last.n ? attempt : last),
    undefined,
  );

/**
 * Starts a task like the service's `start`, serialized by `within(startPool(taskId), { limit: 1 })`:
 * the workflow of the task's kind, under a key no other workflow has had.
 * `caller` keys a replay marker committed with `runId` so a replayed step returns the same start.
 */
export const startTask = Effect.fn("factoryPack.startTask")(function* (
  taskId: string,
  requestedBy: string,
  caller: { readonly runId: string; readonly slot: string },
) {
  const marker = capturedKey(caller.runId, caller.slot);
  const replayed = yield* readRecord(marker, StartOutcome);
  if (Option.isSome(replayed)) return replayed.value;
  const found = yield* readTask(taskId);
  if (Option.isNone(found)) return yield* Effect.fail(`There is no task ${taskId}.`);
  const task = found.value;
  if (task.lane === "dropped") return { outcome: "dropped" } as const;
  const workflowName = FACTORY_KIND_WORKFLOWS[task.kind ?? "software"];
  const attempts = yield* listAttempts(taskId);
  const ran = highest(attempts.filter((attempt) => attempt.runId !== null));
  if (ran !== undefined && ran.runId !== null) {
    const ranId = ran.runId;
    const listed = yield* runs({ keyPrefix: `task/${taskId}/` });
    if (listed.some((run) => run.id === ranId && run.endedAt === null)) {
      return { outcome: "running", runId: ranId } as const;
    }
  }
  // The attempt's run, recorded with this caller's marker, and the task moved to Doing.
  const recorded = Effect.fnUntraced(function* (attempt: FactoryAttempt, runId: string) {
    const started = { outcome: "started", attempt: attempt.n, runId } as const;
    yield* store.transaction(
      Effect.gen(function* () {
        yield* store
          .entry(attemptKey(taskId, attempt.n), FactoryAttempt)
          .set({ ...attempt, runId });
        yield* store.entry(marker, StartOutcome).set(started);
        const latest = yield* readTask(taskId);
        if (Option.isNone(latest) || latest.value.lane === "dropped") return;
        const at = yield* now;
        yield* store.entry(taskKey(taskId), FactoryTask).set({
          ...latest.value,
          lane: "doing",
          laneSetAt: at,
          updatedAt: at,
          rev: latest.value.rev + 1,
        });
      }),
    );
    return started;
  });
  const last = highest(attempts);
  let n = last === undefined ? 1 : last.n + 1;
  if (last !== undefined && last.runId === null) {
    // A start cut off before it recorded its run may have begun one under the attempt's own
    // workflow. That run is the attempt's, whatever the task's kind is now.
    const pending = (yield* runs({ workflow: last.workflow, keyPrefix: last.key })).find(
      (run) => run.key === last.key,
    );
    if (pending !== undefined && pending.endedAt === null) {
      return yield* recorded(last, pending.id);
    }
    if (pending !== undefined) {
      yield* store
        .entry(attemptKey(taskId, last.n), FactoryAttempt)
        .set({ ...last, runId: pending.id });
    } else if (last.workflow === workflowName) {
      n = last.n;
    }
  }
  const key = `task/${taskId}/a${n}`;
  const attempt: FactoryAttempt = {
    v: 1,
    taskId,
    n,
    key,
    workflow: workflowName,
    runId: null,
    requestedBy,
    startedAt: yield* now,
  };
  yield* store.entry(attemptKey(taskId, n), FactoryAttempt).set(attempt);
  const { runId } = yield* start(
    workflowRef(workflowName),
    {
      taskId,
      number: task.number,
      attempt: n,
      title: task.title,
      description: task.description,
      projectId: task.projectId,
      model: task.model,
      issueUrl: task.source._tag === "issue" ? task.source.url : null,
    },
    { key },
  );
  return yield* recorded(attempt, runId);
});

export const writeNote = Effect.fn("factoryPack.writeNote")(function* (
  taskId: string,
  text: string,
  by: string,
  at: string,
) {
  const id = `${at}-${crypto.randomUUID().slice(0, 8)}`;
  yield* store
    .entry(`${PREFIX}note/${taskId}/${id}`, FactoryNote)
    .set({ v: 1, taskId, id, text: text.slice(0, NOTE_MAX), by, at });
});

/** Appends a note with `marker` beside it; a second call that finds the marker writes nothing. */
export const addNote = Effect.fn("factoryPack.addNote")(function* (
  taskId: string,
  text: string,
  by: string,
  marker: string,
) {
  yield* store.transaction(
    Effect.gen(function* () {
      if (yield* isStored(marker)) return;
      yield* writeNote(taskId, text, by, yield* now);
      yield* store.entry(marker, TaskRef).set({ v: 1, taskId });
    }),
  );
});

/** Adds `url` to the pull requests attempt `n` of `taskId` worked on; nothing when it has no record. */
export const recordAttemptPullRequest = Effect.fn("factoryPack.recordAttemptPullRequest")(
  function* (taskId: string, n: number, url: string) {
    const key = attemptKey(taskId, n);
    yield* store.transaction(
      Effect.gen(function* () {
        const found = yield* readRecord(key, FactoryAttempt);
        if (Option.isNone(found)) return;
        const prUrls = found.value.prUrls ?? [];
        if (prUrls.includes(url)) return;
        yield* store.entry(key, FactoryAttempt).set({ ...found.value, prUrls: [...prUrls, url] });
      }),
    );
  },
);

/** The sha256 and size of the regular file at the absolute `filePath`, refused over `maxBytes`. */
export const hashFile = Effect.fn("factoryPack.hashFile")(function* (
  filePath: string,
  maxBytes: number,
) {
  if (!NodePath.isAbsolute(filePath) || filePath.length > PATH_MAX) {
    return yield* Effect.fail(
      `${filePath} is not an absolute path of at most ${PATH_MAX} characters.`,
    );
  }
  const unreadable = (cause: unknown) =>
    `${filePath} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`;
  const info = yield* Effect.tryPromise({ try: () => NodeFSP.stat(filePath), catch: unreadable });
  if (!info.isFile()) return yield* Effect.fail(`${filePath} is not a regular file.`);
  const tooLarge = `${filePath} is larger than ${maxBytes} bytes.`;
  if (info.size > maxBytes) return yield* Effect.fail(tooLarge);
  const content = yield* Effect.tryPromise({
    try: () => NodeFSP.readFile(filePath),
    catch: unreadable,
  });
  // It may have grown since the `stat`.
  if (content.byteLength > maxBytes) return yield* Effect.fail(tooLarge);
  return {
    sha256: NodeCrypto.createHash("sha256").update(content).digest("hex"),
    bytes: content.byteLength,
  };
});

/** Records `artifact` unless its key already holds one, which stays as it is. */
export const writeArtifact = Effect.fn("factoryPack.writeArtifact")(function* (
  artifact: Omit<FactoryArtifact, "v" | "at">,
) {
  const key = artifactKey(artifact.taskId, artifact.attempt, artifact.sha256);
  yield* store.transaction(
    Effect.gen(function* () {
      if (yield* isStored(key)) return;
      const at = yield* now;
      yield* store
        .entry(key, FactoryArtifact)
        .set({ v: 1, ...artifact, label: artifact.label.slice(0, LABEL_MAX), at });
    }),
  );
});

/** Records `receipt` unless its key already holds one, which stays as it is. */
export const writeReceipt = Effect.fn("factoryPack.writeReceipt")(function* (
  receipt: Omit<FactoryReceipt, "v" | "at">,
) {
  const key = receiptKey(receipt.taskId, receipt.attempt, receipt.kind, receipt.sha256);
  yield* store.transaction(
    Effect.gen(function* () {
      if (yield* isStored(key)) return;
      const at = yield* now;
      yield* store.entry(key, FactoryReceipt).set({ v: 1, ...receipt, at });
    }),
  );
});

/**
 * Where a task on `projectId` works, as the server last found it, or why it cannot. A project the
 * server has not looked at yet is a worktree of it, as it always was.
 */
export const resolveTarget = (projectId: string | null) =>
  step(
    "target",
    { returns: TargetOrProblem },
    Effect.map(
      readRecord(targetKey(projectId), FactoryTarget),
      (found): typeof TargetOrProblem.Type => {
        if (Option.isNone(found)) {
          return projectId === null
            ? { problem: NO_SCRATCH }
            : { workspace: "worktree", projectId, workspaceRoot: null };
        }
        const { problem, workspace, workspaceRoot } = found.value;
        const resolved = found.value.projectId ?? projectId;
        if (problem !== null) return { problem };
        if (resolved === null) return { problem: NO_SCRATCH };
        return { workspace, projectId: resolved, workspaceRoot };
      },
    ),
  );

const PlacementResult = Schema.Union([
  Schema.Struct({ where: Schema.Literal("local") }),
  Schema.Struct({ where: Schema.Literal("refused"), reason: Schema.String }),
  Schema.Struct({ where: Schema.Literal("remote"), ...ReadOnlyOn.fields, pool: Schema.String }),
]);

export const resolvePlacement = Effect.fnUntraced(function* (
  projectId: string | null,
  readOnlyOn: PackConfig["readOnlyOn"],
) {
  if (readOnlyOn === undefined) return { where: "local" } as const;
  const placement = yield* step(
    "placement",
    { returns: PlacementResult },
    Effect.map(readRecord(targetKey(projectId), FactoryTarget), (row) =>
      placementFor(
        readOnlyOn,
        Option.isSome(row) && row.value.problem === null ? row.value.workspace : null,
      ),
    ),
  );
  if (placement.where === "refused") return yield* stop(placement.reason);
  return placement;
});

const WritePlacementResult = Schema.Union([
  Schema.Struct({ where: Schema.Literal("local") }),
  Schema.Struct({ where: Schema.Literal("refused"), reason: Schema.String }),
  Schema.Struct({
    where: Schema.Literal("remote"),
    ...WriteOn.fields,
    pool: Schema.String,
    folder: Schema.String,
  }),
]);

export const resolveWritePlacement = Effect.fnUntraced(function* (
  projectId: string | null,
  config: PackConfig,
  model: ModelChoice | null,
) {
  const { writeOn, baseRef } = config;
  if (writeOn === undefined) return { where: "local" } as const;
  const placement = yield* step(
    "write-placement",
    { returns: WritePlacementResult },
    Effect.map(readRecord(targetKey(projectId), FactoryTarget), (row) =>
      writePlacementFor(
        writeOn,
        Option.isSome(row) && row.value.problem === null ? row.value : null,
        baseRef,
        model !== null,
      ),
    ),
  );
  if (placement.where === "refused") return yield* stop(placement.reason);
  if (placement.where === "local") return placement;
  if (baseRef === null) return yield* stop(WRITE_NEEDS_BASE);
  if (model === null) return yield* stop(WRITE_NEEDS_MODEL);
  return { ...placement, baseRef, model };
});

type RunGit = (
  command: string,
  args: string[],
  options: NodeChildProcess.ExecFileOptionsWithStringEncoding,
) => Promise<{ readonly stdout: string }>;
const execFile: RunGit = NodeUtil.promisify(NodeChildProcess.execFile);
export const readOriginHead = (folder: string, target: string, runGit = execFile) =>
  Effect.tryPromise({
    try: (signal) =>
      runGit("git", ["-C", folder, "ls-remote", "--", "origin", `refs/heads/${target}`], {
        encoding: "utf8",
        signal,
        timeout: 30_000,
        env: { ...NodeProcess.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
      }),
    catch: (cause) => ({
      _tag: "WriterBaseReadError" as const,
      message: "An error occurred in Effect.tryPromise",
      cause,
    }),
  }).pipe(Effect.map(({ stdout }) => baseFromLsRemote(stdout, target)));

export const writerBase = Effect.fnUntraced(function* (folder: string, target: string) {
  const base = yield* step("writer-base", { returns: HeadSha }, readOriginHead(folder, target));
  if (base === null) return yield* stop(baseUnread(target));
  return base;
});

export const taskTags = (
  taskId: string,
  projectId: string | null,
  stage: "planning" | "doing" | "review" | "done",
) => [`task:${taskId}`, ...(projectId === null ? [] : [`project:${projectId}`]), `stage:${stage}`];

const comparableUrl = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

// Hosts' address parsers take a pull request's route only in lowercase; the rest of its path is
// the repository's own spelling, which stays.
const PULL_REQUEST_ROUTE =
  /^(.*\/)(pulls?|pull-requests|pullrequest|merge_requests)(\/\d+(?:\/.*)?)$/iu;

/** `url` with its scheme, host and pull request route in lowercase, as a read parses it. */
const readableUrl = (url: string) => {
  const parsed = URL.parse(url.trim());
  if (parsed === null) return url.trim();
  parsed.pathname = parsed.pathname.replace(
    PULL_REQUEST_ROUTE,
    (_whole, before: string, route: string, after: string) =>
      `${before}${route.toLowerCase()}${after}`,
  );
  return parsed.href;
};

const PullRequestLookup = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("found"), url: Schema.String }),
  Schema.Struct({ outcome: Schema.Literals(["foreign", "listing-empty"]) }),
]);

/**
 * Whether `reported` is one of the project's pull requests, with its URL as the host spells it.
 * The listing can be stale and is capped, so a miss is read. A read names the project whose
 * checkout served it, but a public host is read for any repository under the asking project, so
 * its repository is the project's only when the project's own listing shows that repository.
 */
const lookUpPullRequest = Effect.fn("factoryPack.lookUpPullRequest")(function* (
  project: string,
  reported: string,
) {
  const wanted = comparableUrl(reported);
  if (wanted === "") return { outcome: "foreign" } as const;
  const listed = yield* pullRequests.list({ project, state: "all", limit: 500 });
  const found = listed.find((entry) => comparableUrl(entry.url) === wanted);
  if (found !== undefined) return { outcome: "found", url: found.url } as const;
  const read = yield* Effect.option(pullRequests.read({ project, url: readableUrl(reported) }));
  if (Option.isNone(read)) return { outcome: "foreign" } as const;
  const detail = read.value;
  if (detail.projectId !== project) return { outcome: "foreign" } as const;
  if (listed.length === 0) return { outcome: "listing-empty" } as const;
  const host = URL.parse(detail.url)?.host.toLowerCase();
  const ours =
    host !== undefined &&
    listed.some(
      (entry) =>
        entry.repository.toLowerCase() === detail.repository.toLowerCase() &&
        URL.parse(entry.url)?.host.toLowerCase() === host,
    );
  return ours
    ? ({ outcome: "found", url: detail.url } as const)
    : ({ outcome: "foreign" } as const);
});

/**
 * The project's own URL for the pull request an agent reported, or null when it is not the
 * project's. A read of this project's pull request behind an empty listing cannot show the
 * repository, so it looks once more after the listing's cache (about 30 seconds) has run out.
 */
export const projectPullRequest = Effect.fn("factoryPack.projectPullRequest")(function* (
  project: string,
  reported: string,
) {
  let lookup = yield* step(
    "pull-request",
    { returns: PullRequestLookup },
    lookUpPullRequest(project, reported),
  );
  if (lookup.outcome === "listing-empty") {
    yield* sleep("pull-request/sleep", "45 seconds");
    lookup = yield* step(
      "pull-request/again",
      { returns: PullRequestLookup },
      lookUpPullRequest(project, reported),
    );
  }
  return lookup.outcome === "found" ? lookup.url : null;
});

/**
 * Whether the merge question was answered `Merge`. With `mergeNeedsPerson` only an answer given in
 * the app counts: the server stamps its session and drops a session a sender supplies.
 */
export const mergeApproved = Effect.fn("factoryPack.mergeApproved")(function* (
  question: Omit<Parameters<typeof ask>[1], "choices">,
  mergeNeedsPerson: boolean,
) {
  const options = { ...question, choices: ["Merge", "Hold"] as const };
  const answer = yield* ask("approve-merge", options);
  if (Option.isNone(answer) || answer.value.choice !== "Merge") return false;
  if (!mergeNeedsPerson || answer.value.answeredBySession !== undefined) return true;
  const person = yield* ask("approve-merge/person", options);
  return (
    Option.isSome(person) &&
    person.value.choice === "Merge" &&
    person.value.answeredBySession !== undefined
  );
});

type PullRequestAddress = Parameters<typeof pullRequests.read>[0];

const HeadSha = Schema.NullOr(Schema.String);
const MergeOutcome = Schema.Literals(["merged", "head-changed"]);

/** The commit `pr`'s head is on now, for `mergePullRequest`; null when the host does not say. */
export const pullRequestHead = (pr: PullRequestAddress) =>
  step(
    "head-sha",
    { returns: HeadSha },
    Effect.map(pullRequests.read(pr), (detail) => detail.headSha ?? null),
  );

/**
 * Merges `pr`, or stops the run when its head has moved from `expectedHeadSha`: a push after the
 * review and the merge question would otherwise merge commits nobody looked at.
 */
export const mergePullRequest = Effect.fn("factoryPack.mergePullRequest")(function* (
  pr: PullRequestAddress,
  expectedHeadSha: string | null,
  mergeMethod: PackConfig["mergeMethod"],
) {
  const merged = yield* step(
    "merge",
    { returns: MergeOutcome },
    Effect.gen(function* () {
      const detail = yield* pullRequests.read(pr);
      if (detail.state === "merged") return "merged" as const;
      if (
        expectedHeadSha !== null &&
        detail.headSha !== undefined &&
        detail.headSha !== expectedHeadSha
      ) {
        return "head-changed" as const;
      }
      yield* pullRequests.act(pr, "merge", { mergeMethod });
      return "merged" as const;
    }),
  );
  if (merged === "head-changed") return yield* stop("pull request head changed after review");
});

const MergeAtHeadOutcome = Schema.Union([
  Schema.Literals(["requested", "already-merged", "unusable", "head-changed"]),
  Schema.Struct({ wrongBase: Schema.String }),
]);

export const mergeAtHead = Effect.fn("factoryPack.mergeAtHead")(function* (
  pr: PullRequestAddress,
  { expectedHead, target }: { readonly expectedHead: string; readonly target: string },
  mergeMethod: PackConfig["mergeMethod"],
) {
  const outcome = yield* step(
    "merge",
    { returns: MergeAtHeadOutcome },
    Effect.gen(function* () {
      yield* pullRequests.comment(pr, mergeMark(expectedHead));
      const detail = yield* pullRequests.read(pr);
      if (!isFullSha(detail.headSha ?? null)) return "unusable" as const;
      if (detail.state === "merged") return "already-merged" as const;
      if (detail.baseBranch !== target) return { wrongBase: detail.baseBranch };
      if (detail.headSha !== expectedHead) return "head-changed" as const;
      yield* pullRequests.act(pr, "merge", { mergeMethod });
      return "requested" as const;
    }),
  );
  if (typeof outcome !== "string") return yield* stop(wrongBase(outcome.wrongBase, target));
  if (outcome === "unusable") return yield* stop(headUnusable("merge"));
  if (outcome === "head-changed") return yield* stop("pull request head changed after review");
  return outcome;
});
