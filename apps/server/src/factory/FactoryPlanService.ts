import {
  EventId,
  FactoryPlanApplyInput,
  FactoryPlanCreateInput,
  FactoryPlanError,
  FactoryPlanHistoryInput,
  FactoryPlanListInput,
  FactoryPlanReadInput,
  type FactoryPlanHistoryResult,
  type FactoryPlanListResult,
  type FactoryPlanMutationResult,
  type FactoryPlanSnapshot,
  type FactoryPlanRef,
  type FactoryPlanWorkContext,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Store from "../persistence/FactoryPlanStore.ts";
import * as Work from "./FactoryWorkService.ts";
import { canEditFactoryPlan, type FactoryPlanActor } from "./FactoryPlanReducer.ts";
import type { FactoryIntakeScheduleAuthority } from "./FactoryIntakeSchedule.ts";

export class FactoryPlanService extends Context.Service<
  FactoryPlanService,
  {
    readonly create: (
      input: FactoryPlanCreateInput,
      actor: FactoryPlanActor,
      schedule?: FactoryIntakeScheduleAuthority,
    ) => Effect.Effect<FactoryPlanMutationResult, FactoryPlanError>;
    readonly apply: (
      input: FactoryPlanApplyInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryPlanMutationResult, FactoryPlanError>;
    readonly read: (
      input: FactoryPlanReadInput,
    ) => Effect.Effect<FactoryPlanSnapshot, FactoryPlanError>;
    readonly list: (
      input: FactoryPlanListInput,
    ) => Effect.Effect<FactoryPlanListResult, FactoryPlanError>;
    readonly history: (
      input: FactoryPlanHistoryInput,
    ) => Effect.Effect<FactoryPlanHistoryResult, FactoryPlanError>;
  }
>()("t3/factory/FactoryPlanService") {}

const decodeCreate = Schema.decodeEffect(FactoryPlanCreateInput);
const decodeApply = Schema.decodeEffect(FactoryPlanApplyInput);
const decodeRead = Schema.decodeEffect(FactoryPlanReadInput);
const decodeList = Schema.decodeEffect(FactoryPlanListInput);
const decodeHistory = Schema.decodeEffect(FactoryPlanHistoryInput);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const make = Effect.gen(function* () {
  const store = yield* Store.FactoryPlanStore;
  const sink = yield* EventSink.EventSinkV2;
  const work = yield* Work.FactoryWorkService;
  const identity = yield* ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;
  const sha256 = Effect.fn("FactoryPlanService.sha256")((value: unknown) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(canonical(value)))
      .pipe(Effect.map(Hex.encode), Effect.orDie),
  );
  const invalid = (cause: unknown) => new FactoryPlanError({ reason: "invalid-operation", cause });
  const assertEnvironment = Effect.fn("FactoryPlanService.assertEnvironment")(function* (
    ref: FactoryPlanRef,
  ) {
    if (ref.environmentId !== (yield* identity.getEnvironmentId))
      return yield* new FactoryPlanError({ reason: "wrong-environment" });
  });
  const create = Effect.fn("FactoryPlanService.create")(function* (
    raw: FactoryPlanCreateInput,
    actor: FactoryPlanActor,
    schedule?: FactoryIntakeScheduleAuthority,
  ) {
    if (actor.kind !== "human") return yield* new FactoryPlanError({ reason: "forbidden" });
    const input = yield* decodeCreate(raw).pipe(Effect.mapError(invalid));
    const environmentId = yield* identity.getEnvironmentId;
    const ref = {
      environmentId,
      projectId: input.projectId,
      rootId: yield* sha256([
        "factory-plan-root/1",
        environmentId,
        input.projectId,
        input.commandId,
      ]),
    };
    return yield* sink.commitFactoryPlanCommand({
      commandId: input.commandId,
      eventId: EventId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
      ref,
      expectedRevision: 0,
      requestDigest: yield* sha256([
        "factory-plan-command/1",
        environmentId,
        "create",
        actor,
        input,
      ]),
      actor,
      ...(schedule === undefined ? {} : { schedule }),
      create: { title: input.title, context: input.context ?? "" },
      operations: [],
      contexts: [],
      resolutionFailed: false,
      occurredAt: DateTime.formatIso(yield* DateTime.now),
    });
  });
  const apply = Effect.fn("FactoryPlanService.apply")(function* (
    raw: FactoryPlanApplyInput,
    actor: FactoryPlanActor,
  ) {
    const input = yield* decodeApply(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.ref);
    const current = yield* store.read({ ref: input.ref });
    if (!canEditFactoryPlan(current, actor))
      return yield* new FactoryPlanError({ reason: "forbidden" });
    const contexts: FactoryPlanWorkContext[] = [];
    let resolutionFailed = false;
    if (
      current.revision === input.expectedRevision &&
      !(yield* store.hasCommand(input.commandId))
    ) {
      for (const op of input.operations) {
        if (op.type !== "context.attachWork") continue;
        if (op.ref.environmentId !== input.ref.environmentId) {
          resolutionFailed = true;
          break;
        }
        const observed = yield* work.read({ ref: op.ref }).pipe(Effect.result);
        if (Result.isFailure(observed) || !observed.success.projectAvailable) {
          resolutionFailed = true;
          break;
        }
        const value = observed.success;
        const content = {
          ref: value.item.ref,
          projectId: value.item.projectId,
          title: value.item.title,
          revision: value.item.revision,
          snapshot: value.snapshot,
          snapshotTruncated: value.snapshotTruncated,
        };
        contexts.push({
          id: op.id,
          taskId: op.taskId,
          ...content,
          observedAt: value.fetchedAt,
          sha256: yield* sha256(["factory-plan-retained-work/1", content]),
          retired: false,
        });
      }
    }
    return yield* sink.commitFactoryPlanCommand({
      commandId: input.commandId,
      eventId: EventId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
      ref: input.ref,
      expectedRevision: input.expectedRevision,
      requestDigest: yield* sha256([
        "factory-plan-command/1",
        input.ref.environmentId,
        "apply",
        actor,
        input,
      ]),
      actor,
      create: null,
      operations: input.operations,
      contexts,
      resolutionFailed,
      occurredAt: DateTime.formatIso(yield* DateTime.now),
    });
  });
  const read = Effect.fn("FactoryPlanService.read")(function* (raw: FactoryPlanReadInput) {
    const input = yield* decodeRead(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.ref);
    return yield* store.read(input);
  });
  const list = Effect.fn("FactoryPlanService.list")(function* (raw: FactoryPlanListInput) {
    const input = yield* decodeList(raw).pipe(Effect.mapError(invalid));
    return yield* store.list(input);
  });
  const history = Effect.fn("FactoryPlanService.history")(function* (raw: FactoryPlanHistoryInput) {
    const input = yield* decodeHistory(raw).pipe(Effect.mapError(invalid));
    yield* assertEnvironment(input.ref);
    return yield* store.history(input);
  });
  return FactoryPlanService.of({ create, apply, read, list, history });
});
export const layer = Layer.effect(FactoryPlanService, make).pipe(Layer.provide(Store.layer));
