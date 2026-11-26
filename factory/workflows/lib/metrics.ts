import {
  FACTORY_TASK,
  TaskRef,
  capturedKey,
  isStored,
  now,
  readTask,
  writeNote,
} from "./records.ts";

export const PartStats = Schema.Struct({
  tier: Schema.NullOr(Schema.Literals(["low", "standard", "high"])),
  fixRounds: Schema.Int,
  noOpFixRounds: Schema.Int,
  continued: Schema.Boolean,
  asks: Schema.Int,
  rulings: Schema.Int,
  mergedAnyway: Schema.Boolean,
  reviewRounds: Schema.Int,
  findingsRaised: Schema.Int,
  findingsRefuted: Schema.Int,
});

export const Outcome = Schema.Struct({
  v: Schema.Literal(1),
  taskId: Schema.String,
  attempt: Schema.Int,
  runId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  taskCreatedAt: Schema.NullOr(Schema.String),
  endedAt: Schema.String,
  parts: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      outcome: Schema.Literals(["accepted", "merged", "stopped", "skipped", "cancelled"]),
      prUrl: Schema.NullOr(Schema.String),
      stats: Schema.NullOr(PartStats),
    }),
  ),
});

export const Metrics = Schema.Struct({
  v: Schema.Literal(1),
  from: Schema.String,
  to: Schema.String,
  tasks: Schema.Int,
  attempts: Schema.Int,
  leadTime: Schema.Struct({
    n: Schema.Int,
    medianMs: Schema.NullOr(Schema.Number),
    p90Ms: Schema.NullOr(Schema.Number),
  }),
  delivery: Schema.Struct({ parts: Schema.Int, clean: Schema.Int }),
  intervention: Schema.Struct({
    parts: Schema.Int,
    asks: Schema.Int,
    rulings: Schema.Int,
    mergedAnyway: Schema.Int,
  }),
  retry: Schema.Struct({
    parts: Schema.Int,
    continued: Schema.Int,
    fixed: Schema.Int,
    laterAttempts: Schema.Int,
    laterAttemptsDelivered: Schema.Int,
  }),
  review: Schema.Struct({ rounds: Schema.Int, raised: Schema.Int, refuted: Schema.Int }),
  byTier: Schema.Struct({
    low: Schema.Int,
    standard: Schema.Int,
    high: Schema.Int,
    none: Schema.Int,
  }),
});

export const finishAttempt = Effect.fn("factoryPack.finishAttempt")(function* (
  input: Pick<typeof Outcome.Type, "taskId" | "attempt" | "projectId" | "runId" | "parts"> & {
    readonly note: string;
  },
) {
  const { taskId, attempt, runId, projectId, note, parts } = input;
  const marker = capturedKey(runId, "finish");
  yield* T3.store.transaction(
    Effect.gen(function* () {
      if (yield* isStored(marker)) return;
      const task = yield* readTask(taskId);
      const endedAt = yield* now;
      yield* writeNote(taskId, note, FACTORY_TASK, endedAt);
      yield* T3.store.entry(`factory/v1/outcome/${taskId}/a${attempt}`, Outcome).set({
        v: 1,
        taskId,
        attempt,
        runId,
        projectId,
        taskCreatedAt: Option.isSome(task) ? task.value.createdAt : null,
        endedAt,
        parts,
      });
      yield* T3.store.entry(marker, TaskRef).set({ v: 1, taskId });
    }),
  );
});

export const rollup = (
  outcomes: ReadonlyArray<typeof Outcome.Type>,
  window: { readonly from: string; readonly to: string },
): typeof Metrics.Type => {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const tasks = new Set<string>();
  const firstDelivered = new Map<string, typeof Outcome.Type>();
  const delivery = { parts: 0, clean: 0 };
  const intervention = { parts: 0, asks: 0, rulings: 0, mergedAnyway: 0 };
  const retry = { parts: 0, continued: 0, fixed: 0, laterAttempts: 0, laterAttemptsDelivered: 0 };
  const review = { rounds: 0, raised: 0, refuted: 0 };
  const byTier = { low: 0, standard: 0, high: 0, none: 0 };
  let attempts = 0;
  for (const outcome of outcomes) {
    const endedAt = Date.parse(outcome.endedAt);
    if (!(from <= endedAt && endedAt < to)) continue;
    tasks.add(outcome.taskId);
    attempts++;
    let delivered = outcome.parts.length > 0;
    for (const part of outcome.parts) {
      const completed = part.outcome === "merged" || part.outcome === "accepted";
      if (!completed) delivered = false;
      if (part.outcome === "stopped") delivery.parts++;
      const { stats } = part;
      if (stats === null) continue;
      if (completed) {
        delivery.parts++;
        if (stats.rulings === 0 && !stats.mergedAnyway) delivery.clean++;
      }
      intervention.parts++;
      intervention.asks += stats.asks;
      intervention.rulings += stats.rulings;
      if (stats.mergedAnyway) intervention.mergedAnyway++;
      retry.parts++;
      if (stats.continued) retry.continued++;
      if (stats.fixRounds > 0) retry.fixed++;
      review.rounds += stats.reviewRounds;
      review.raised += stats.findingsRaised;
      review.refuted += stats.findingsRefuted;
      byTier[stats.tier ?? "none"]++;
    }
    if (outcome.attempt >= 2) {
      retry.laterAttempts++;
      if (delivered) retry.laterAttemptsDelivered++;
    }
    if (delivered) {
      const first = firstDelivered.get(outcome.taskId);
      if (first === undefined || outcome.attempt < first.attempt)
        firstDelivered.set(outcome.taskId, outcome);
    }
  }
  const times: Array<number> = [];
  for (const outcome of firstDelivered.values()) {
    if (outcome.taskCreatedAt === null) continue;
    const elapsed = Date.parse(outcome.endedAt) - Date.parse(outcome.taskCreatedAt);
    if (elapsed >= 0) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.ceil((p / 100) * times.length) - 1] ?? null;
  return {
    v: 1,
    ...window,
    tasks: tasks.size,
    attempts,
    leadTime: { n: times.length, medianMs: percentile(50), p90Ms: percentile(90) },
    delivery,
    intervention,
    retry,
    review,
    byTier,
  };
};
