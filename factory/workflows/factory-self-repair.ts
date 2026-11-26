// Daily, turns Factory runs that keep ending or pausing for the same reason into one Backlog repair
// task per reason. It never starts the task: a person decides whether the repair is worth a run.
import * as NodeCrypto from "node:crypto";
import { TaskRef, capturedKey, createTask, isStored } from "./lib/records.ts";

const { workflow, step, skip, daily, runs, store, Tick } = T3;

const FACTORY_WORKFLOWS: ReadonlyArray<string> = [
  "factory-task",
  "factory-task-part",
  "factory-intake",
  "factory-sync-upstream",
  "factory-brief",
  "factory-experiment",
];

// A person's choice, not a fault, so a run that ended on one is no failure.
const PERSON_STOPS: ReadonlyArray<string> = [
  "plan not approved",
  "merge held",
  "not accepted",
  "brief not accepted",
  "protocol not approved",
  "review did not pass",
];

const RECENT_MILLIS = 7 * 24 * 60 * 60 * 1000;
const MIN_OCCURRENCES = 2;
const SAMPLE_RUNS = 5;
const SAMPLE_DETAIL = 1000;
const FINGERPRINT_DETAIL = 500;
const PROJECT_TAG = "project:";
// The wire bounds of a task's title and description (packages/contracts).
const TITLE_MAX = 200;
const DESCRIPTION_MAX = 8000;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const HASH = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}\b/g;
// A number, except an HTTP or exit status, which tells two faults apart: `403` is not `503`.
const VOLATILE_NUMBER =
  /\b((?:http(?:\/[\d.]+)?|status(?: code)?|code)\s*[:=]?\s*)([1-5]\d{2})\b|(?<![\w.])([1-5]\d{2})(?=\s+(?:bad request|unauthorized|forbidden|not found|conflict|too many requests|internal server error|bad gateway|service unavailable|gateway timeout)\b)|\d+/g;
const WHITESPACE = /\s+/g;
const RUN_STATUSES = ["paused", "stopped"] as const;

const Cluster = Schema.Struct({
  fingerprint: Schema.String,
  workflow: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  count: Schema.Number,
  detail: Schema.String,
  runIds: Schema.Array(Schema.String),
});

const CreatedTask = Schema.Struct({ taskId: Schema.String, number: Schema.Number });

const Captured = Schema.Struct({
  taskId: Schema.String,
  number: Schema.Number,
  fingerprint: Schema.String,
  count: Schema.Number,
});

const Failure = Schema.Struct({ fingerprint: Schema.String, reason: Schema.String });

const repairSeenKey = (fingerprint: string) => `factory/v1/repair-seen/${fingerprint}`;

/** `detail` without what differs between two runs of one fault: ids, commits and counts. */
const normalizeDetail = (detail: string) =>
  detail
    .toLowerCase()
    .replace(UUID, "<id>")
    .replace(HASH, "<hash>")
    .replace(VOLATILE_NUMBER, (_match, prefix?: string, status?: string, phrased?: string) =>
      status === undefined ? (phrased ?? "<n>") : `${prefix ?? ""}${status}`,
    )
    .replace(WHITESPACE, " ")
    .trim()
    .slice(0, FINGERPRINT_DETAIL);

const clusterFingerprint = (workflowName: string, projectId: string | null, detail: string) =>
  NodeCrypto.createHash("sha256")
    .update(`${workflowName}\0${projectId ?? ""}\0${normalizeDetail(detail)}`)
    .digest("hex")
    .slice(0, 16);

/**
 * The faults that at least twice ended or paused a Factory run for the same reason, with no repair
 * task yet, most frequent first. Paused runs count whenever they paused; stopped ones when they
 * ended in the last 7 days.
 */
const scan = Effect.fn("factorySelfRepair.scan")(function* () {
  const cutoff = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) - RECENT_MILLIS;
  const groups = new Map<
    string,
    {
      workflow: string;
      projectId: string | null;
      detail: string;
      count: number;
      runIds: Array<string>;
    }
  >();
  const listings = yield* Effect.forEach(
    FACTORY_WORKFLOWS.flatMap((name) => RUN_STATUSES.map((status) => ({ workflow: name, status }))),
    (filter) => runs(filter),
  );
  const counted = new Set<string>();
  for (const run of listings.flat()) {
    if (counted.has(run.id)) continue;
    counted.add(run.id);
    const detail = run.detail?.trim() ?? "";
    if (detail === "" || PERSON_STOPS.includes(detail.toLowerCase())) continue;
    if (run.status === "stopped" && Date.parse(run.endedAt ?? run.startedAt) < cutoff) continue;
    const projectTag = run.tags.find((tag) => tag.startsWith(PROJECT_TAG));
    const projectId = projectTag?.slice(PROJECT_TAG.length).trim() || null;
    const fingerprint = clusterFingerprint(run.workflow, projectId, detail);
    const group = groups.get(fingerprint);
    if (group === undefined) {
      groups.set(fingerprint, {
        workflow: run.workflow,
        projectId,
        detail: detail.slice(0, SAMPLE_DETAIL),
        count: 1,
        runIds: [run.id],
      });
      continue;
    }
    group.count += 1;
    if (group.runIds.length < SAMPLE_RUNS) group.runIds.push(run.id);
  }
  const clusters: Array<typeof Cluster.Type> = [];
  for (const [fingerprint, group] of groups) {
    if (group.count < MIN_OCCURRENCES) continue;
    if (yield* isStored(repairSeenKey(fingerprint))) continue;
    clusters.push({ fingerprint, ...group });
  }
  return clusters.toSorted((left, right) => right.count - left.count);
});

const taskFields = (cluster: typeof Cluster.Type) => {
  const reason = cluster.detail.replace(WHITESPACE, " ");
  const where = cluster.projectId === null ? "" : ` on project ${cluster.projectId}`;
  const more = cluster.count - cluster.runIds.length;
  return {
    projectId: cluster.projectId,
    title: `Repair ${cluster.workflow}: ${reason}`.slice(0, TITLE_MAX).trim(),
    description: [
      `${cluster.workflow} ended or paused for the same reason in ${cluster.count} runs${where}.`,
      `Reason: ${cluster.detail}`,
      `Runs: ${cluster.runIds.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
      "`t3 workflow show <run>` names the step that failed.",
    ]
      .join("\n\n")
      .slice(0, DESCRIPTION_MAX),
    lane: "backlog",
    parentId: null,
    blockedBy: [],
    assignee: null,
    model: null,
    source: { _tag: "local" },
  } as const;
};

/**
 * The repair task for `cluster` and its seen record, written together; null when another run
 * captured it first. This run's marker comes first, so a step that runs again gives back the task
 * it wrote.
 */
const captureRepair = Effect.fn("factorySelfRepair.captureRepair")(function* (
  runId: string,
  cluster: typeof Cluster.Type,
) {
  const seen = repairSeenKey(cluster.fingerprint);
  const marker = capturedKey(runId, cluster.fingerprint);
  return yield* store.transaction(
    Effect.gen(function* () {
      if (!(yield* isStored(marker)) && (yield* isStored(seen))) return null;
      const created = yield* createTask(taskFields(cluster), marker);
      if ("problem" in created) return yield* Effect.fail(created.problem);
      yield* store.entry(seen, TaskRef).set({ v: 1, taskId: created.task.id });
      return { taskId: created.task.id, number: created.task.number };
    }),
  );
});

export default workflow(
  "factory-self-repair",
  {
    version: 1,
    payload: Tick,
    returns: Schema.Struct({
      captured: Schema.Array(Captured),
      failed: Schema.Array(Failure),
    }),
    triggers: [daily("04:00")],
  },
  Effect.fn(function* (_tick, run) {
    const clusters = yield* step("scan", { returns: Schema.Array(Cluster) }, scan());
    if (clusters.length === 0) return yield* skip("no recurring failures");
    const captured: Array<typeof Captured.Type> = [];
    const failed: Array<typeof Failure.Type> = [];
    for (const cluster of clusters) {
      const capture = yield* step.try(
        `capture/${cluster.fingerprint}`,
        { returns: Schema.NullOr(CreatedTask) },
        captureRepair(run.id, cluster),
      );
      if (capture.outcome === "failed") {
        failed.push({ fingerprint: cluster.fingerprint, reason: capture.reason });
        continue;
      }
      if (capture.value === null) continue;
      captured.push({ ...capture.value, fingerprint: cluster.fingerprint, count: cluster.count });
    }
    return { captured, failed };
  }),
);
