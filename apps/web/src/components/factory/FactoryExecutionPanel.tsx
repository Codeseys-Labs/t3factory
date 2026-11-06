import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  FactoryExecutionPolicy,
  type FactoryExecutionAdmitInput,
  type FactoryExecutionIssueGrantInput,
  type FactoryExecutionRevokeGrantInput,
  type FactoryExecutionRetryInput,
  type FactoryExecutionSelection,
  type FactoryExecutionStopInput,
  type FactoryPlanSnapshot,
  type FactoryPreparationAcceptInput,
  type FactoryPreparationReopenInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { factoryEnvironment } from "../../state/factory";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FactoryExecutionPolicyEditor } from "./FactoryExecutionPolicyEditor";

import {
  canRetryFactoryAttempt,
  hasCompleteAbsenceOfAttemptOutput,
} from "./factoryExecution.logic";

type Request =
  | { kind: "grant"; input: FactoryExecutionIssueGrantInput }
  | { kind: "revoke"; input: FactoryExecutionRevokeGrantInput }
  | { kind: "start"; input: FactoryExecutionAdmitInput }
  | { kind: "retry"; input: FactoryExecutionRetryInput }
  | { kind: "stop"; input: FactoryExecutionStopInput }
  | { kind: "accept"; input: FactoryPreparationAcceptInput }
  | { kind: "reopen"; input: FactoryPreparationReopenInput };

const decodePolicy = Schema.decodeUnknownSync(FactoryExecutionPolicy);

export function FactoryExecutionPanel({ plan }: { readonly plan: FactoryPlanSnapshot }) {
  const { ref, revision } = plan;
  const environmentId = ref.environmentId;
  const project = useProjects().find(
    (item) => item.environmentId === environmentId && item.id === ref.projectId,
  );
  const query = useEnvironmentQuery(
    factoryEnvironment.readExecution({ environmentId, input: { ref, revision } }),
  );
  const history = useEnvironmentQuery(
    factoryEnvironment.readPreparationHistory({ environmentId, input: { ref, revision } }),
  );
  const issue = useAtomCommand(factoryEnvironment.issueExecutionGrant, {
    label: "grant execution",
  });
  const revoke = useAtomCommand(factoryEnvironment.revokeExecutionGrant, {
    label: "revoke execution grant",
  });
  const admit = useAtomCommand(factoryEnvironment.admitExecution, { label: "start task" });
  const retry = useAtomCommand(factoryEnvironment.retryExecution, { label: "retry task" });
  const stop = useAtomCommand(factoryEnvironment.stopExecution, { label: "stop attempt" });
  const accept = useAtomCommand(factoryEnvironment.acceptPreparation, {
    label: "accept preparation",
  });
  const reopen = useAtomCommand(factoryEnvironment.reopenPreparation, {
    label: "reopen preparation",
  });
  const canGrant = useAtomValue(
    factoryEnvironment.issueExecutionGrant.permissionAtom(environmentId),
  );
  const canRevoke = useAtomValue(
    factoryEnvironment.revokeExecutionGrant.permissionAtom(environmentId),
  );
  const canStart = useAtomValue(factoryEnvironment.admitExecution.permissionAtom(environmentId));
  const canRetry = useAtomValue(factoryEnvironment.retryExecution.permissionAtom(environmentId));
  const canStop = useAtomValue(factoryEnvironment.stopExecution.permissionAtom(environmentId));
  const canAccept = useAtomValue(
    factoryEnvironment.acceptPreparation.permissionAtom(environmentId),
  );
  const canReopen = useAtomValue(
    factoryEnvironment.reopenPreparation.permissionAtom(environmentId),
  );
  const [policyText, setPolicyText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<Request | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [openResult, setOpenResult] = useState<{
    selection: FactoryExecutionSelection;
    resultId: string;
  } | null>(null);
  const [reviewed, setReviewed] = useState<readonly string[]>([]);
  const [delivery, setDelivery] = useState<"not-requested" | "outstanding">("not-requested");
  const data = query.error === null ? query.data : null;
  const run = async (value: Request) => {
    if (inFlight.current) return;
    if (
      request !== value &&
      (value.kind === "start" || value.kind === "retry") &&
      (!data?.grant ||
        data.grant.revokedAt !== null ||
        Date.parse(data.grant.policy.expiresAt) <= Date.now())
    ) {
      setError("The execution grant is inactive or expired. Refresh before starting work.");
      query.refresh();
      return;
    }
    inFlight.current = true;
    setPending(true);
    setRequest(value);
    setError(null);
    const target = { environmentId, input: value.input };
    const result =
      value.kind === "grant"
        ? await issue({ ...target, input: value.input })
        : value.kind === "revoke"
          ? await revoke({ ...target, input: value.input })
          : value.kind === "start"
            ? await admit({ ...target, input: value.input })
            : value.kind === "retry"
              ? await retry({ ...target, input: value.input })
              : value.kind === "stop"
                ? await stop({ ...target, input: value.input })
                : value.kind === "accept"
                  ? await accept({ ...target, input: value.input })
                  : await reopen({ ...target, input: value.input });
    inFlight.current = false;
    setPending(false);
    query.refresh();
    history.refresh();
    if (result._tag === "Success") setRequest(null);
    else setError(String(squashAtomCommandFailure(result)));
  };
  const commandId = () => CommandId.make(randomUUID());
  const submitGrant = () => {
    try {
      const policy = decodePolicy(JSON.parse(policyText));
      void run({
        kind: "grant",
        input: {
          commandId: commandId(),
          ref,
          expectedRevision: revision,
          expectedGrantVersion: data?.grant?.version ?? 0,
          policy,
        },
      });
    } catch {
      setError(
        "The execution policy is incomplete or invalid. Review the exact task specs, edge rules, limits and expiry.",
      );
    }
  };
  const disabled =
    pending || request !== null || !query.isSuccess || data?.currentRevision !== revision;
  const grant = data?.grant;
  const liveGrant =
    grant !== null &&
    grant !== undefined &&
    grant.revokedAt === null &&
    Date.parse(grant.policy.expiresAt) > Date.parse(`${useNowMinute()}Z`);
  const direct =
    plan.tasks.filter((task) => !task.retired).length === 1
      ? data?.tasks.find((task) => task.taskId === ref.rootId)?.selectedResult
      : null;
  const reviewOutputs = data?.assembly?.complete ? data.assembly.outputs : direct ? [direct] : [];
  const acceptanceDigest = data?.assembly
    ? data.assembly.complete
      ? data.assembly.digest
      : undefined
    : direct?.status === "sealed"
      ? direct.digest
      : undefined;
  const reviewedAll =
    reviewOutputs.length > 0 && reviewOutputs.every((output) => reviewed.includes(output.resultId));
  return (
    <section className="space-y-3 rounded border p-3" aria-label="Execution and preparation">
      <h4 className="font-medium">Execution · revision {revision}</h4>
      <p className="text-sm text-muted-foreground">
        Editing a plan grants no execution. A grant applies only to this exact revision. Revoking
        future admission does not stop an active attempt.
      </p>
      {query.error ? <p role="alert">{query.error}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {request ? (
        <div className="space-x-2">
          <span className="text-sm">
            The outcome may be uncertain. Retry sends the same command and parameters.
          </span>
          <Button size="sm" disabled={pending} onClick={() => void run(request)}>
            Retry same request
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || query.isPending || !query.isSuccess}
            onClick={() => setRequest(null)}
          >
            Review refreshed state
          </Button>
        </div>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() => {
          query.refresh();
          history.refresh();
        }}
      >
        Refresh execution
      </Button>
      {data ? (
        <>
          {data.currentRevision !== revision ? (
            <p role="status">
              Current plan is revision {data.currentRevision}; this revision cannot admit new work.
            </p>
          ) : null}
          <p className="text-sm">
            {grant
              ? `Grant ${grant.version} · ${grant.revokedAt ? "revoked" : liveGrant ? "issued" : "expired"} · expires ${grant.policy.expiresAt}`
              : "No execution grant for this revision."}
          </p>
          {grant ? (
            <details>
              <summary>Exact granted policy</summary>
              <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(grant.policy, null, 2)}
              </pre>
            </details>
          ) : null}
          {grant && !grant.revokedAt ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !canRevoke}
              onClick={() =>
                void run({
                  kind: "revoke",
                  input: {
                    commandId: commandId(),
                    ref,
                    expectedRevision: revision,
                    expectedGrantVersion: grant.version,
                  },
                })
              }
            >
              Revoke future admission
            </Button>
          ) : null}
          <details>
            <summary>Configure an execution grant</summary>
            {project ? (
              <FactoryExecutionPolicyEditor
                plan={plan}
                project={project}
                disabled={disabled || !canGrant}
                onGrant={(policy) =>
                  void run({
                    kind: "grant",
                    input: {
                      commandId: commandId(),
                      ref,
                      expectedRevision: revision,
                      expectedGrantVersion: data.grant?.version ?? 0,
                      policy,
                    },
                  })
                }
              />
            ) : (
              <p>Project is unavailable.</p>
            )}
          </details>
          <details>
            <summary>Advanced policy JSON</summary>
            <p className="text-sm">
              Enter the exact policy as JSON: version 1, requesterThreadIds, tasks (taskId,
              modelSelection, runtimeMode, interactionMode, workspaceStrategy, setup, output), edges
              (edgeId, slot, rule), maxAttempts, maxRetriesPerTask, maxConcurrent, expiresAt and
              requiredCapabilities. Setup must be deny; worktree baseRef must be an exact commit.
              Unsupported hard capabilities are refused.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={pending || request !== null}
              onClick={() =>
                setPolicyText(
                  JSON.stringify(
                    {
                      version: 1,
                      requesterThreadIds: [],
                      tasks: plan.tasks
                        .filter((task) => !task.retired)
                        .map((task) => ({
                          taskId: task.id,
                          modelSelection: { instanceId: "", model: "" },
                          runtimeMode: "approval-required",
                          interactionMode: "default",
                          workspaceStrategy: { type: "root" },
                          setup: "deny",
                          output: { slot: "draft", kind: "sealed-draft" },
                        })),
                      edges: plan.edges
                        .filter((edge) => !edge.retired)
                        .map((edge) => ({ edgeId: edge.id, slot: "draft", rule: "sealed-draft" })),
                      maxAttempts: plan.tasks.filter((task) => !task.retired).length,
                      maxRetriesPerTask: 0,
                      maxConcurrent: 1,
                      expiresAt: "",
                      requiredCapabilities: [],
                    },
                    null,
                    2,
                  ),
                )
              }
            >
              Fill policy template
            </Button>
            <p className="text-xs text-muted-foreground">
              Choose the provider instance, model, expiry, output and limits for every task. The
              template is not a grant and does not assert a hard sandbox or cost limit.
            </p>
            <Textarea
              aria-label="Execution policy JSON"
              value={policyText}
              onChange={(event) => setPolicyText(event.target.value)}
              rows={12}
            />
            <Button size="sm" disabled={disabled || !canGrant} onClick={submitGrant}>
              Grant exact revision {revision}
            </Button>
          </details>
          <ul className="space-y-3">
            {plan.tasks
              .filter((task) => !task.retired)
              .map((task) => {
                const state = data.tasks.find((entry) => entry.taskId === task.id);
                const selection = { ref, revision, taskId: task.id };
                const binding = state?.binding;
                return (
                  <li key={task.id} className="space-y-1 rounded border p-2">
                    <p className="font-medium">{task.title}</p>
                    <p className="text-sm">
                      {state?.status ?? "unknown"}
                      {state?.hold ? ` · ${state.hold}` : ""}
                      {binding?.stopRequested ? " · stop requested" : ""}
                      {binding && !binding.quiescent ? " · quiescence not established" : ""}
                    </p>
                    {binding ? (
                      <p className="break-all text-xs">
                        Thread {binding.threadId} · run {binding.runId} · attempt{" "}
                        {binding.runAttemptId} · model {binding.spec.modelSelection.model} · harness{" "}
                        {binding.driver} · provider instance{" "}
                        {binding.spec.modelSelection.instanceId} · environment {ref.environmentId}.
                      </p>
                    ) : null}
                    {grant &&
                    liveGrant &&
                    grant.policy.tasks.some((spec) => spec.taskId === task.id) &&
                    state &&
                    state.status === "idle" &&
                    state.hold === null ? (
                      <Button
                        size="sm"
                        disabled={disabled || !canStart}
                        onClick={() =>
                          void run({
                            kind: "start",
                            input: {
                              commandId: commandId(),
                              selection,
                              grantVersion: grant.version,
                              expectedTaskVersion: state.version,
                            },
                          })
                        }
                      >
                        Start task
                      </Button>
                    ) : null}
                    {binding && !binding.stopRequested && !binding.quiescent ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={pending || request !== null || !canStop}
                        onClick={() =>
                          void run({
                            kind: "stop",
                            input: {
                              commandId: commandId(),
                              selection,
                              runId: binding.runId,
                              runAttemptId: binding.runAttemptId,
                            },
                          })
                        }
                      >
                        Stop active attempt
                      </Button>
                    ) : null}
                    {state?.selectedResult ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          setOpenResult({ selection, resultId: state.selectedResult!.resultId })
                        }
                      >
                        Review retained result
                      </Button>
                    ) : null}
                    {state ? (
                      <TaskOutputs
                        key={binding?.runAttemptId ?? "unadmitted"}
                        selection={selection}
                        onOpen={(resultId) => setOpenResult({ selection, resultId })}
                        onRetry={
                          grant &&
                          binding &&
                          canRetryFactoryAttempt({
                            status: state.status,
                            hold: state.hold,
                            grantActive: liveGrant,
                            taskGranted: grant.policy.tasks.some((spec) => spec.taskId === task.id),
                            quiescent: binding.quiescent,
                            permitted: canRetry && !disabled,
                          })
                            ? (resultId) =>
                                void run({
                                  kind: "retry",
                                  input: {
                                    commandId: commandId(),
                                    selection,
                                    grantVersion: grant.version,
                                    expectedTaskVersion: state.version,
                                    priorRunId: binding.runId,
                                    priorRunAttemptId: binding.runAttemptId,
                                    priorResultId: resultId,
                                    intent: "retry",
                                  },
                                })
                            : null
                        }
                        activeRunAttemptId={binding?.runAttemptId ?? null}
                      />
                    ) : null}
                  </li>
                );
              })}
          </ul>
          {openResult ? (
            <ResultReader
              key={openResult.resultId}
              {...openResult}
              onClose={() => setOpenResult(null)}
              onReviewed={() => setReviewed((old) => [...old, openResult.resultId])}
            />
          ) : null}
          {data.assembly ? (
            <div className="space-y-2">
              <h5 className="font-medium">Preparation assembly</h5>
              <p className="break-all text-sm">
                Digest {data.assembly.digest} ·{" "}
                {data.assembly.complete
                  ? "complete"
                  : `held; missing ${data.assembly.missingTaskIds.join(", ")}`}
              </p>
              <details>
                <summary>Exact assembly manifest</summary>
                <pre className="overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(data.assembly, null, 2)}
                </pre>
              </details>
              {data.assembly.outputs.map((output) => (
                <Button
                  key={output.resultId}
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setOpenResult({ selection: output.selection, resultId: output.resultId })
                  }
                >
                  Review {output.slot} · {output.digest}
                </Button>
              ))}
            </div>
          ) : null}
          {data.acceptance ? (
            <p className="text-sm">
              Preparation accepted {data.acceptance.acceptedAt} · {data.acceptance.digest} ·
              delivery {data.acceptance.delivery}
              {data.reopened ? " · reopened idle" : ""}
            </p>
          ) : null}
          {acceptanceDigest && !data.acceptance ? (
            <div className="space-y-2">
              <p className="text-sm">
                Review each retained output before accepting the exact preparation. Acceptance does
                not authorize external actions.
              </p>
              <div className="text-sm">
                Delivery status
                <Select
                  value={delivery}
                  onValueChange={(value) =>
                    setDelivery(value === "outstanding" ? "outstanding" : "not-requested")
                  }
                >
                  <SelectTrigger aria-label="Delivery status">
                    <SelectValue>
                      {delivery === "outstanding" ? "Outstanding" : "Not requested"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="not-requested">Not requested</SelectItem>
                    <SelectItem value="outstanding">Outstanding</SelectItem>
                  </SelectPopup>
                </Select>
              </div>
              <Button
                size="sm"
                disabled={disabled || !canAccept || !reviewedAll}
                onClick={() =>
                  void run({
                    kind: "accept",
                    input: {
                      commandId: commandId(),
                      selection: { ref, revision, taskId: ref.rootId },
                      expectedDigest: acceptanceDigest,
                      scope: "local-preparation",
                      delivery,
                    },
                  })
                }
              >
                Accept exact preparation
              </Button>
            </div>
          ) : null}
          {data.acceptance && !data.reopened ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !canReopen}
              onClick={() =>
                void run({
                  kind: "reopen",
                  input: {
                    commandId: commandId(),
                    selection: data.acceptance!.selection,
                    expectedDigest: data.acceptance!.digest,
                  },
                })
              }
            >
              Reopen idle
            </Button>
          ) : null}
          {history.error === null && history.data?.items.length ? (
            <details>
              <summary>Preparation history</summary>
              {history.data.items.map((item) => (
                <p key={item.commandId} className="break-all text-xs">
                  {item.acceptedAt} · {item.digest} · delivery {item.delivery}
                </p>
              ))}
            </details>
          ) : null}
        </>
      ) : !query.error ? (
        <p role="status">Loading execution…</p>
      ) : null}
    </section>
  );
}

function TaskOutputs(props: {
  readonly selection: FactoryExecutionSelection;
  readonly activeRunAttemptId: string | null;
  readonly onOpen: (resultId: string) => void;
  readonly onRetry: ((resultId: string | null) => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const [beforeResultId, setBeforeResultId] = useState<string | undefined>();
  const [seenAttempt, setSeenAttempt] = useState(false);
  const query = useEnvironmentQuery(
    open
      ? factoryEnvironment.readExecutionOutputs({
          environmentId: props.selection.ref.environmentId,
          input: {
            ref: props.selection.ref,
            revision: props.selection.revision,
            taskId: props.selection.taskId,
            beforeResultId,
            limit: 50,
          },
        })
      : null,
  );
  return (
    <div className="space-y-1">
      <Button size="xs" variant="outline" onClick={() => setOpen(!open)}>
        {open
          ? "Hide result history"
          : props.onRetry
            ? "Results and explicit retry"
            : "Result history"}
      </Button>
      {open && query.error ? <p role="alert">{query.error}</p> : null}
      {open && query.error === null && query.data ? (
        <>
          <ul>
            {query.data.items.map((output) => (
              <li key={output.resultId} className="space-x-1 text-xs">
                {output.slot} · {output.status} · {output.digest}
                <Button size="xs" variant="outline" onClick={() => props.onOpen(output.resultId)}>
                  Read
                </Button>
                {props.onRetry &&
                output.status === "failed" &&
                output.runAttemptId === props.activeRunAttemptId ? (
                  <Button size="xs" onClick={() => props.onRetry?.(output.resultId)}>
                    Explicitly retry this attempt
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {props.onRetry &&
          hasCompleteAbsenceOfAttemptOutput({
            waiting: query.isPending,
            nextPage: query.data.nextBeforeResultId,
            seenOnEarlierPages: seenAttempt,
            seenOnCurrentPage: query.data.items.some(
              (output) => output.runAttemptId === props.activeRunAttemptId,
            ),
          }) ? (
            <Button size="xs" onClick={() => props.onRetry?.(null)}>
              Explicitly retry failed attempt without a result
            </Button>
          ) : null}
          <div className="space-x-1">
            {beforeResultId ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setSeenAttempt(false);
                  setBeforeResultId(undefined);
                }}
              >
                First page
              </Button>
            ) : null}
            {query.data.nextBeforeResultId ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setSeenAttempt(
                    (seen) =>
                      seen ||
                      !!query.data?.items.some(
                        (output) => output.runAttemptId === props.activeRunAttemptId,
                      ),
                  );
                  setBeforeResultId(query.data?.nextBeforeResultId ?? undefined);
                }}
              >
                More results
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setSeenAttempt(false);
                setBeforeResultId(undefined);
                query.refresh();
              }}
            >
              Refresh results
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ResultReader(props: {
  readonly selection: FactoryExecutionSelection;
  readonly resultId: string;
  readonly onClose: () => void;
  readonly onReviewed: () => void;
}) {
  const query = useEnvironmentQuery(
    factoryEnvironment.readExecutionOutput({
      environmentId: props.selection.ref.environmentId,
      input: { selection: props.selection, resultId: props.resultId },
    }),
  );
  const data = query.error === null ? query.data : null;
  return (
    <section className="space-y-2 rounded border p-3" aria-label="Retained result">
      <Button size="sm" variant="outline" onClick={props.onClose}>
        Back to execution
      </Button>
      {query.error ? (
        <p role="alert">{query.error}</p>
      ) : data ? (
        <>
          <p className="break-all text-xs">
            {data.output.kind} · {data.output.status} · digest {data.output.digest} · run{" "}
            {data.binding.runId} · attempt {data.binding.runAttemptId} · model{" "}
            {data.binding.spec.modelSelection.model} · harness {data.binding.driver} · provider
            instance {data.binding.spec.modelSelection.instanceId} · environment{" "}
            {data.binding.selection.ref.environmentId}.
          </p>
          {data.output.checkpoint ? (
            <p className="break-all text-xs">
              Commit {data.output.checkpoint.commit} · tree {data.output.checkpoint.tree} ·
              verification {data.output.checkpoint.verificationDigest} · retained ref{" "}
              {data.output.checkpoint.retainedRef}
            </p>
          ) : null}
          <pre className="whitespace-pre-wrap break-words">{data.text}</pre>
          <Button size="sm" onClick={props.onReviewed}>
            Mark this exact result reviewed
          </Button>
        </>
      ) : (
        <p>Loading retained result…</p>
      )}
    </section>
  );
}
