import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import type { rollup as rollupType } from "../../factory/workflows/lib/metrics.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Outcome = Parameters<typeof rollupType>[0][number];
type Part = Outcome["parts"][number];
type Stats = NonNullable<Part["stats"]>;
type Service = Workflows.Workflows["Service"];

const FROM = "2026-01-01T00:00:00.000Z";
const TO = "2026-02-01T00:00:00.000Z";
const window = { from: FROM, to: TO };
const stats = (fields: Partial<Stats> = {}): Stats => ({
  tier: null,
  fixRounds: 0,
  noOpFixRounds: 0,
  continued: false,
  asks: 0,
  rulings: 0,
  mergedAnyway: false,
  reviewRounds: 0,
  findingsRaised: 0,
  findingsRefuted: 0,
  ...fields,
});
const part = (outcome: Part["outcome"], value: Stats | null = stats()): Part => ({
  title: outcome,
  outcome,
  prUrl: null,
  stats: value,
});
const outcome = (taskId: string, fields: Partial<Outcome> = {}): Outcome => ({
  v: 1,
  taskId,
  attempt: 1,
  runId: `run-${taskId}`,
  projectId: null,
  taskCreatedAt: FROM,
  endedAt: "2026-01-02T00:00:00.000Z",
  parts: [part("merged")],
  ...fields,
});
const script = {
  agent: (turn: AgentTurnInput) => {
    if (turn.origin.step === "plan") {
      return { output: { summary: "Plan", parts: [{ title: "Part", brief: "Work" }] } };
    }
    if (turn.origin.step === "do") return { output: { summary: "Done", prUrl: null } };
    throw new Error(`Unexpected agent step ${turn.origin.step}`);
  },
  standing: () => {
    throw new Error("No pull request expected");
  },
};

it.effect("M3 rolls up window boundaries, every part category, attempts and tiers", () =>
  Effect.promise(() =>
    withWorld(script, (world) =>
      world.server(
        Effect.fn("factoryPack.test.metricsPure")(function* () {
          const { rollup } = yield* Effect.promise(
            () => import("../../factory/workflows/lib/metrics.ts"),
          );
          const outcomes: Outcome[] = [
            outcome("one", {
              endedAt: FROM,
              taskCreatedAt: "2025-12-31T23:59:59.000Z",
              parts: [
                part(
                  "merged",
                  stats({
                    tier: "low",
                    asks: 2,
                    reviewRounds: 1,
                    findingsRaised: 3,
                    findingsRefuted: 1,
                  }),
                ),
                part(
                  "accepted",
                  stats({
                    tier: "standard",
                    rulings: 1,
                    fixRounds: 2,
                    continued: true,
                    asks: 1,
                    reviewRounds: 2,
                    findingsRaised: 2,
                    findingsRefuted: 2,
                  }),
                ),
                part("stopped", null),
                part("merged", null),
                part(
                  "skipped",
                  stats({ tier: "high", noOpFixRounds: 2, mergedAnyway: true, asks: 3 }),
                ),
                part("cancelled", stats()),
              ],
            }),
            outcome("one", {
              attempt: 2,
              taskCreatedAt: FROM,
              endedAt: "2026-01-01T00:00:04.000Z",
            }),
            outcome("two", {
              attempt: 2,
              taskCreatedAt: FROM,
              endedAt: "2026-01-01T00:00:03.000Z",
              parts: [
                part(
                  "accepted",
                  stats({
                    tier: "high",
                    mergedAnyway: true,
                    continued: true,
                    fixRounds: 1,
                    rulings: 2,
                    asks: 4,
                    reviewRounds: 3,
                    findingsRaised: 4,
                    findingsRefuted: 1,
                  }),
                ),
              ],
            }),
            outcome("three", { parts: [part("stopped", stats({ tier: "low", asks: 5 }))] }),
            outcome("empty", { parts: [] }),
            outcome("before", { endedAt: "2025-12-31T23:59:59.999Z" }),
            outcome("after", { endedAt: TO }),
          ];
          // Five outcomes in the window, four task ids. Lead times 4000 ms and 3000 ms. Two later
          // attempts, both delivered. delivery.parts = 4 merged or accepted + 2 stopped = 6; clean 2.
          // Counted parts 4+1+1+1 = 7; asks 2+1+3+4+5 = 15; rulings 1+2 = 3; mergedAnyway, continued,
          // fixed 2 each; review rounds 6, raised 9, refuted 4; tiers low 2, standard 1, high 2, none 2.
          expect(rollup(outcomes, window)).toEqual({
            v: 1,
            ...window,
            tasks: 4,
            attempts: 5,
            leadTime: { n: 2, medianMs: 3000, p90Ms: 4000 },
            delivery: { parts: 6, clean: 2 },
            intervention: { parts: 7, asks: 15, rulings: 3, mergedAnyway: 2 },
            retry: {
              parts: 7,
              continued: 2,
              fixed: 2,
              laterAttempts: 2,
              laterAttemptsDelivered: 2,
            },
            review: { rounds: 6, raised: 9, refuted: 4 },
            byTier: { low: 2, standard: 1, high: 2, none: 2 },
          });
        }),
      ),
    ),
  ),
);

it.effect("M3 nearest-rank percentiles and delivered attempt selection", () =>
  Effect.promise(() =>
    withWorld(script, (world) =>
      world.server(
        Effect.fn("factoryPack.test.percentiles")(function* () {
          const { rollup } = yield* Effect.promise(
            () => import("../../factory/workflows/lib/metrics.ts"),
          );
          // Sorted values 1..n seconds: ceil(.5*n), ceil(.9*n) are ranks 0/0,
          // 1/1, 1/2, 3/5, and 5/9 for n = 0, 1, 2, 5, 10 respectively.
          const cases = [
            { n: 0, medianMs: null, p90Ms: null },
            { n: 1, medianMs: 1000, p90Ms: 1000 },
            { n: 2, medianMs: 1000, p90Ms: 2000 },
            { n: 5, medianMs: 3000, p90Ms: 5000 },
            { n: 10, medianMs: 5000, p90Ms: 9000 },
          ];
          for (const row of cases) {
            const values = Array.from({ length: row.n }, (_, index) =>
              outcome(`t${index}`, {
                taskCreatedAt: FROM,
                endedAt: `2026-01-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
              }),
            ).reverse();
            expect(rollup(values, window).leadTime).toEqual(row);
          }
          const values = [
            outcome("first", { attempt: 4, endedAt: "2026-01-01T00:00:08.000Z" }),
            outcome("first", { attempt: 2, endedAt: "2026-01-01T00:00:02.000Z" }),
            outcome("first", { attempt: 1, parts: [part("stopped")] }),
            outcome("null", { taskCreatedAt: null }),
            outcome("negative", { taskCreatedAt: "2026-01-03T00:00:00.000Z" }),
            outcome("nan", { taskCreatedAt: "not a date" }),
            outcome("no-parts", { parts: [] }),
            outcome("mixed", { parts: [part("merged"), part("cancelled")] }),
          ];
          // Only attempt 2 for 'first' is eligible: 2000 ms; later attempt 4 is ignored.
          expect(rollup(values, window).leadTime).toEqual({ n: 1, medianMs: 2000, p90Ms: 2000 });
          // Attempts 2 and 4 are later and delivered, despite reversed input order.
          expect(rollup(values, window).retry).toMatchObject({
            laterAttempts: 2,
            laterAttemptsDelivered: 2,
          });
          // The lowest delivered attempt is selected before invalid lead times are omitted.
          expect(
            rollup(
              [
                outcome("invalid-first", { attempt: 1, taskCreatedAt: null }),
                outcome("invalid-first", { attempt: 2, taskCreatedAt: FROM }),
              ],
              window,
            ).leadTime,
          ).toEqual({ n: 0, medianMs: null, p90Ms: null });
        }),
      ),
    ),
  ),
);

const taskId = "80000000-0000-4000-8000-000000000001";
const task = {
  v: 1,
  id: taskId,
  number: 1,
  rev: 1,
  projectId: "project-1",
  title: "Task",
  description: "",
  lane: "ready",
  laneSetAt: FROM,
  parentId: null,
  blockedBy: [],
  assignee: null,
  model: null,
  source: { _tag: "local" },
  createdAt: FROM,
  updatedAt: FROM,
};
const startTask = (workflows: Service, attempt: number) =>
  workflows.start(
    "factory-task",
    {
      taskId,
      number: 1,
      attempt,
      title: "Task",
      description: "",
      projectId: "project-1",
      model: null,
      issueUrl: null,
    },
    { idempotencyKey: `metrics-task-${attempt}` },
  );
const finishTask = Effect.fn("factoryPack.test.finishMetricsTask")(function* (
  world: World,
  workflows: Service,
  attempt: number,
) {
  const { runId } = yield* startTask(workflows, attempt);
  const child = yield* world.child(workflows, runId, 0);
  const question = yield* world.question(workflows, child.runId);
  expect(question.name).toBe("accept");
  yield* workflows.answer(child.runId, question.name, { choice: "Accept" });
  return runId;
});

it.effect(
  "M2 finish commits note, outcome and marker once, and takes createdAt from the task",
  () =>
    Effect.promise(() =>
      withWorld({ ...script, failFinishAfterCommit: true }, (world) =>
        world.server(
          Effect.fn("factoryPack.test.outcomeReplay")(function* (workflows) {
            yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false });
            yield* workflows.storeSet(`factory/v1/task/${taskId}`, task);
            const runId = yield* finishTask(world, workflows, 1);
            const paused = yield* workflows.waitFor(
              runId,
              (run) => run.status === "paused" || run.endedAt !== null,
            );
            expect(paused.status).toBe("paused");
            expect(paused.detail).toContain("Injected failure after finish committed");
            const notes = yield* workflows.stored(`factory/v1/note/${taskId}/`);
            const outcomes = yield* workflows.stored(`factory/v1/outcome/${taskId}/`);
            const markers = yield* workflows.stored(`factory/v1/captured/${runId}/finish`);
            expect(notes).toHaveLength(1);
            expect(notes[0]?.value).toMatchObject({
              v: 1,
              taskId,
              text: expect.stringContaining("accepted"),
            });
            expect(outcomes).toEqual([
              {
                key: `factory/v1/outcome/${taskId}/a1`,
                value: expect.objectContaining({
                  v: 1,
                  taskId,
                  attempt: 1,
                  runId,
                  projectId: "project-1",
                  taskCreatedAt: FROM,
                  endedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
                  parts: [
                    {
                      title: "Part",
                      outcome: "accepted",
                      prUrl: null,
                      stats: {
                        tier: null,
                        fixRounds: 0,
                        noOpFixRounds: 0,
                        continued: false,
                        asks: 1,
                        rulings: 0,
                        mergedAnyway: false,
                        reviewRounds: 0,
                        findingsRaised: 0,
                        findingsRefuted: 0,
                      },
                    },
                  ],
                }),
              },
            ]);
            expect(markers).toEqual([
              { key: `factory/v1/captured/${runId}/finish`, value: { v: 1, taskId } },
            ]);
            expect(world.finishExecutions).toEqual([runId]);
            yield* workflows.resume(runId);
            expect((yield* world.ended(workflows, runId)).status).toBe("completed");
            expect(world.finishExecutions).toEqual([runId, runId]);
            expect(yield* workflows.stored(`factory/v1/note/${taskId}/`)).toEqual(notes);
            expect(yield* workflows.stored(`factory/v1/outcome/${taskId}/`)).toEqual(outcomes);
            expect(yield* workflows.stored(`factory/v1/captured/${runId}/finish`)).toEqual(markers);
          }),
        ),
      ),
    ),
);

it.effect("M2 an undecodable task produces a null taskCreatedAt", () =>
  Effect.promise(() =>
    withWorld(script, (world) =>
      world.server(
        Effect.fn("factoryPack.test.damagedOutcomeTask")(function* (workflows) {
          yield* workflows.storeSet("factory/v1/config", { v: 1, askPlan: false });
          yield* workflows.storeSet(`factory/v1/task/${taskId}`, { v: 1, createdAt: FROM });
          const runId = yield* finishTask(world, workflows, 1);
          expect((yield* world.ended(workflows, runId)).status).toBe("completed");
          expect(yield* workflows.stored(`factory/v1/outcome/${taskId}/a1`)).toEqual([
            {
              key: `factory/v1/outcome/${taskId}/a1`,
              value: expect.objectContaining({ taskCreatedAt: null }),
            },
          ]);
          yield* workflows.storeDelete(`factory/v1/task/${taskId}`);
        }),
      ),
    ),
  ),
);

const tick = Effect.fn("factoryPack.test.metricsTick")(function* (
  world: World,
  workflows: Service,
  scheduledAt: string,
  key: string,
) {
  const { runId } = yield* workflows.start(
    "factory-metrics",
    { scheduledAt },
    { idempotencyKey: key },
  );
  return yield* world.ended(workflows, runId, true);
});

it.effect(
  "M4 rolls up the preceding 30 days, skips damaged rows and replaces the daily record",
  () =>
    Effect.promise(() =>
      withWorld(script, (world) =>
        world.server(
          Effect.fn("factoryPack.test.metricsTickRollup")(function* (workflows) {
            const to = "2026-02-01T05:00:00.000Z";
            const from = "2026-01-02T05:00:00.000Z";
            yield* workflows.storeSet(
              "factory/v1/outcome/a",
              outcome("a", { taskCreatedAt: from, endedAt: from }),
            );
            yield* workflows.storeSet(
              "factory/v1/outcome/b",
              outcome("b", { taskCreatedAt: from, endedAt: to }),
            );
            yield* workflows.storeSet("factory/v1/outcome/damaged", { v: 1, taskId: "broken" });
            const first = yield* tick(world, workflows, to, "metrics-first");
            expect(first.status).toBe("completed");
            // One outcome at the inclusive start, 0 ms lead; the one at the end is excluded.
            expect(first.result).toMatchObject({
              from,
              to,
              tasks: 1,
              attempts: 1,
              leadTime: { n: 1, medianMs: 0, p90Ms: 0 },
            });
            const key = "factory/v1/metrics/2026-02-01";
            expect(yield* workflows.stored(key)).toEqual([{ key, value: first.result }]);
            yield* workflows.storeSet(
              "factory/v1/outcome/c",
              outcome("c", { taskCreatedAt: from, endedAt: from }),
            );
            const second = yield* tick(
              world,
              workflows,
              "2026-02-01T06:00:00.000Z",
              "metrics-second",
            );
            expect(second.status).toBe("completed");
            // At 06:00 the two records at 05:00 on the start day are out; b is now in.
            expect(second.result).toMatchObject({
              from: "2026-01-02T06:00:00.000Z",
              to: "2026-02-01T06:00:00.000Z",
              tasks: 1,
              attempts: 1,
            });
            expect(yield* workflows.stored(key)).toEqual([{ key, value: second.result }]);
            // The harness checks every stored record at the end; the planted damage is done with.
            yield* workflows.storeDelete("factory/v1/outcome/damaged");
          }),
        ),
      ),
    ),
);

it.effect(
  "M4 skips with no outcomes and writes nothing, including when all records are damaged",
  () =>
    Effect.promise(() =>
      withWorld(script, (world) =>
        world.server(
          Effect.fn("factoryPack.test.emptyMetrics")(function* (workflows) {
            const first = yield* tick(world, workflows, "2026-02-01T05:00:00.000Z", "empty-first");
            expect(first).toMatchObject({ status: "skipped", detail: "no outcomes" });
            expect(yield* workflows.stored("factory/v1/metrics/")).toEqual([]);
            yield* workflows.storeSet("factory/v1/outcome/damaged", { v: 1 });
            const second = yield* tick(
              world,
              workflows,
              "2026-02-01T05:00:00.000Z",
              "empty-second",
            );
            expect(second).toMatchObject({ status: "skipped", detail: "no outcomes" });
            expect(yield* workflows.stored("factory/v1/metrics/")).toEqual([]);
            yield* workflows.storeSet(
              "factory/v1/outcome/outside",
              outcome("outside", {
                endedAt: "2025-01-01T00:00:00.000Z",
              }),
            );
            const outside = yield* tick(
              world,
              workflows,
              "2026-02-01T05:00:00.000Z",
              "empty-window",
            );
            expect(outside.status).toBe("completed");
            // A decodable outcome outside the window still writes a roll-up of zero attempts.
            expect(outside.result).toMatchObject({
              tasks: 0,
              attempts: 0,
              leadTime: { n: 0, medianMs: null, p90Ms: null },
            });
            expect(yield* workflows.stored("factory/v1/metrics/2026-02-01")).toEqual([
              { key: "factory/v1/metrics/2026-02-01", value: outside.result },
            ]);
            yield* workflows.storeDelete("factory/v1/outcome/damaged");
          }),
        ),
      ),
    ),
);
