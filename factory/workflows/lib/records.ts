// @effect-diagnostics globalDateInEffect:off
// The records the pack shares with the server's FactoryTasks service, and the store work both
// workflow files do with them. Everything here that touches the store is for inside a `step`.
const { runs, start, store } = T3;

const PREFIX = "factory/v1/";
const SEQ_KEY = `${PREFIX}seq`;
const TASK_PREFIX = `${PREFIX}task/`;
export const INTAKE_PREFIX = `${PREFIX}intake/`;
export const FACTORY_TASK = "factory-task";
export const NO_PROJECT = "a task needs a project to run";

// The wire schemas' bounds and patterns (packages/contracts), which a workflow file cannot import.
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 8000;
const BLOCKED_BY_MAX = 50;
const ASSIGNEE_MAX = 100;
const NOTE_MAX = 4000;
const INSTANCE_ID_MAX = 64;
const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonBlank = Schema.String.check(
  Schema.makeFilter((text: string) => text.trim().length > 0, { expected: "a non-blank string" }),
);

export const TaskLane = Schema.Literals(["backlog", "ready", "doing", "review", "done", "dropped"]);

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
});

/** What an intake-seen record and a capture marker hold: the task they name. */
export const TaskRef = Schema.Struct({ v: Schema.Literal(1), taskId: Schema.String });

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

/** What `start` takes to start `factory-task`. */
export type TaskWorkflow = Parameters<typeof start<FactoryTaskRunInput>>[0];

type DurationInput = Parameters<typeof Duration.fromInput>[0];
const DurationText = Schema.String.pipe(
  Schema.refine(
    (text): text is Extract<DurationInput, string> =>
      Option.isSome(Duration.fromInput(text as DurationInput)),
    { expected: 'a duration such as "45 minutes"' },
  ),
);

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
};

export const PackConfig = Schema.Struct({ v: Schema.Literal(1), ...configFields });
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
  stepTimeout: "45 minutes",
  checksTimeout: "1 hour",
  fixRounds: 2,
  mergeMethod: "squash",
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

const taskKey = (taskId: string) => `${TASK_PREFIX}${taskId}`;
const attemptPrefix = (taskId: string) => `${PREFIX}attempt/${taskId}/`;
const attemptKey = (taskId: string, n: number) =>
  `${attemptPrefix(taskId)}${String(n).padStart(4, "0")}`;
export const seenKey = (projectId: string, issueKey: string) =>
  `${PREFIX}intake-seen/${projectId}/${issueKey}`;
export const capturedKey = (runId: string, slot: string) => `${PREFIX}captured/${runId}/${slot}`;

const now = Effect.clockWith((clock) =>
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

const readTask = (taskId: string) => readRecord(taskKey(taskId), FactoryTask);

const decodeStoredConfig = Schema.decodeUnknownEffect(StoredConfig);

/** A config row's fields; a row that is there and does not decode fails, naming its key. */
const readConfigRow = Effect.fn("factoryPack.readConfigRow")(function* (key: string) {
  const found = yield* store.entry(key, Schema.Json).get;
  if (Option.isNone(found)) return undefined;
  return yield* decodeStoredConfig(found.value).pipe(
    Effect.mapError((error) => `The Factory config at ${key} is not valid: ${error.message}`),
  );
});

/** The global config with the project's fields over it, over the defaults. */
export const readConfig = Effect.fn("factoryPack.readConfig")(function* (projectId: string | null) {
  const global = yield* readConfigRow(`${PREFIX}config`);
  const project =
    projectId === null ? undefined : yield* readConfigRow(`${PREFIX}config/${projectId}`);
  const config: PackConfig = { ...DEFAULT_CONFIG, ...global, ...project, v: 1 };
  return config;
});

type NewTask = Omit<
  FactoryTask,
  "v" | "id" | "number" | "rev" | "laneSetAt" | "createdAt" | "updatedAt"
>;

/** `fields` as the service would store them, or why the service would answer `invalid`. */
const checkedTask = (
  fields: NewTask,
): { readonly task: NewTask } | { readonly problem: string } => {
  const title = fields.title.trim();
  const projectId = fields.projectId === null ? null : fields.projectId.trim();
  const blockedBy = [...new Set(fields.blockedBy)];
  const model = fields.model === null ? null : wireModel(fields.model);
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
  return { task: { ...fields, projectId, title, blockedBy, model } };
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
  fields: NewTask,
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
      for (const id of [...(task.parentId === null ? [] : [task.parentId]), ...task.blockedBy]) {
        if (!(yield* isStored(taskKey(id)))) return { problem: `There is no task ${id}.` };
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
 * Starts a task as the service's `start` does. The newest attempt that has a run decides whether
 * one is live; otherwise an attempt without a run above it is reused, or the next is written
 * before its run starts, and then gets the run while the task moves to `doing`. Run it inside
 * `within(startPool(taskId), { limit: 1 }, …)` so that two starts of a task do not cross.
 */
export const startTask = Effect.fn("factoryPack.startTask")(function* (
  definition: TaskWorkflow,
  taskId: string,
  requestedBy: string,
) {
  const found = yield* readTask(taskId);
  if (Option.isNone(found)) return yield* Effect.fail(`There is no task ${taskId}.`);
  const task = found.value;
  if (task.lane === "dropped") return { outcome: "dropped" } as const;
  const attempts = (yield* readAll(attemptPrefix(taskId), FactoryAttempt)).map((row) => row.value);
  const ran = highest(attempts.filter((attempt) => attempt.runId !== null));
  if (ran !== undefined && ran.runId !== null) {
    const ranId = ran.runId;
    const listed = yield* runs({ workflow: FACTORY_TASK, keyPrefix: `task/${taskId}/` });
    if (listed.some((run) => run.id === ranId && run.endedAt === null)) {
      return { outcome: "running", runId: ranId } as const;
    }
  }
  const last = highest(attempts);
  const n = last === undefined ? 1 : last.runId === null ? last.n : last.n + 1;
  const key = `task/${taskId}/a${n}`;
  const entry = store.entry(attemptKey(taskId, n), FactoryAttempt);
  const attempt: FactoryAttempt = {
    v: 1,
    taskId,
    n,
    key,
    workflow: FACTORY_TASK,
    runId: null,
    requestedBy,
    startedAt: yield* now,
  };
  yield* entry.set(attempt);
  const { runId } = yield* start(
    definition,
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
  yield* store.transaction(
    Effect.gen(function* () {
      yield* entry.set({ ...attempt, runId });
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
  return { outcome: "started", attempt: n, runId } as const;
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
      const at = yield* now;
      const id = `${at}-${crypto.randomUUID().slice(0, 8)}`;
      yield* store
        .entry(`${PREFIX}note/${taskId}/${id}`, FactoryNote)
        .set({ v: 1, taskId, id, text: text.slice(0, NOTE_MAX), by, at });
      yield* store.entry(marker, TaskRef).set({ v: 1, taskId });
    }),
  );
});

export const taskTags = (
  taskId: string,
  projectId: string | null,
  stage: "planning" | "doing" | "review" | "done",
) => [`task:${taskId}`, ...(projectId === null ? [] : [`project:${projectId}`]), `stage:${stage}`];
