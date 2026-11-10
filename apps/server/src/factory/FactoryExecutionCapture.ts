import { FactoryExecutionError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "../persistence/FactoryExecutionStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Processes from "../processRunner.ts";
import type { NativeExecutionFinalizationContext } from "../orchestration-v2/NativeExecutionPlan.ts";
import { canonicalExecutionJson, executionDigest } from "./FactoryExecutionDigest.ts";
import { OwnedProcess } from "@t3tools/shared/ownedProcess";

export class FactoryExecutionCapture extends Context.Service<
  FactoryExecutionCapture,
  {
    readonly capture: (
      input: NativeExecutionFinalizationContext,
    ) => Effect.Effect<Store.ObserveResultInput, FactoryExecutionError>;
    readonly read: (
      input: NativeExecutionFinalizationContext,
    ) => Effect.Effect<Store.ObserveResultInput | null, FactoryExecutionError>;
  }
>()("t3/factory/FactoryExecutionCapture") {}

const make = Effect.gen(function* () {
  const store = yield* Store.FactoryExecutionStore;
  const projections = yield* Projections.ProjectionStoreV2;
  const processes = yield* Processes.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const failure = (cause: unknown) =>
    new FactoryExecutionError({ reason: "prerequisite-held", cause });
  const bindingFor = Effect.fn("FactoryExecutionCapture.bindingFor")(function* (
    input: NativeExecutionFinalizationContext,
  ) {
    const binding = yield* store.getBinding(input.runAttemptId);
    if (
      (yield* store.captureKey(input.runAttemptId)) !==
      `native-final/${input.captureGeneration ?? 1}`
    )
      return yield* new FactoryExecutionError({ reason: "task-conflict" });
    if (
      binding.threadId !== input.threadId ||
      binding.runId !== input.runId ||
      binding.driver !== input.driver ||
      binding.spec.modelSelection.instanceId !== input.providerInstanceId
    )
      return yield* new FactoryExecutionError({ reason: "task-conflict" });
    const projection = yield* projections
      .getThreadProjection(input.threadId)
      .pipe(Effect.mapError(failure));
    const attempt = projection.attempts.find((entry) => entry.id === input.runAttemptId);
    if (
      !attempt ||
      attempt.runId !== input.runId ||
      attempt.providerThreadId !== input.providerThreadId ||
      attempt.providerInstanceId !== input.providerInstanceId
    )
      return yield* new FactoryExecutionError({ reason: "task-conflict" });
    return { binding, projection };
  });
  const read = Effect.fn("FactoryExecutionCapture.read")(function* (
    input: NativeExecutionFinalizationContext,
  ) {
    yield* bindingFor(input);
    return yield* store.readCapture(input.runAttemptId);
  });
  const git = Effect.fn("FactoryExecutionCapture.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* processes
      .run({ command: "git", args, cwd, maxOutputBytes: 1024 * 1024, outputMode: "error" })
      .pipe(Effect.mapError(failure));
    if (
      result.code !== 0 ||
      result.timedOut ||
      result.stdoutInvalidUtf8 ||
      result.stderrInvalidUtf8
    )
      return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
    return result.stdout.trim();
  });
  const capture = Effect.fn("FactoryExecutionCapture.capture")(function* (
    input: NativeExecutionFinalizationContext,
  ): Effect.fn.Return<
    Store.ObserveResultInput,
    FactoryExecutionError,
    import("effect/Scope").Scope
  > {
    const retained = yield* read(input);
    if (retained) return retained;
    const { binding, projection } = yield* bindingFor(input);
    const run = projection.runs.find((entry) => entry.id === input.runId);
    const attempt = projection.attempts.find((entry) => entry.id === input.runAttemptId);
    if (
      !run ||
      !attempt ||
      !["completed", "failed", "interrupted", "cancelled"].includes(attempt.status)
    )
      return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
    const messages = projection.messages.filter(
      (message) =>
        message.runId === input.runId && message.role === "assistant" && !message.streaming,
    );
    const text = messages.map((message) => message.text).join("\n\n");
    if (
      binding.spec.output.kind === "sealed-draft" &&
      attempt.status === "completed" &&
      messages.length === 0
    )
      return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
    let checkpoint: Store.ObserveResultInput["checkpoint"] = null;
    let status: Store.ObserveResultInput["status"] =
      attempt.status === "completed" ? "sealed" : "failed";
    if (binding.spec.output.kind === "verified-code" && status === "sealed") {
      if ((yield* OwnedProcess) === undefined)
        return yield* new FactoryExecutionError({ reason: "unsupported-capability" });
      const verification = binding.spec.verification;
      const scope = projection.checkpointScopes.find((entry) => entry.id === input.scopeId);
      const nativeCheckpoint = projection.checkpoints.find(
        (entry) =>
          entry.runId === input.runId &&
          entry.scopeId === input.scopeId &&
          entry.status === "ready",
      );
      if (!verification || !scope || !nativeCheckpoint)
        return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
      const commit = yield* git(scope.cwd, [
        "rev-parse",
        "--verify",
        `${nativeCheckpoint.ref}^{commit}`,
      ]);
      const tree = yield* git(scope.cwd, ["rev-parse", "--verify", `${commit}^{tree}`]);
      if (!/^[a-f0-9]{40,64}$/.test(commit) || !/^[a-f0-9]{40,64}$/.test(tree))
        return yield* new FactoryExecutionError({ reason: "prerequisite-held" });
      const retainedRef = `refs/t3/factory/outputs/${executionDigest(input.runAttemptId)}`;
      const existing = yield* processes
        .run({
          command: "git",
          args: ["rev-parse", "--verify", retainedRef],
          cwd: scope.cwd,
          maxOutputBytes: 256,
        })
        .pipe(Effect.mapError(failure));
      if (existing.code === 0 && existing.stdout.trim() !== commit)
        return yield* new FactoryExecutionError({ reason: "capture-conflict" });
      if (existing.code !== 0)
        yield* git(scope.cwd, ["update-ref", retainedRef, commit, "0".repeat(commit.length)]);
      const temporary = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-factory-verify-" })
        .pipe(Effect.mapError(failure));
      const verificationRoot = path.join(temporary, "tree");
      yield* git(scope.cwd, [
        "-c",
        "core.hooksPath=" + path.join(temporary, "no-hooks"),
        "worktree",
        "add",
        "--detach",
        verificationRoot,
        commit,
      ]);
      const evidence = yield* processes
        .run({
          command: verification.command,
          args: verification.args,
          cwd: verificationRoot,
          maxOutputBytes: 1024 * 1024,
          outputMode: "error",
        })
        .pipe(Effect.mapError(failure));
      const unchanged = yield* git(verificationRoot, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      const finalTree = yield* git(verificationRoot, ["rev-parse", "HEAD^{tree}"]);
      const passed =
        evidence.code === 0 &&
        !evidence.timedOut &&
        !evidence.stdoutInvalidUtf8 &&
        !evidence.stderrInvalidUtf8 &&
        unchanged === "" &&
        finalTree === tree;
      const body = {
        runId: input.runId,
        runAttemptId: input.runAttemptId,
        commit,
        tree,
        retainedRef,
        verification,
        evidence,
        passed,
      };
      const verificationDigest = executionDigest(body);
      yield* sql`INSERT INTO factory_execution_verifications(digest, attempt_id, repository_path, evidence_json) VALUES (${verificationDigest}, ${input.runAttemptId}, ${scope.cwd}, ${canonicalExecutionJson(body)}) ON CONFLICT(digest) DO NOTHING`.pipe(
        Effect.mapError(failure),
      );
      checkpoint = { commit, tree, retainedRef, verificationDigest };
      if (!passed) status = "failed";
      yield* store.retainCapture({
        runId: input.runId,
        runAttemptId: input.runAttemptId,
        captureKey: yield* store.captureKey(input.runAttemptId),
        slot: binding.spec.output.slot,
        text,
        status,
        checkpoint,
      });
      yield* git(scope.cwd, ["worktree", "remove", "--force", verificationRoot]);
    }
    const captured: Store.ObserveResultInput = {
      runId: input.runId,
      runAttemptId: input.runAttemptId,
      captureKey: yield* store.captureKey(input.runAttemptId),
      slot: binding.spec.output.slot,
      text,
      status,
      checkpoint,
    };
    yield* store.retainCapture(captured);
    return captured;
  }, Effect.scoped);
  return FactoryExecutionCapture.of({ capture, read });
});
export const layer = Layer.effect(FactoryExecutionCapture, make);
