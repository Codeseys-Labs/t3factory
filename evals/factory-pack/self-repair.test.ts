import { it } from "@effect/vitest";
import { FactoryTask } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import type * as Workflows from "../../apps/server/src/workflows/Workflows.ts";
import { type AgentTurnInput, type World, withWorld } from "./world.ts";

type Service = Workflows.Workflows["Service"];
const TASK_ID = "80000000-0000-4000-8000-000000000001";
const PROBLEMS = [
  "Scratch workspace unavailable for 8cd756eb-897a-4c6f-8ca5-590135de57c6 at a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2 on device 31",
  "Scratch workspace unavailable for c084790e-c076-4edf-a2bf-44cbaa34f518 at f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5 on device 47",
] as const;
const skipped = { status: "skipped", detail: "no recurring failures" };
const script = {
  agent: (turn: AgentTurnInput) => {
    if (turn.origin.step !== "plan") throw new Error(`Unexpected agent step: ${turn.origin.step}`);
    return {
      output: { summary: "Fix the build", parts: [{ title: "Build", brief: "Run build" }] },
    };
  },
  standing: () => {
    throw new Error("No pull request should be read");
  },
};
const decodeTask = Schema.decodeUnknownEffect(FactoryTask);
const decodeCaptured = Schema.decodeUnknownEffect(
  Schema.Struct({
    captured: Schema.Tuple([
      Schema.Struct({
        taskId: Schema.String,
        number: Schema.Number,
        fingerprint: Schema.String,
        count: Schema.Number,
      }),
    ]),
    failed: Schema.Tuple([]),
  }),
);

const stopTask = Effect.fn("factoryPack.test.stopRepairSource")(function* (
  world: World,
  workflows: Service,
  attempt: number,
  problem: string | null,
) {
  if (problem !== null) {
    yield* workflows.storeSet("factory/v1/target/scratch", {
      v: 1,
      projectId: null,
      workspace: "scratch",
      workspaceRoot: null,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      problem,
    });
  }
  const { runId } = yield* workflows.start(
    "factory-task",
    {
      taskId: TASK_ID,
      number: 1,
      attempt,
      title: "Fix the build",
      description: "",
      projectId: problem === null ? "project-1" : null,
      model: null,
      issueUrl: null,
    },
    { idempotencyKey: `task/${TASK_ID}/a${attempt}` },
  );
  if (problem === null) {
    const question = yield* world.question(workflows, runId);
    expect(question.name).toBe("approve-plan");
    yield* workflows.answer(runId, question.name, { choice: "Drop" });
  }
  expect(yield* world.ended(workflows, runId, problem !== null)).toMatchObject({
    status: "stopped",
    detail: problem ?? "plan not approved",
  });
});

const tick = Effect.fn("factoryPack.test.repairTick")(function* (
  world: World,
  workflows: Service,
  key: string,
) {
  const { runId } = yield* workflows.start(
    "factory-self-repair",
    { scheduledAt: DateTime.formatIso(yield* DateTime.now) },
    { idempotencyKey: key },
  );
  return yield* world.ended(workflows, runId, true);
});

it.effect.each([
  { label: "no failures", stops: [] },
  { label: "a single technical failure", stops: [PROBLEMS[0]] },
  { label: "two rejected plans", stops: [null, null] },
])("self-repair skips $label without creating a task", ({ stops }) =>
  Effect.promise(() =>
    withWorld(script, (world) =>
      world.server(
        Effect.fn("factoryPack.test.repairSkipped")(function* (workflows) {
          for (const [index, problem] of stops.entries()) {
            yield* stopTask(world, workflows, index + 1, problem);
          }
          expect(yield* tick(world, workflows, "repair/first")).toMatchObject(skipped);
          expect(yield* workflows.stored("factory/v1/task/")).toEqual([]);
          expect(yield* workflows.stored("factory/v1/repair-seen/")).toEqual([]);
        }),
      ),
    ),
  ),
);

it.effect("self-repair captures a recurring workspace failure once and leaves it in Backlog", () =>
  Effect.promise(() =>
    withWorld(script, (world) =>
      world.server(
        Effect.fn("factoryPack.test.repairCaptured")(function* (workflows) {
          for (const [index, problem] of PROBLEMS.entries()) {
            yield* stopTask(world, workflows, index + 1, problem);
          }
          const first = yield* tick(world, workflows, "repair/first");
          expect(first.status).toBe("completed");
          const {
            captured: [capture],
          } = yield* decodeCaptured(first.result);
          expect(capture.count).toBe(PROBLEMS.length);
          expect(capture.fingerprint).not.toBe("");
          const tasks = yield* workflows.stored("factory/v1/task/");
          expect(tasks.map(({ key }) => key)).toEqual([`factory/v1/task/${capture.taskId}`]);
          const task = yield* decodeTask(tasks[0]?.value);
          expect(task).toMatchObject({
            id: capture.taskId,
            number: capture.number,
            lane: "backlog",
          });
          const text = `${task.title}\n${task.description}`;
          expect(text).toMatch(/scratch workspace unavailable/i);
          expect(text).toMatch(/\b(?:2|two|twice)\b/i);
          const seen = yield* workflows.stored("factory/v1/repair-seen/");
          expect(seen.map(({ key }) => key)).toEqual([
            `factory/v1/repair-seen/${capture.fingerprint}`,
          ]);
          expect(yield* workflows.stored("factory/v1/attempt/")).toEqual([]);

          const next = yield* tick(world, workflows, "repair/next");
          expect(next.runId).not.toBe(first.runId);
          expect(next).toMatchObject(skipped);
          expect(yield* workflows.stored("factory/v1/task/")).toEqual(tasks);
          expect(yield* workflows.stored("factory/v1/attempt/")).toEqual([]);
        }),
      ),
    ),
  ),
);
