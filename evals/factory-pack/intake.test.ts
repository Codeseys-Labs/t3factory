import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import type { AgentResult } from "../../apps/server/src/workflows/WorkflowAgents.ts";
import * as WorkflowForge from "../../apps/server/src/workflows/WorkflowForge.ts";
import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
const AT = "2026-01-01T00:00:00.000Z";
const PROJECT = "project-1";
const NEXT_PROJECT = "project-2";
// Fixed instants well before any clock reading, so freshness never depends on the date.
const EARLIER = "2019-06-01T00:00:00.000Z";
const SINCE = "2020-01-01T00:00:00.000Z";
const OPENED = "2020-06-01T00:00:00.000Z";
const LATER = "2999-01-01T00:00:00.000Z";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const bindingKey = (projectId: string) => `factory/v1/intake/${projectId}`;
const stampKey = (projectId: string) => `factory/v1/intake-since/${projectId}`;
const seenKey = (projectId: string, issueKey: string) =>
  `factory/v1/intake-seen/${projectId}/${issueKey}`;
const NOTE_START = "Intake captured this issue but did not start it: ";
const NOTE = {
  trackerNotGithub: (tracker: string) =>
    `${NOTE_START}it comes from ${tracker}, and intake starts work only for GitHub issues.`,
  noAuthors: `${NOTE_START}this project's intake lists no authors whose issues may start work.`,
  noAuthor: `${NOTE_START}the tracker did not say who opened it.`,
  authorNotListed: (login: string) =>
    `${NOTE_START}${login} is not one of this project's intake authors.`,
  createdAtInvalid: (createdAt: string, evaluatedAt: string) =>
    `${NOTE_START}its creation time ${createdAt} is not a UTC instant at or before ${evaluatedAt}.`,
  beforeSince: (createdAt: string, since: string) =>
    `${NOTE_START}it was opened at ${createdAt}, not after intake began at ${since}.`,
};
const bindingBad = (projectId: string) =>
  `The intake binding at factory/v1/intake/${projectId} does not decode, so its issues were not read.`;
const stampBad = (projectId: string) =>
  `The intake stamp at factory/v1/intake-since/${projectId} does not decode, so its issues were not read.`;
const ambiguous = (issueKey: string, count: number, url: string) =>
  `Issue key ${issueKey} is shared by ${count} issues in this project's listing, so ${url} was neither captured nor started.`;
const PREVIEW_PROJECT = "A preview needs the projectId of a project, with no surrounding spaces.";
const previewMissing = (projectId: string) =>
  `No intake binding is stored at factory/v1/intake/${projectId}.`;
const previewBad = (projectId: string) =>
  `The intake binding at factory/v1/intake/${projectId} or its stamp at factory/v1/intake-since/${projectId} does not decode.`;

const decodeIssue = Schema.decodeSync(WorkflowForge.Issue);
const issue = (
  key: string,
  options: {
    readonly login?: string | null;
    readonly createdAt?: string;
    readonly tracker?: string;
    readonly scope?: string;
    readonly title?: string;
    readonly projectId?: string;
  } = {},
) => {
  const scope = options.scope ?? "factory/pack";
  const login = options.login === undefined ? "octo" : options.login;
  return decodeIssue({
    projectId: options.projectId ?? PROJECT,
    projectTitle: "Factory",
    tracker: options.tracker ?? "github",
    host: "github.com",
    scope,
    key,
    displayKey: `#${key}`,
    title: options.title ?? `Issue ${key}`,
    url: `https://github.com/${scope}/issues/${key}`,
    author: login === null ? null : { login, name: null, avatarUrl: null },
    state: { name: "open", category: "open" },
    createdAt: options.createdAt ?? OPENED,
    updatedAt: OPENED,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
  });
};
const binding = (
  options: {
    readonly enabled?: boolean;
    readonly autoStart?: boolean;
    readonly labels?: ReadonlyArray<string>;
    readonly authors?: Schema.Json | undefined;
  } = {},
) => ({
  v: 1,
  enabled: options.enabled ?? true,
  labels: [...(options.labels ?? [])],
  autoStart: options.autoStart ?? true,
  ...(options.authors === undefined ? {} : { authors: options.authors }),
});

const PLAN = {
  summary: "A small plan.",
  parts: [{ title: "Do what the issue asks", brief: "Do what the issue asks." }],
};
const script = (
  rows:
    | ReadonlyArray<WorkflowForge.Issue>
    | ((query: WorkflowForge.IssueQuery) => ReadonlyArray<WorkflowForge.Issue>),
) => ({
  listIssues: (query: WorkflowForge.IssueQuery) =>
    Effect.succeed(typeof rows === "function" ? rows(query) : rows),
  agent: (turn: AgentTurnInput): Partial<AgentResult> => {
    if (turn.origin.step === "plan") return { output: PLAN };
    throw new Error(`Unexpected agent step ${turn.origin.step}`);
  },
  standing: (address: WorkflowForge.PullRequestAddress): WorkflowForge.PullRequestStanding => ({
    url: "url" in address ? address.url : "",
    state: "open",
    checks: "passing",
    mergeability: "mergeable",
  }),
});

const decodeTick = Schema.decodeUnknownSync(
  Schema.Struct({
    captured: Schema.Array(
      Schema.Struct({
        taskId: Schema.String,
        number: Schema.Number,
        projectId: Schema.String,
        issueKey: Schema.String,
        start: Schema.String,
      }),
    ),
    failed: Schema.Array(Schema.Struct({ projectId: Schema.String, reason: Schema.String })),
  }),
);
const decodePreview = Schema.decodeUnknownSync(
  Schema.Struct({
    issues: Schema.Array(
      Schema.Struct({ issueKey: Schema.String, outcome: Schema.String, reason: Schema.String }),
    ),
  }),
);
const decodeStamp = Schema.decodeUnknownSync(
  Schema.Struct({ v: Schema.Number, since: Schema.String }),
);
const decodeCreated = Schema.decodeUnknownSync(Schema.Struct({ createdAt: Schema.String }));
const decodeAttempt = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }));
// The listing is a step.try (I4), so its row holds the attempt around `{ rows, evaluatedAt }`.
const decodeListed = Schema.decodeUnknownSync(
  Schema.Struct({
    outcome: Schema.Literal("done"),
    value: Schema.Struct({ evaluatedAt: Schema.String }),
  }),
);

const tick = Effect.fn("factoryPack.intake.tick")(function* (
  world: World,
  workflows: Service,
  key: string,
) {
  const { runId } = yield* workflows.start(
    "factory-intake",
    { scheduledAt: AT },
    { idempotencyKey: key },
  );
  return yield* world.ended(workflows, runId);
});
const preview = Effect.fn("factoryPack.intake.preview")(function* (
  world: World,
  workflows: Service,
  projectId: string,
  key = "preview",
) {
  const { runId } = yield* workflows.start(
    "factory-intake-preview",
    { projectId },
    { idempotencyKey: key },
  );
  return yield* world.ended(workflows, runId);
});
const evaluatedAtOf = Effect.fn("factoryPack.intake.evaluatedAt")(function* (
  workflows: Service,
  runId: string,
  projectId: string,
) {
  const listing = (yield* workflows.get(runId)).steps.find(
    (step) => step.name === `issues/${projectId}`,
  );
  return decodeListed(listing?.result).value.evaluatedAt;
});
const notesOf = Effect.fn("factoryPack.intake.notes")(function* (
  workflows: Service,
  taskId: string,
) {
  return (yield* workflows.stored(`factory/v1/note/${taskId}/`)).map((row) => row.value);
});
const noteBy = (taskId: string, text: string) => ({
  v: 1,
  taskId,
  id: expect.any(String),
  text,
  by: "factory-intake",
  at: expect.stringMatching(ISO),
});
// The task and seen record run.test.ts:1019-1036 expects of a captured issue.
const expectCaptured = Effect.fn("factoryPack.intake.captured")(function* (
  workflows: Service,
  taskId: string,
  number: number,
  row: WorkflowForge.Issue,
) {
  const rows = yield* workflows.stored(`factory/v1/task/${taskId}`);
  expect(rows.map((entry) => entry.key)).toEqual([`factory/v1/task/${taskId}`]);
  const { createdAt } = decodeCreated(rows[0]?.value);
  expect(createdAt).toMatch(ISO);
  expect(rows[0]?.value).toEqual({
    v: 1,
    id: taskId,
    number,
    rev: 1,
    projectId: row.projectId,
    title: row.title,
    description: row.url,
    lane: "ready",
    laneSetAt: createdAt,
    parentId: null,
    blockedBy: [],
    assignee: null,
    model: null,
    source: { _tag: "issue", url: row.url, displayKey: row.displayKey },
    createdAt,
    updatedAt: createdAt,
  });
  expect(yield* workflows.stored(seenKey(row.projectId, row.key))).toEqual([
    { key: seenKey(row.projectId, row.key), value: { v: 1, taskId } },
  ]);
});
const dropPlan = Effect.fn("factoryPack.intake.dropPlan")(function* (
  world: World,
  workflows: Service,
  runId: string,
) {
  const question = yield* world.question(workflows, runId);
  expect(question.name).toBe("approve-plan");
  yield* workflows.answer(runId, "approve-plan", { choice: "Drop" });
  expect((yield* world.ended(workflows, runId)).status).toBe("stopped");
});
const onlyOf = <A>(items: ReadonlyArray<A>): A => {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) throw new Error("Expected exactly one");
  return item;
};
const previewRow = (row: WorkflowForge.Issue, outcome: string, reason: string) => ({
  issueKey: row.key,
  displayKey: row.displayKey,
  title: row.title,
  tracker: row.tracker,
  author: row.author?.login ?? null,
  createdAt: row.createdAt,
  outcome,
  reason,
});

it("T1 factory-intake is version 2 only, factory-intake-preview version 1 with no trigger, and a tick stamps beside the binding", () =>
  withWorld(script([]), (world) =>
    world.server(
      Effect.fn("factoryPack.intake.versions")(function* (workflows) {
        const intake = onlyOf(world.definitions.filter((entry) => entry.name === "factory-intake"));
        expect(intake.version).toBe(2);
        expect(
          intake.triggers.map((trigger) =>
            trigger.kind === "schedule" ? trigger.schedule : trigger.kind,
          ),
        ).toEqual([{ type: "interval", everyMs: 300000 }]);
        // oxlint-disable-next-line t3code/no-inline-schema-compile -- the schema comes from the loaded definition.
        expect(yield* Schema.decodeEffect(intake.payload)({ scheduledAt: AT })).toEqual({
          scheduledAt: AT,
        });
        const shown = onlyOf(
          world.definitions.filter((entry) => entry.name === "factory-intake-preview"),
        );
        expect(shown.version).toBe(1);
        expect(shown.triggers).toEqual([]);
        // oxlint-disable-next-line t3code/no-inline-schema-compile -- the schema comes from the loaded definition.
        expect(yield* Schema.decodeEffect(shown.payload)({ projectId: PROJECT })).toEqual({
          projectId: PROJECT,
        });
        const stored = binding({ autoStart: false, labels: ["factory"], authors: ["octo"] });
        yield* workflows.storeSet(bindingKey(PROJECT), stored);
        const before = yield* Clock.currentTimeMillis;
        const done = yield* tick(world, workflows, "tick-1");
        const after = yield* Clock.currentTimeMillis;
        expect(done).toMatchObject({ status: "skipped", detail: "no new issues" });
        expect(yield* workflows.stored(bindingKey(PROJECT))).toEqual([
          { key: bindingKey(PROJECT), value: stored },
        ]);
        const stamps = yield* workflows.stored(stampKey(PROJECT));
        expect(stamps).toEqual([
          { key: stampKey(PROJECT), value: { v: 1, since: expect.any(String) } },
        ]);
        const { since } = decodeStamp(stamps[0]?.value);
        expect(DateTime.formatIso(DateTime.makeUnsafe(since))).toBe(since);
        expect(Date.parse(since)).toBeGreaterThanOrEqual(before);
        expect(Date.parse(since)).toBeLessThanOrEqual(after);
      }),
    ),
  ));

it("T2 the stamp stays as first written through a second tick and a disable and enable, and a disabled binding gets none", () =>
  withWorld(
    script((query) => [issue("1", { projectId: query.project })]),
    (world) =>
      world.server(
        Effect.fn("factoryPack.intake.stampOnce")(function* (workflows) {
          yield* workflows.storeSet(bindingKey(PROJECT), binding({ autoStart: false }));
          yield* workflows.storeSet(bindingKey(NEXT_PROJECT), binding({ enabled: false }));
          yield* tick(world, workflows, "tick-1");
          const stamp = yield* workflows.stored(stampKey(PROJECT));
          expect(stamp).toHaveLength(1);
          yield* tick(world, workflows, "tick-2");
          expect(yield* workflows.stored(stampKey(PROJECT))).toEqual(stamp);
          yield* workflows.storeSet(
            bindingKey(PROJECT),
            binding({ autoStart: false, enabled: false }),
          );
          yield* tick(world, workflows, "tick-3");
          expect(yield* workflows.stored(stampKey(PROJECT))).toEqual(stamp);
          yield* workflows.storeSet(bindingKey(PROJECT), binding({ autoStart: false }));
          yield* tick(world, workflows, "tick-4");
          expect(yield* workflows.stored(stampKey(PROJECT))).toEqual(stamp);
          expect(yield* workflows.stored(stampKey(NEXT_PROJECT))).toEqual([]);
          expect(world.issueQueries.filter((query) => query.project === NEXT_PROJECT)).toEqual([]);
        }),
      ),
  ));

it("T2 a stamp that does not decode puts STAMP_BAD in failed and lists nothing for that project", () =>
  withWorld(
    script((query) => [issue("5", { projectId: query.project })]),
    (world) =>
      world.server(
        Effect.fn("factoryPack.intake.badStamp")(function* (workflows) {
          yield* workflows.storeSet(bindingKey(PROJECT), binding({ autoStart: false }));
          yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: 12 });
          yield* workflows.storeSet(bindingKey(NEXT_PROJECT), binding({ autoStart: false }));
          const done = yield* tick(world, workflows, "tick");
          expect(done.status).toBe("completed");
          const result = decodeTick(done.result);
          expect(result.failed).toEqual([{ projectId: PROJECT, reason: stampBad(PROJECT) }]);
          expect(result.captured.map((entry) => entry.projectId)).toEqual([NEXT_PROJECT]);
          expect(world.issueQueries.map((query) => query.project)).toEqual([NEXT_PROJECT]);
          expect(yield* workflows.stored(stampKey(PROJECT))).toEqual([
            { key: stampKey(PROJECT), value: { v: 1, since: 12 } },
          ]);
        }),
      ),
  ));

it.each([
  { label: "absent", authors: undefined },
  { label: "[]", authors: [] },
])(
  "T3 with autoStart and authors $label a fresh GitHub issue is captured, not started, and noted once",
  ({ authors }) => {
    const row = issue("21");
    return withWorld(script([row]), (world) =>
      world.server(
        Effect.fn("factoryPack.intake.noAuthors")(function* (workflows) {
          yield* workflows.storeSet(bindingKey(PROJECT), binding({ autoStart: true, authors }));
          yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: SINCE });
          const done = yield* tick(world, workflows, "tick");
          expect(done.status).toBe("completed");
          const { taskId } = onlyOf(decodeTick(done.result).captured);
          expect(done.result).toEqual({
            captured: [
              { taskId, number: 1, projectId: PROJECT, issueKey: "21", start: "no-authors" },
            ],
            failed: [],
          });
          yield* expectCaptured(workflows, taskId, 1, row);
          expect(yield* workflows.stored("factory/v1/attempt/")).toEqual([]);
          expect(yield* notesOf(workflows, taskId)).toEqual([noteBy(taskId, NOTE.noAuthors)]);
          expect(world.turns).toEqual([]);
        }),
      ),
    );
  },
);

it("T4 a listed author's fresh GitHub issue starts, its login matched without regard to ASCII case", () => {
  const row = issue("22", { login: "octo" });
  return withWorld(script([row]), (world) =>
    world.server(
      Effect.fn("factoryPack.intake.started")(function* (workflows) {
        yield* workflows.storeSet(
          bindingKey(PROJECT),
          binding({ autoStart: true, authors: ["Octo"] }),
        );
        yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: SINCE });
        const done = yield* tick(world, workflows, "tick");
        const { taskId } = onlyOf(decodeTick(done.result).captured);
        expect(done.result).toEqual({
          captured: [{ taskId, number: 1, projectId: PROJECT, issueKey: "22", start: "started" }],
          failed: [],
        });
        const attempts = yield* workflows.stored(`factory/v1/attempt/${taskId}/`);
        expect(attempts.map((entry) => entry.key)).toEqual([`factory/v1/attempt/${taskId}/0001`]);
        expect(attempts[0]?.value).toMatchObject({
          n: 1,
          key: `task/${taskId}/a1`,
          workflow: "factory-task",
          runId: expect.any(String),
        });
        const [task] = yield* workflows.stored(`factory/v1/task/${taskId}`);
        expect(task?.value).toMatchObject({ lane: "doing" });
        expect(yield* notesOf(workflows, taskId)).toEqual([]);
        yield* dropPlan(world, workflows, decodeAttempt(attempts[0]?.value).runId);
      }),
    ),
  );
});

const WITHHELD: ReadonlyArray<{
  readonly label: string;
  readonly row: WorkflowForge.Issue;
  readonly reason: string;
  readonly note: (evaluatedAt: string) => string;
}> = [
  {
    label: "tracker-not-github for a linear row by a listed login",
    row: issue("ENG-1", { tracker: "linear" }),
    reason: "tracker-not-github",
    note: () => NOTE.trackerNotGithub("linear"),
  },
  {
    label: "no-author",
    row: issue("2", { login: null }),
    reason: "no-author",
    note: () => NOTE.noAuthor,
  },
  {
    label: "author-not-listed for mallory",
    row: issue("3", { login: "mallory" }),
    reason: "author-not-listed",
    note: () => NOTE.authorNotListed("mallory"),
  },
  {
    label: "author-not-listed for dependabot[bot]",
    row: issue("4", { login: "dependabot[bot]" }),
    reason: "author-not-listed",
    note: () => NOTE.authorNotListed("dependabot[bot]"),
  },
  // U+212A KELVIN SIGN lower-cases to "k", so toLowerCase() would match the listed kit;
  // the login fails LOGIN, so it is never compared.
  {
    label: "author-not-listed for a Kelvin-sign Kit against a listed kit",
    row: issue("5", { login: "\u212Ait" }),
    reason: "author-not-listed",
    note: () => NOTE.authorNotListed("\u212Ait"),
  },
  {
    label: "created-at-invalid for a time with an offset",
    row: issue("6", { createdAt: "2026-01-01T00:00:00+01:00" }),
    reason: "created-at-invalid",
    note: (evaluatedAt) => NOTE.createdAtInvalid("2026-01-01T00:00:00+01:00", evaluatedAt),
  },
  {
    label: "created-at-invalid for soon",
    row: issue("7", { createdAt: "soon" }),
    reason: "created-at-invalid",
    note: (evaluatedAt) => NOTE.createdAtInvalid("soon", evaluatedAt),
  },
  {
    label: "created-at-invalid for a time after evaluatedAt",
    row: issue("8", { createdAt: LATER }),
    reason: "created-at-invalid",
    note: (evaluatedAt) => NOTE.createdAtInvalid(LATER, evaluatedAt),
  },
  {
    label: "before-since for a time equal to since",
    row: issue("9", { createdAt: SINCE }),
    reason: "before-since",
    note: () => NOTE.beforeSince(SINCE, SINCE),
  },
  {
    label: "before-since for a time before since",
    row: issue("10", { createdAt: EARLIER }),
    reason: "before-since",
    note: () => NOTE.beforeSince(EARLIER, SINCE),
  },
];

it.each(WITHHELD)("T5 $label is noted exactly and not started", ({ row, reason, note }) =>
  withWorld(script([row]), (world) =>
    world.server(
      Effect.fn("factoryPack.intake.withheld")(function* (workflows) {
        yield* workflows.storeSet(
          bindingKey(PROJECT),
          binding({ autoStart: true, authors: ["octo", "kit"] }),
        );
        yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: SINCE });
        const done = yield* tick(world, workflows, "tick");
        const { taskId } = onlyOf(decodeTick(done.result).captured);
        expect(done.result).toEqual({
          captured: [{ taskId, number: 1, projectId: PROJECT, issueKey: row.key, start: reason }],
          failed: [],
        });
        const evaluatedAt = yield* evaluatedAtOf(workflows, done.runId, PROJECT);
        expect(yield* notesOf(workflows, taskId)).toEqual([noteBy(taskId, note(evaluatedAt))]);
        expect(yield* workflows.stored("factory/v1/attempt/")).toEqual([]);
        expect(world.turns).toEqual([]);
      }),
    ),
  ),
);

it.each([
  {
    label: "a linear row by an unlisted author reports tracker-not-github",
    row: issue("ENG-7", { tracker: "linear", login: "mallory" }),
    autoStart: true,
    reason: "tracker-not-github",
    notes: [NOTE.trackerNotGithub("linear")],
  },
  {
    label: "an unlisted author before since reports author-not-listed",
    row: issue("8", { login: "mallory", createdAt: EARLIER }),
    autoStart: true,
    reason: "author-not-listed",
    notes: [NOTE.authorNotListed("mallory")],
  },
  {
    label: "an eligible issue under autoStart false reports autostart-off with no note",
    row: issue("9"),
    autoStart: false,
    reason: "autostart-off",
    notes: [],
  },
])("T6 the first reason that holds is the reason: $label", ({ row, autoStart, reason, notes }) =>
  withWorld(script([row]), (world) =>
    world.server(
      Effect.fn("factoryPack.intake.order")(function* (workflows) {
        yield* workflows.storeSet(bindingKey(PROJECT), binding({ autoStart, authors: ["octo"] }));
        yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: SINCE });
        const done = yield* tick(world, workflows, "tick");
        const { taskId, start } = onlyOf(decodeTick(done.result).captured);
        expect(start).toBe(reason);
        expect(yield* notesOf(workflows, taskId)).toEqual(
          notes.map((text) => noteBy(taskId, text)),
        );
        expect(yield* workflows.stored("factory/v1/attempt/")).toEqual([]);
      }),
    ),
  ),
);

it.each([
  { label: '[""]', authors: [""] },
  { label: '["@octo"]', authors: ["@octo"] },
  { label: '["octo_x"]', authors: ["octo_x"] },
  { label: "a 40-character login", authors: ["a".repeat(40)] },
  { label: '["Оcto"] with a Cyrillic О', authors: ["\u041Ecto"] },
  { label: "101 entries", authors: Array.from({ length: 101 }, (_, index) => `user${index}`) },
  { label: '"octo"', authors: "octo" },
])(
  "T7 authors $label puts BINDING_BAD in failed, and the next binding still captures",
  ({ authors }) =>
    withWorld(
      script((query) => [issue("31", { projectId: query.project })]),
      (world) =>
        world.server(
          Effect.fn("factoryPack.intake.badBinding")(function* (workflows) {
            yield* workflows.storeSet(bindingKey(PROJECT), binding({ authors }));
            yield* workflows.storeSet(bindingKey(NEXT_PROJECT), binding({ autoStart: false }));
            const done = yield* tick(world, workflows, "tick");
            expect(done.status).toBe("completed");
            const result = decodeTick(done.result);
            expect(result.failed).toEqual([{ projectId: PROJECT, reason: bindingBad(PROJECT) }]);
            expect(result.captured).toEqual([
              {
                taskId: expect.any(String),
                number: 1,
                projectId: NEXT_PROJECT,
                issueKey: "31",
                start: "no-authors",
              },
            ]);
            expect(world.issueQueries.map((query) => query.project)).toEqual([NEXT_PROJECT]);
            expect(yield* workflows.stored(stampKey(PROJECT))).toEqual([]);
            expect(yield* workflows.stored(stampKey(NEXT_PROJECT))).toHaveLength(1);
          }),
        ),
    ),
);

const A12 = issue("12", { scope: "acme/a" });
const B12 = issue("12", { scope: "acme/b" });
const C13 = issue("13", { scope: "acme/c" });

it.each([
  { label: "[a#12, b#12, c#13]", rows: [A12, B12, C13] },
  { label: "[b#12, a#12, c#13]", rows: [B12, A12, C13] },
])(
  "T8 a listing $label refuses both #12 rows in listing order, captures #13, and the preview refuses them too",
  ({ rows }) =>
    withWorld(script(rows), (world) =>
      world.server(
        Effect.fn("factoryPack.intake.ambiguous")(function* (workflows) {
          yield* workflows.storeSet(bindingKey(PROJECT), binding({ autoStart: false }));
          const done = yield* tick(world, workflows, "tick");
          expect(done.status).toBe("completed");
          const result = decodeTick(done.result);
          expect(result.failed).toEqual(
            rows
              .filter((row) => row.key === "12")
              .map((row) => ({ projectId: PROJECT, reason: ambiguous("12", 2, row.url) })),
          );
          const { taskId } = onlyOf(result.captured);
          expect(result.captured).toEqual([
            { taskId, number: 1, projectId: PROJECT, issueKey: "13", start: "no-authors" },
          ]);
          yield* expectCaptured(workflows, taskId, 1, C13);
          expect((yield* workflows.stored("factory/v1/task/")).map((row) => row.key)).toEqual([
            `factory/v1/task/${taskId}`,
          ]);
          expect(yield* workflows.stored(seenKey(PROJECT, "12"))).toEqual([]);
          const shown = yield* preview(world, workflows, PROJECT);
          expect(shown.status).toBe("completed");
          expect(
            decodePreview(shown.result).issues.map((entry) => [
              entry.issueKey,
              entry.outcome,
              entry.reason,
            ]),
          ).toEqual(
            rows.map((row) =>
              row.key === "12"
                ? ["12", "refused", "ambiguous-key"]
                : ["13", "seen", "already-captured"],
            ),
          );
        }),
      ),
    ),
);

it("T9 a second tick over the same issues captures nothing, notes nothing more, starts nothing and is skipped", () =>
  withWorld(script([issue("41"), issue("42", { login: "mallory" })]), (world) =>
    world.server(
      Effect.fn("factoryPack.intake.secondTick")(function* (workflows) {
        yield* workflows.storeSet(
          bindingKey(PROJECT),
          binding({ autoStart: true, authors: ["octo"] }),
        );
        yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: SINCE });
        const first = yield* tick(world, workflows, "tick-1");
        expect(
          decodeTick(first.result).captured.map((entry) => [entry.issueKey, entry.start]),
        ).toEqual([
          ["41", "started"],
          ["42", "author-not-listed"],
        ]);
        const tasks = yield* workflows.stored("factory/v1/task/");
        const notes = yield* workflows.stored("factory/v1/note/");
        const attempts = yield* workflows.stored("factory/v1/attempt/");
        expect([tasks.length, notes.length, attempts.length]).toEqual([2, 1, 1]);
        const second = yield* tick(world, workflows, "tick-2");
        expect(second).toMatchObject({ status: "skipped", detail: "no new issues", result: null });
        expect(yield* workflows.stored("factory/v1/task/")).toEqual(tasks);
        expect(yield* workflows.stored("factory/v1/note/")).toEqual(notes);
        expect(yield* workflows.stored("factory/v1/attempt/")).toEqual(attempts);
        expect(
          (yield* workflows.list()).filter((run) => run.workflow === "factory-task"),
        ).toHaveLength(1);
        yield* dropPlan(world, workflows, decodeAttempt(attempts[0]?.value).runId);
      }),
    ),
  ));

it("T10 a preview completes and leaves the store, the runs and the agents as they were", () =>
  withWorld(script([issue("51"), issue("52", { login: null })]), (world) =>
    world.server(
      Effect.fn("factoryPack.intake.previewWritesNothing")(function* (workflows) {
        yield* workflows.storeSet(
          bindingKey(PROJECT),
          binding({ autoStart: true, authors: ["octo"] }),
        );
        yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: SINCE });
        yield* workflows.storeSet(
          bindingKey(NEXT_PROJECT),
          binding({ autoStart: true, authors: ["octo"] }),
        );
        const before = yield* workflows.stored("factory/v1/");
        const stamped = yield* preview(world, workflows, PROJECT, "preview-stamped");
        const unstamped = yield* preview(world, workflows, NEXT_PROJECT, "preview-unstamped");
        expect([stamped.status, unstamped.status]).toEqual(["completed", "completed"]);
        // The stamped preview predicts a start, which it must not make.
        expect(decodePreview(stamped.result).issues.map((entry) => entry.outcome)).toEqual([
          "start",
          "capture",
        ]);
        expect(yield* workflows.stored("factory/v1/")).toEqual(before);
        expect(yield* workflows.stored(stampKey(NEXT_PROJECT))).toEqual([]);
        expect((yield* workflows.list()).map((run) => run.runId).toSorted()).toEqual(
          [stamped.runId, unstamped.runId].toSorted(),
        );
        expect(world.turns).toEqual([]);
        expect(world.startAttempts).toEqual([]);
      }),
    ),
  ));

it.each([
  { autoStart: true, eligible: ["start", "eligible"] },
  { autoStart: false, eligible: ["capture", "autostart-off"] },
] as const)(
  "T11 a preview with autoStart $autoStart reports every row's outcome in listing order",
  ({ autoStart, eligible }) => {
    const rows = [
      issue("61"),
      issue("62"),
      issue("63", { login: null }),
      issue("64", { login: "mallory" }),
      issue("65", { createdAt: EARLIER }),
    ] as const;
    return withWorld(script(rows), (world) =>
      world.server(
        Effect.fn("factoryPack.intake.previewRows")(function* (workflows) {
          yield* workflows.storeSet(bindingKey(PROJECT), binding({ autoStart, authors: ["octo"] }));
          yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: SINCE });
          yield* workflows.storeSet(seenKey(PROJECT, "61"), {
            v: 1,
            taskId: "c0000000-0000-4000-8000-000000000061",
          });
          const shown = yield* preview(world, workflows, PROJECT);
          expect(shown.status).toBe("completed");
          expect(shown.result).toEqual({
            projectId: PROJECT,
            enabled: true,
            autoStart,
            since: SINCE,
            evaluatedAt: expect.stringMatching(UTC_INSTANT),
            issues: [
              previewRow(rows[0], "seen", "already-captured"),
              previewRow(rows[1], eligible[0], eligible[1]),
              previewRow(rows[2], "capture", "no-author"),
              previewRow(rows[3], "capture", "author-not-listed"),
              previewRow(rows[4], "capture", "before-since"),
            ],
          });
        }),
      ),
    );
  },
);

it.each([{ enabled: true }, { enabled: false }])(
  "T12 a preview with no stamp (enabled $enabled) returns since null and predicts no start",
  ({ enabled }) => {
    const rows = [issue("71"), issue("72", { createdAt: LATER })] as const;
    return withWorld(script(rows), (world) =>
      world.server(
        Effect.fn("factoryPack.intake.previewUnstamped")(function* (workflows) {
          yield* workflows.storeSet(
            bindingKey(PROJECT),
            binding({ enabled, autoStart: true, authors: ["octo"] }),
          );
          const shown = yield* preview(world, workflows, PROJECT);
          expect(shown.status).toBe("completed");
          // With no stamp the preview assumes one made at evaluatedAt, which no listed issue is after.
          expect(shown.result).toEqual({
            projectId: PROJECT,
            enabled,
            autoStart: true,
            since: null,
            evaluatedAt: expect.stringMatching(UTC_INSTANT),
            issues: [
              previewRow(rows[0], "capture", "before-since"),
              previewRow(rows[1], "capture", "created-at-invalid"),
            ],
          });
          expect(yield* workflows.stored(stampKey(PROJECT))).toEqual([]);
        }),
      ),
    );
  },
);

it("T12 a disabled binding with a stamp is previewed as if enabled and reported with enabled false", () => {
  const row = issue("73");
  return withWorld(script([row]), (world) =>
    world.server(
      Effect.fn("factoryPack.intake.previewDisabled")(function* (workflows) {
        yield* workflows.storeSet(
          bindingKey(PROJECT),
          binding({ enabled: false, autoStart: true, authors: ["octo"] }),
        );
        yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: SINCE });
        const shown = yield* preview(world, workflows, PROJECT);
        expect(shown.result).toEqual({
          projectId: PROJECT,
          enabled: false,
          autoStart: true,
          since: SINCE,
          evaluatedAt: expect.stringMatching(UTC_INSTANT),
          issues: [previewRow(row, "start", "eligible")],
        });
      }),
    ),
  );
});

it.each([
  {
    label: "a padded projectId",
    projectId: ` ${PROJECT} `,
    seed: "binding",
    problem: PREVIEW_PROJECT,
  },
  { label: "an empty projectId", projectId: "", seed: "binding", problem: PREVIEW_PROJECT },
  {
    label: "a missing binding",
    projectId: PROJECT,
    seed: "none",
    problem: previewMissing(PROJECT),
  },
  {
    label: "a binding that does not decode",
    projectId: PROJECT,
    seed: "bad-binding",
    problem: previewBad(PROJECT),
  },
  {
    label: "a stamp that does not decode",
    projectId: PROJECT,
    seed: "bad-stamp",
    problem: previewBad(PROJECT),
  },
] as const)(
  "T13 a preview of $label returns its problem and completes",
  ({ projectId, seed, problem }) =>
    withWorld(script([issue("81")]), (world) =>
      world.server(
        Effect.fn("factoryPack.intake.previewProblem")(function* (workflows) {
          if (seed !== "none") {
            yield* workflows.storeSet(
              bindingKey(PROJECT),
              binding(seed === "bad-binding" ? { authors: ["@octo"] } : { authors: ["octo"] }),
            );
          }
          if (seed === "bad-stamp")
            yield* workflows.storeSet(stampKey(PROJECT), { v: 1, since: 12 });
          const shown = yield* preview(world, workflows, projectId);
          expect(shown.status).toBe("completed");
          expect(shown.result).toEqual({ problem });
          expect(world.issueQueries).toEqual([]);
          if (problem === PREVIEW_PROJECT) {
            expect(
              (yield* workflows.get(shown.runId)).steps.map((step) => step.name),
            ).not.toContain("preview/read");
          }
        }),
      ),
    ),
);

it("T13 a preview whose listing fails pauses with the tracker's reason, and a resume lists again", () => {
  const reason = "The tracker answered 502 Bad Gateway.";
  let failing = true;
  return withWorld(
    {
      ...script([]),
      listIssues: Effect.fn("factoryPack.intake.failingListing")(function* (
        query: WorkflowForge.IssueQuery,
      ) {
        if (failing) return yield* new WorkflowForge.WorkflowForgeError({ reason });
        return yield* Effect.succeed([issue("82", { projectId: query.project })]);
      }),
    },
    (world) =>
      world.server(
        Effect.fn("factoryPack.intake.previewPaused")(function* (workflows) {
          yield* workflows.storeSet(bindingKey(PROJECT), binding({ authors: ["octo"] }));
          const { runId } = yield* workflows.start(
            "factory-intake-preview",
            { projectId: PROJECT },
            { idempotencyKey: "preview-down" },
          );
          const paused = yield* workflows.waitFor(
            runId,
            (run) => run.status === "paused" || run.endedAt !== null,
          );
          expect(paused.status).toBe("paused");
          expect(paused.detail).toContain(reason);
          failing = false;
          yield* workflows.resume(runId);
          const done = yield* world.ended(workflows, runId);
          expect(done.status).toBe("completed");
          expect(decodePreview(done.result).issues.map((entry) => entry.issueKey)).toEqual(["82"]);
          expect(world.issueQueries).toHaveLength(2);
        }),
      ),
  );
});

it("T13 a preview makes exactly one issues.list call, equal to the tick's query", () =>
  withWorld(script([]), (world) =>
    world.server(
      Effect.fn("factoryPack.intake.previewQuery")(function* (workflows) {
        yield* workflows.storeSet(
          bindingKey(PROJECT),
          binding({ autoStart: false, labels: ["factory"], authors: ["octo"] }),
        );
        expect((yield* preview(world, workflows, PROJECT)).status).toBe("completed");
        expect(world.issueQueries).toHaveLength(1);
        yield* tick(world, workflows, "tick");
        expect(world.issueQueries).toHaveLength(2);
        const [shown, ticked] = world.issueQueries;
        expect(shown).toEqual(ticked);
        expect({ ...shown, state: shown?.state ?? "open" }).toEqual({
          project: PROJECT,
          state: "open",
          labels: ["factory"],
          limit: 50,
        });
      }),
    ),
  ));
