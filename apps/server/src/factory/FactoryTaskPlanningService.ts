import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  FactoryTaskBreakdownInput,
  FactoryTaskError,
  FactoryTaskPlanProposal,
  FactoryTaskPlanProposalResolveInput,
  FactoryTaskPlanProposalUpdateInput,
  FactoryTaskRef,
  MessageId,
  ThreadId,
  sessionGrantsScope,
  type FactoryTaskMutationResult,
  type FactoryTaskPlanProposalMutationResult,
  type FactoryTaskPlanProposalReadInput,
  type FactoryTaskPlanProposalReadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Store from "../persistence/FactoryTaskProposalStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Launch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Tasks from "./FactoryTaskService.ts";
import * as Profiles from "./FactoryAgentProfileService.ts";
import { buildPlanningPrompt } from "./FactoryTaskPlanningPrompt.ts";
import type { FactoryPlanActor } from "./FactoryPlanReducer.ts";

export const ProposeSubtasksInput = Schema.Struct({
  ref: FactoryTaskRef,
  items: Schema.Array(
    Schema.Struct({
      key: FactoryTaskPlanProposal.fields.items.value.fields.key,
      title: FactoryTaskPlanProposal.fields.items.value.fields.title,
      description: FactoryTaskPlanProposal.fields.items.value.fields.description,
      after: FactoryTaskPlanProposal.fields.items.value.fields.after,
      profile: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});
type ProposeSubtasksInput = typeof ProposeSubtasksInput.Type;

const isTaskError = Schema.is(FactoryTaskError);
const decodeItems = Schema.decodeEffect(FactoryTaskPlanProposal.fields.items);
const decodeBreakdown = Schema.decodeEffect(FactoryTaskBreakdownInput);
const decodePropose = Schema.decodeEffect(ProposeSubtasksInput);
const decodeUpdate = Schema.decodeEffect(FactoryTaskPlanProposalUpdateInput);
const decodeResolve = Schema.decodeEffect(FactoryTaskPlanProposalResolveInput);

export class FactoryTaskPlanningService extends Context.Service<
  FactoryTaskPlanningService,
  {
    readonly propose: (
      input: ProposeSubtasksInput,
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly proposal: FactoryTaskPlanProposal }, FactoryTaskError>;
    readonly requestBreakdown: (
      input: FactoryTaskBreakdownInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskMutationResult, FactoryTaskError>;
    readonly readProposal: (
      input: FactoryTaskPlanProposalReadInput,
    ) => Effect.Effect<FactoryTaskPlanProposalReadResult, FactoryTaskError>;
    readonly updateProposal: (
      input: FactoryTaskPlanProposalUpdateInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskPlanProposalMutationResult, FactoryTaskError>;
    readonly resolveProposal: (
      input: FactoryTaskPlanProposalResolveInput,
      actor: FactoryPlanActor,
    ) => Effect.Effect<FactoryTaskPlanProposalMutationResult, FactoryTaskError>;
  }
>()("t3/factory/FactoryTaskPlanningService") {}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

const make = Effect.gen(function* () {
  const store = yield* Store.FactoryTaskProposalStore;
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* Tasks.FactoryTaskService;
  const profiles = yield* Profiles.FactoryAgentProfileService;
  const launcher = yield* Launch.ThreadLaunchService;
  const threads = yield* Threads.ThreadManagementService;
  const sessions = yield* AuthSessions.AuthSessionRepository;
  const identity = yield* ServerEnvironmentIdentity;
  const crypto = yield* Crypto.Crypto;
  // Launches still running in this process; any other unrecorded reservation was abandoned.
  const launching = new Set<ThreadId>();
  const persistence = (cause: unknown) =>
    isTaskError(cause) ? cause : new FactoryTaskError({ reason: "persistence-failure", cause });
  const invalid = (cause: unknown) => new FactoryTaskError({ reason: "invalid-input", cause });
  const readTask = Effect.fn("FactoryTaskPlanningService.readTask")(function* (
    ref: FactoryTaskRef,
  ) {
    if (ref.environmentId !== (yield* identity.getEnvironmentId))
      return yield* new FactoryTaskError({ reason: "wrong-environment" });
    return yield* tasks.read({ task: { ref } });
  });
  const human = Effect.fn("FactoryTaskPlanningService.requireHuman")(function* (
    actor: FactoryPlanActor,
  ) {
    if (actor.kind !== "human") return yield* new FactoryTaskError({ reason: "forbidden" });
    const session = yield* sessions
      .getById({ sessionId: actor.sessionId })
      .pipe(Effect.mapError(persistence));
    const now = yield* DateTime.now;
    if (
      Option.isNone(session) ||
      session.value.revokedAt !== null ||
      session.value.expiresAt.epochMilliseconds <= now.epochMilliseconds ||
      !sessionGrantsScope(
        { authenticated: true, scopes: session.value.scopes },
        AuthOrchestrationOperateScope,
      )
    )
      return yield* new FactoryTaskError({ reason: "forbidden" });
  });
  const validate = Effect.fn("FactoryTaskPlanningService.validate")(function* (
    ref: FactoryTaskRef,
    items: FactoryTaskPlanProposal["items"],
  ) {
    yield* decodeItems(items).pipe(Effect.mapError(invalid));
    const byKey = new Map(items.map((item) => [item.key, item]));
    if (byKey.size !== items.length)
      return yield* new FactoryTaskError({ reason: "invalid-input" });
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (key: string): boolean => {
      if (visiting.has(key) || !byKey.has(key)) return false;
      if (visited.has(key)) return true;
      visiting.add(key);
      if (!byKey.get(key)!.after.every(visit)) return false;
      visiting.delete(key);
      visited.add(key);
      return true;
    };
    if (!items.every((item) => visit(item.key)))
      return yield* new FactoryTaskError({ reason: "invalid-input" });
    const seen = new Set<string>();
    const pending = [{ ...ref, taskId: ref.rootId }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current.taskId)) continue;
      seen.add(current.taskId);
      if (seen.size + items.length > 64)
        return yield* new FactoryTaskError({ reason: "task-limit" });
      const detail = yield* readTask(current);
      pending.push(...detail.subtasks.map((task) => task.ref));
    }
  });
  const receipt = Effect.fn("FactoryTaskPlanningService.receipt")(function* (
    id: CommandId,
    digest: string,
  ) {
    const result = yield* store.receipt(id);
    if (result !== null && result.digest !== digest)
      return yield* new FactoryTaskError({ reason: "command-conflict" });
    return result;
  });
  const digestOf = Effect.fn("FactoryTaskPlanningService.digest")(
    (operation: string, input: unknown, actor: FactoryPlanActor) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(canonical({ operation, input, actor })))
        .pipe(Effect.map(Hex.encode), Effect.orDie),
  );
  const requestBreakdown = Effect.fn("FactoryTaskPlanningService.requestBreakdown")(function* (
    raw: FactoryTaskBreakdownInput,
    actor: FactoryPlanActor,
  ) {
    const input = yield* decodeBreakdown(raw).pipe(Effect.mapError(invalid));
    yield* human(actor);
    const digest = yield* digestOf("breakdown", input, actor);
    const reserved = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const detail = yield* readTask(input.ref);
          const prior = yield* receipt(input.commandId, digest);
          if (prior !== null) {
            if (prior.result === null && prior.request !== null)
              launching.add(prior.request.threadId);
            return prior;
          }
          if (detail.task.status === "done" || detail.task.status === "canceled")
            return yield* new FactoryTaskError({ reason: "invalid-transition" });
          if (detail.task.version !== input.expectedVersion)
            return yield* new FactoryTaskError({
              reason: "version-conflict",
              currentVersion: detail.task.version,
            });
          const current = yield* store.request(input.ref);
          if (current !== null) {
            const shell = yield* threads
              .getThreadShell(current.threadId)
              .pipe(Effect.mapError(persistence));
            if (
              launching.has(current.threadId) ||
              (shell === null && current.recorded) ||
              (shell !== null &&
                ["preparing", "running", "starting", "waiting", "queued"].includes(shell.status)) ||
              detail.runs.some(
                (run) =>
                  run.threadId === current.threadId &&
                  ["running", "stopping", "held"].includes(run.state),
              )
            )
              return yield* new FactoryTaskError({ reason: "run-active" });
          }
          const request: Store.BreakdownRequest = {
            input,
            threadId: ThreadId.make(yield* randomUuidV4),
            messageId: MessageId.make(yield* randomUuidV4),
            title: `${detail.task.displayId} Plan: ${detail.task.title}`,
            prompt: buildPlanningPrompt(detail),
            recorded: false,
            open: true,
          };
          yield* store.saveRequest(request);
          const reserved = { digest, request, result: null };
          yield* store.saveReceipt(input.commandId, reserved);
          launching.add(request.threadId);
          return reserved;
        }),
      )
      .pipe(Effect.mapError(persistence));
    if (reserved.result !== null) return { task: reserved.result.task, replayed: true };
    const request = reserved.request!;
    return yield* finishLaunch(input, digest, reserved, request).pipe(
      Effect.ensuring(Effect.sync(() => launching.delete(request.threadId))),
    );
  });
  const finishLaunch = Effect.fn("FactoryTaskPlanningService.finishLaunch")(function* (
    input: FactoryTaskBreakdownInput,
    digest: string,
    reserved: { readonly digest: string; readonly request: Store.BreakdownRequest | null },
    request: Store.BreakdownRequest,
  ) {
    const launched = yield* launcher
      .launch({
        commandId: input.commandId,
        threadId: request.threadId,
        projectId: input.ref.projectId,
        title: request.title,
        ...input.setup,
        workspaceStrategy: { type: "root" },
        initialMessage: { messageId: request.messageId, text: request.prompt, attachments: [] },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new FactoryTaskError({
              reason:
                cause._tag === "ThreadManagementProviderInstanceDisabledError"
                  ? "provider-unavailable"
                  : "persistence-failure",
              cause,
            }),
        ),
      );
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const prior = yield* receipt(input.commandId, digest);
          if (prior?.result !== null && prior?.result !== undefined)
            return { task: prior.result.task, replayed: true };
          const runId =
            launched.projection.runs.find((run) => run.userMessageId === request.messageId)?.id ??
            null;
          if (runId === null) return yield* new FactoryTaskError({ reason: "no-run" });
          yield* tasks.recordPlanningRun({
            ref: input.ref,
            threadId: request.threadId,
            runId,
            setup: input.setup,
          });
          const current = yield* store.request(input.ref);
          yield* store.saveRequest({
            ...request,
            open: current?.open ?? request.open,
            recorded: true,
          });
          const result = { task: (yield* readTask(input.ref)).task, replayed: false };
          yield* store.saveReceipt(input.commandId, { ...reserved, result });
          return result;
        }),
      )
      .pipe(Effect.mapError(persistence));
  });
  const propose = Effect.fn("FactoryTaskPlanningService.propose")(function* (
    raw: ProposeSubtasksInput,
    threadId: ThreadId,
  ) {
    const input = yield* decodePropose(raw).pipe(Effect.mapError(invalid));
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* readTask(input.ref);
          const request = yield* store.request(input.ref);
          if (request === null || !request.open || request.threadId !== threadId)
            return yield* new FactoryTaskError({ reason: "forbidden" });
          const available = (yield* profiles.list()).profiles;
          const items = input.items.map(({ profile, ...item }) => {
            const found = available.find((entry) => entry.profile.name === profile);
            return {
              ...item,
              assignment:
                found === undefined
                  ? { mode: "auto" as const }
                  : { mode: "profile" as const, profileId: found.profile.id },
            };
          });
          yield* validate(input.ref, items);
          const prior = yield* store.proposal(input.ref);
          const now = DateTime.formatIso(yield* DateTime.now);
          const proposal: FactoryTaskPlanProposal = {
            id: prior?.id ?? (yield* randomUuidV4),
            ref: input.ref,
            status: "proposed",
            proposedBy: { threadId, setup: request.input.setup },
            items,
            version: prior === null ? 0 : prior.version + 1,
            createdAt: prior?.createdAt ?? now,
            updatedAt: now,
          };
          yield* store.saveProposal(proposal);
          yield* tasks.recordProposal({
            ref: input.ref,
            proposalId: proposal.id,
            itemCount: items.length,
            status: "proposed",
            actor: { kind: "agent", threadId },
          });
          return { proposal };
        }),
      )
      .pipe(Effect.mapError(persistence));
  });
  const mutate = Effect.fn("FactoryTaskPlanningService.mutate")(function* (
    input: FactoryTaskPlanProposalUpdateInput | FactoryTaskPlanProposalResolveInput,
    actor: FactoryPlanActor,
  ) {
    yield* human(actor);
    const digest = yield* digestOf("items" in input ? "update" : "resolve", input, actor);
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* readTask(input.ref);
          const prior = yield* receipt(input.commandId, digest);
          if (prior?.result !== undefined && prior.result !== null && "proposal" in prior.result)
            return { ...prior.result, replayed: true };
          const proposal = yield* store.proposal(input.ref, input.proposalId);
          if (proposal === null) return yield* new FactoryTaskError({ reason: "missing-proposal" });
          if (proposal.status !== "proposed")
            return yield* new FactoryTaskError({ reason: "invalid-transition" });
          if (proposal.version !== input.expectedVersion)
            return yield* new FactoryTaskError({
              reason: "version-conflict",
              currentVersion: proposal.version,
            });
          const items = "items" in input ? input.items : proposal.items;
          if ("items" in input || input.action === "approve") yield* validate(input.ref, items);
          const status =
            "items" in input ? "proposed" : input.action === "approve" ? "approved" : "dismissed";
          const next: FactoryTaskPlanProposal = {
            ...proposal,
            items,
            status,
            version: proposal.version + 1,
            updatedAt: DateTime.formatIso(yield* DateTime.now),
          };
          if (status === "approved")
            yield* tasks.createSubtasks(
              { commandId: input.commandId, parent: input.ref, items },
              actor,
            );
          yield* store.saveProposal(next);
          if (status !== "proposed") {
            const request = yield* store.request(input.ref);
            if (request !== null) yield* store.saveRequest({ ...request, open: false });
          }
          yield* tasks.recordProposal({
            ref: input.ref,
            proposalId: next.id,
            itemCount: items.length,
            status,
            actor,
          });
          const result = {
            proposal: next,
            task: (yield* readTask(input.ref)).task,
            replayed: false,
          };
          yield* store.saveReceipt(input.commandId, { digest, request: null, result });
          return result;
        }),
      )
      .pipe(Effect.mapError(persistence));
  });
  return FactoryTaskPlanningService.of({
    requestBreakdown,
    propose,
    readProposal: Effect.fn("FactoryTaskPlanningService.readProposal")(function* ({ ref }) {
      yield* readTask(ref);
      return { proposal: yield* store.proposal(ref) };
    }),
    updateProposal: Effect.fn("FactoryTaskPlanningService.updateProposal")(function* (raw, actor) {
      const input = yield* decodeUpdate(raw).pipe(Effect.mapError(invalid));
      return yield* mutate(input, actor);
    }),
    resolveProposal: Effect.fn("FactoryTaskPlanningService.resolveProposal")(
      function* (raw, actor) {
        const input = yield* decodeResolve(raw).pipe(Effect.mapError(invalid));
        return yield* mutate(input, actor);
      },
    ),
  });
});
export const layer = Layer.effect(FactoryTaskPlanningService, make).pipe(
  Layer.provide(Store.layer),
  Layer.provide(AuthSessions.layer),
);
