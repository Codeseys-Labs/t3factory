// Every five minutes, turns the new issues of each project with intake on into Ready tasks.
import {
  INTAKE_PREFIX,
  IntakeBinding,
  StartOutcome,
  TaskRef,
  addNote,
  capturedKey,
  createTask,
  isStored,
  now,
  seenKey,
  startPool,
  startTask,
} from "./lib/records.ts";

const { workflow, step, skip, every, within, issues, store, Tick } = T3;

const Binding = Schema.Struct({
  projectId: Schema.String,
  labels: Schema.Array(Schema.String),
  autoStart: Schema.Boolean,
  authors: Schema.Array(Schema.String),
  since: Schema.String,
});

const NewIssue = Schema.Struct({
  key: Schema.String,
  displayKey: Schema.String,
  title: Schema.String,
  url: Schema.String,
  tracker: Schema.String,
  author: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

const Reason = Schema.Literals([
  "tracker-not-github",
  "no-authors",
  "no-author",
  "author-not-listed",
  "created-at-invalid",
  "before-since",
  "autostart-off",
]);
type Reason = typeof Reason.Type;

const CapturedIssue = Schema.Struct({
  taskId: Schema.String,
  number: Schema.Number,
  projectId: Schema.String,
  issueKey: Schema.String,
  start: Schema.Union([Schema.Literals(["started", "running", "dropped", "failed"]), Reason]),
});

const Failure = Schema.Struct({ projectId: Schema.String, reason: Schema.String });
const TickResult = Schema.Struct({
  captured: Schema.Array(CapturedIssue),
  failed: Schema.Array(Failure),
});
const Problem = Schema.Struct({ problem: Schema.String });
const PreviewBinding = Schema.Struct({
  ...Binding.fields,
  enabled: Schema.Boolean,
  since: Schema.NullOr(Schema.String),
});
const PreviewIssue = Schema.Struct({
  issueKey: Schema.String,
  displayKey: Schema.String,
  title: Schema.String,
  tracker: Schema.String,
  author: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  outcome: Schema.Literals(["seen", "start", "capture", "refused"]),
  reason: Schema.Union([
    Schema.Literals(["already-captured", "eligible", "ambiguous-key"]),
    Reason,
  ]),
});
const PreviewResult = Schema.Struct({
  projectId: Schema.String,
  enabled: Schema.Boolean,
  autoStart: Schema.Boolean,
  since: Schema.NullOr(Schema.String),
  evaluatedAt: Schema.String,
  issues: Schema.Array(PreviewIssue),
});

const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const utcMillis = (value: string) => (UTC_INSTANT.test(value) ? Date.parse(value) : NaN);
const IntakeSince = Schema.Struct({
  v: Schema.Literal(1),
  since: Schema.String.check(
    Schema.makeFilter((value: string) => Number.isFinite(utcMillis(value)), {
      expected: "a UTC instant",
    }),
  ),
});
const decodeStamp = Schema.decodeUnknownOption(IntakeSince);
const decodeBinding = Schema.decodeUnknownOption(IntakeBinding);
const stampKey = (projectId: string) => `factory/v1/intake-since/${projectId}`;
const bindingBad = (projectId: string) =>
  `The intake binding at ${INTAKE_PREFIX}${projectId} does not decode, so its issues were not read.`;
const readStamp = (projectId: string) =>
  Effect.map(
    store.entry(stampKey(projectId), Schema.Json).get,
    (raw): { since: string | null } | { problem: string } => {
      if (Option.isNone(raw)) return { since: null };
      const decoded = decodeStamp(raw.value);
      if (Option.isSome(decoded)) return { since: decoded.value.since };
      return {
        problem: `The intake stamp at ${stampKey(projectId)} does not decode, so its issues were not read.`,
      };
    },
  );

const bindingFields = (projectId: string, binding: typeof IntakeBinding.Type) => ({
  projectId,
  labels: binding.labels,
  autoStart: binding.autoStart,
  authors: binding.authors ?? [],
});

const readBindings = Effect.gen(function* () {
  const at = yield* now;
  const bindings: Array<typeof Binding.Type> = [];
  const refused: Array<typeof Failure.Type> = [];
  for (const row of yield* store.entries(INTAKE_PREFIX, Schema.Json)) {
    const projectId = row.key.slice(INTAKE_PREFIX.length);
    const decoded = decodeBinding(row.value);
    if (Option.isNone(decoded)) {
      refused.push({ projectId, reason: bindingBad(projectId) });
      continue;
    }
    const binding = decoded.value;
    if (!binding.enabled) continue;
    const picked: typeof Binding.Type | typeof Failure.Type | null = yield* store.transaction(
      Effect.gen(function* () {
        const stamp = yield* readStamp(projectId);
        if ("problem" in stamp) return { projectId, reason: stamp.problem };
        if (stamp.since !== null) {
          return { ...bindingFields(projectId, binding), since: stamp.since };
        }
        const raw = yield* store.entry(row.key, Schema.Json).get;
        if (Option.isNone(raw)) return null;
        const latest = decodeBinding(raw.value);
        if (Option.isNone(latest)) return { projectId, reason: bindingBad(projectId) };
        if (!latest.value.enabled) return null;
        yield* store.entry(stampKey(projectId), IntakeSince).set({ v: 1, since: at });
        return { ...bindingFields(projectId, latest.value), since: at };
      }),
    );
    if (picked === null) continue;
    if ("reason" in picked) refused.push(picked);
    else bindings.push(picked);
  }
  return { bindings, refused };
});

const startDecision = (
  binding: typeof Binding.Type,
  row: typeof NewIssue.Type,
  evaluatedAt: string,
): "eligible" | Reason => {
  if (row.tracker !== "github") return "tracker-not-github";
  if (binding.authors.length === 0) return "no-authors";
  if (row.author === null) return "no-author";
  if (!LOGIN.test(row.author)) return "author-not-listed";
  // Both sides passed LOGIN, so lower-casing folds ASCII A–Z only.
  const login = row.author.toLowerCase();
  if (!binding.authors.some((author) => author.toLowerCase() === login)) return "author-not-listed";
  const created = utcMillis(row.createdAt);
  if (!Number.isFinite(created) || created > Date.parse(evaluatedAt)) return "created-at-invalid";
  if (created <= Date.parse(binding.since)) return "before-since";
  return binding.autoStart ? "eligible" : "autostart-off";
};

const noteText = (
  reason: Exclude<Reason, "autostart-off">,
  row: typeof NewIssue.Type,
  since: string,
  evaluatedAt: string,
) => {
  const prefix = "Intake captured this issue but did not start it: ";
  switch (reason) {
    case "tracker-not-github":
      return `${prefix}it comes from ${row.tracker}, and intake starts work only for GitHub issues.`;
    case "no-authors":
      return `${prefix}this project's intake lists no authors whose issues may start work.`;
    case "no-author":
      return `${prefix}the tracker did not say who opened it.`;
    case "author-not-listed":
      return `${prefix}${row.author} is not one of this project's intake authors.`;
    case "created-at-invalid":
      return `${prefix}its creation time ${row.createdAt} is not a UTC instant at or before ${evaluatedAt}.`;
    case "before-since":
      return `${prefix}it was opened at ${row.createdAt}, not after intake began at ${since}.`;
  }
};

const listIssues = (project: string, labels: ReadonlyArray<string>) =>
  Effect.map(issues.list({ project, state: "open", labels, limit: 50 }), (listed) =>
    listed.map(({ key, displayKey, title, url, tracker, author, createdAt }) => ({
      key,
      displayKey,
      title,
      url,
      tracker,
      author: author?.login ?? null,
      createdAt,
    })),
  );

const keyCounts = (rows: ReadonlyArray<typeof NewIssue.Type>) => {
  const counts = new Map<string, number>();
  for (const { key } of rows) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

const issueTitle = (issue: typeof NewIssue.Type) =>
  (issue.title.trim() || issue.displayKey.trim()).slice(0, 200).trimEnd();

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
      const created = yield* createTask(
        {
          projectId,
          title: issueTitle(issue),
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
      version: 2,
      payload: Tick,
      returns: TickResult,
      triggers: [every("5 minutes")],
    },
    Effect.fn(function* (_tick, run) {
      const { bindings, refused } = yield* step(
        "bindings",
        {
          returns: Schema.Struct({
            bindings: Schema.Array(Binding),
            refused: Schema.Array(Failure),
          }),
        },
        readBindings,
      );
      const captured: Array<typeof CapturedIssue.Type> = [];
      const failed = [...refused];
      for (const binding of bindings) {
        const { projectId, labels, autoStart } = binding;
        const listing = yield* step.try(
          `issues/${projectId}`,
          { returns: Schema.Struct({ rows: Schema.Array(NewIssue), evaluatedAt: Schema.String }) },
          Effect.gen(function* () {
            const listed = yield* listIssues(projectId, labels);
            const counts = keyCounts(listed);
            const rows: Array<typeof NewIssue.Type> = [];
            for (const issue of listed) {
              // Even previously captured keys must be reported when they collide in this listing.
              if (counts.get(issue.key) === 1 && (yield* isStored(seenKey(projectId, issue.key)))) {
                continue;
              }
              rows.push(issue);
            }
            return { rows, evaluatedAt: yield* now };
          }),
        );
        if (listing.outcome === "failed") {
          failed.push({ projectId, reason: listing.reason });
          continue;
        }
        const { rows, evaluatedAt } = listing.value;
        const counts = keyCounts(rows);
        for (const issue of rows) {
          const n = counts.get(issue.key) ?? 0;
          if (n > 1) {
            failed.push({
              projectId,
              reason: `Issue key ${issue.key} is shared by ${n} issues in this project's listing, so ${issue.url} was neither captured nor started.`,
            });
            continue;
          }
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
          const decision = startDecision(binding, issue, evaluatedAt);
          const record = { ...task, projectId, issueKey: issue.key };
          if (decision !== "eligible") {
            if (autoStart && decision !== "autostart-off") {
              const slot = `note/${projectId}/${issue.key}`;
              const noted = yield* step.try(
                slot,
                { returns: Schema.Void },
                addNote(
                  task.taskId,
                  noteText(decision, issue, binding.since, evaluatedAt),
                  "factory-intake",
                  capturedKey(run.id, slot),
                ),
              );
              if (noted.outcome === "failed") failed.push({ projectId, reason: noted.reason });
            }
            captured.push({ ...record, start: decision });
            continue;
          }
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
          captured.push({
            ...record,
            start: started.outcome === "failed" ? "failed" : started.value.outcome,
          });
        }
      }
      if (captured.length === 0 && failed.length === 0) return yield* skip("no new issues");
      return { captured, failed };
    }),
  ),
  workflow(
    "factory-intake-preview",
    {
      version: 1,
      payload: Schema.Struct({ projectId: Schema.String }),
      returns: Schema.Union([PreviewResult, Problem]),
    },
    Effect.fn(function* ({ projectId }) {
      if (projectId === "" || projectId !== projectId.trim()) {
        return {
          problem: "A preview needs the projectId of a project, with no surrounding spaces.",
        };
      }
      const binding = yield* step(
        "preview/read",
        { returns: Schema.Union([PreviewBinding, Problem]) },
        Effect.gen(function* () {
          const key = `${INTAKE_PREFIX}${projectId}`;
          const raw = yield* store.entry(key, Schema.Json).get;
          if (Option.isNone(raw)) return { problem: `No intake binding is stored at ${key}.` };
          const decoded = decodeBinding(raw.value);
          const stamp = yield* readStamp(projectId);
          if (Option.isNone(decoded) || "problem" in stamp) {
            return {
              problem: `The intake binding at ${key} or its stamp at ${stampKey(projectId)} does not decode.`,
            };
          }
          return {
            ...bindingFields(projectId, decoded.value),
            enabled: decoded.value.enabled,
            since: stamp.since,
          };
        }),
      );
      if ("problem" in binding) return binding;
      return yield* step(
        "preview/issues",
        { returns: PreviewResult },
        Effect.gen(function* () {
          const rows = yield* listIssues(projectId, binding.labels);
          const counts = keyCounts(rows);
          const seen = new Set<string>();
          for (const key of counts.keys()) {
            if (yield* isStored(seenKey(projectId, key))) seen.add(key);
          }
          const evaluatedAt = yield* now;
          const policy = { ...binding, since: binding.since ?? evaluatedAt };
          const issues = rows.map((row): typeof PreviewIssue.Type => {
            const fields = {
              issueKey: row.key,
              displayKey: row.displayKey,
              title: issueTitle(row),
              tracker: row.tracker,
              author: row.author,
              createdAt: row.createdAt,
            };
            if ((counts.get(row.key) ?? 0) > 1) {
              return { ...fields, outcome: "refused", reason: "ambiguous-key" };
            }
            if (seen.has(row.key))
              return { ...fields, outcome: "seen", reason: "already-captured" };
            const reason = startDecision(policy, row, evaluatedAt);
            return { ...fields, outcome: reason === "eligible" ? "start" : "capture", reason };
          });
          return {
            projectId,
            enabled: binding.enabled,
            autoStart: binding.autoStart,
            since: binding.since,
            evaluatedAt,
            issues,
          };
        }),
      );
    }),
  ),
];
