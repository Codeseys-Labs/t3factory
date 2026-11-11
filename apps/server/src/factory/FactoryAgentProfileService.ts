import {
  FactoryAgentProfileDeleteInput,
  FactoryAgentProfileSaveInput,
  FactoryTaskError,
  type CommandId,
  type FactoryAgentProfile,
  type FactoryAgentProfileListResult,
  type FactoryAgentProfileMutationResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Tasks from "../persistence/FactoryTaskStore.ts";
import { executionDigest } from "./FactoryExecutionDigest.ts";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";
import * as Changes from "./FactoryTaskChanges.ts";

export class FactoryAgentProfileService extends Context.Service<
  FactoryAgentProfileService,
  {
    readonly list: () => Effect.Effect<FactoryAgentProfileListResult, FactoryTaskError>;
    readonly save: (
      input: FactoryAgentProfileSaveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryAgentProfileMutationResult, FactoryTaskError>;
    readonly delete: (
      input: FactoryAgentProfileDeleteInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryAgentProfileMutationResult, FactoryTaskError>;
  }
>()("t3/factory/FactoryAgentProfileService") {}

const MAX_PROFILES = 64;
const invalid = (cause: unknown) => new FactoryTaskError({ reason: "invalid-input", cause });
const isTaskError = Schema.is(FactoryTaskError);
const decodeSave = Schema.decodeEffect(FactoryAgentProfileSaveInput);
const decodeDelete = Schema.decodeEffect(FactoryAgentProfileDeleteInput);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* Tasks.FactoryTaskStore;
  const changes = yield* Changes.FactoryTaskChanges;
  const transact = <A, R>(effect: Effect.Effect<A, FactoryTaskError, R>) =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.mapError((cause) =>
          isTaskError(cause)
            ? cause
            : new FactoryTaskError({ reason: "persistence-failure", cause }),
        ),
      );

  /** A command id answers once: the same input replays, a different one conflicts. */
  const begin = Effect.fn("FactoryAgentProfileService.begin")(function* (
    kind: string,
    commandId: CommandId,
    actor: FactoryPlanActor,
    input: unknown,
  ) {
    if (actor.kind !== "human") return yield* new FactoryTaskError({ reason: "forbidden" });
    const digest = executionDigest([kind, actor, input]);
    const existing = yield* store.receipt(commandId);
    if (existing !== null && (existing.kind !== kind || existing.digest !== digest))
      return yield* new FactoryTaskError({ reason: "command-conflict" });
    return {
      replayed: existing !== null,
      record: Effect.fn("FactoryAgentProfileService.record")(function* (id: string) {
        // Every task resolves its assignee through the profiles, so all of them are refreshed.
        yield* store.refreshAll;
        yield* store.recordReceipt({ commandId, kind, digest, outcome: id });
        yield* changes.announce({ rootIds: [], profiles: true });
      }),
    };
  });
  const find = (profiles: ReadonlyArray<FactoryAgentProfile>, id: string) =>
    profiles.find((profile) => profile.id === id) ?? null;

  return FactoryAgentProfileService.of({
    list: Effect.fn("FactoryAgentProfileService.list")(function* () {
      const at = yield* DateTime.now;
      const usage = yield* store.profileUsage(
        DateTime.formatIso(DateTime.subtract(at, { days: 7 })),
      );
      return {
        profiles: (yield* store.listProfiles).slice(0, MAX_PROFILES).map((profile) => ({
          profile,
          tasksThisWeek: usage.get(profile.id) ?? 0,
        })),
        fetchedAt: DateTime.formatIso(at),
      };
    }),
    save: Effect.fn("FactoryAgentProfileService.save")(function* (raw, actor) {
      const input = yield* decodeSave(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("profile.save", input.commandId, actor, input);
      const id = input.id ?? executionDigest(["factory-agent-profile/1", input.commandId]);
      if (command.replayed) return { profile: find(yield* store.listProfiles, id), replayed: true };
      const at = DateTime.formatIso(yield* DateTime.now);
      const saved = yield* transact(
        Effect.gen(function* () {
          const profiles = yield* store.listProfiles;
          const current = find(profiles, id);
          if (input.id !== undefined) {
            if (current === null) return yield* new FactoryTaskError({ reason: "missing-profile" });
            if (input.expectedVersion === undefined)
              return yield* new FactoryTaskError({ reason: "invalid-input" });
            if (current.version !== input.expectedVersion)
              return yield* new FactoryTaskError({
                reason: "version-conflict",
                currentVersion: current.version,
              });
          } else if (profiles.length >= MAX_PROFILES)
            return yield* new FactoryTaskError({ reason: "invalid-input" });
          const profile: FactoryAgentProfile = {
            id,
            name: input.name.trim(),
            setup: input.setup,
            handles: [...new Set(input.handles)],
            version: current === null ? 0 : current.version + 1,
            createdAt: current?.createdAt ?? at,
            updatedAt: at,
          };
          if (profile.name === "") return yield* new FactoryTaskError({ reason: "invalid-input" });
          yield* store.putProfile(profile);
          yield* command.record(id);
          return profile;
        }),
      );
      return { profile: saved, replayed: false };
    }),
    delete: Effect.fn("FactoryAgentProfileService.delete")(function* (raw, actor) {
      const input = yield* decodeDelete(raw).pipe(Effect.mapError(invalid));
      const command = yield* begin("profile.delete", input.commandId, actor, input);
      if (command.replayed) return { profile: null, replayed: true };
      yield* transact(
        Effect.gen(function* () {
          const current = find(yield* store.listProfiles, input.id);
          if (current === null) return yield* new FactoryTaskError({ reason: "missing-profile" });
          if (current.version !== input.expectedVersion)
            return yield* new FactoryTaskError({
              reason: "version-conflict",
              currentVersion: current.version,
            });
          yield* store.deleteProfile(input.id);
          yield* command.record(input.id);
        }),
      );
      return { profile: null, replayed: false };
    }),
  });
});

export const layer = Layer.effect(FactoryAgentProfileService, make).pipe(
  Layer.provide(Layer.merge(Changes.layer, Tasks.layer)),
);
