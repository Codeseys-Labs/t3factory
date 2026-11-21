import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { factoryIssueReviewText } from "@t3tools/client-runtime/state/factory";
import {
  executeAtomQuery,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type FactoryCommitDeliveryIntent,
  type FactoryCommitDeliveryPrepareResult,
  type FactoryDeliveryCommitKind,
  type FactoryDeliveryPrepareResult,
  type FactoryDeliveryPublishPayload,
  type FactoryIssue,
  type FactoryIssueStartInput,
  type FactoryRepository,
  type ModelSelection,
  type ProjectId,
  type PullRequestMergeMethod,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react-native";
import { use, useCallback, useLayoutEffect, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import {
  factoryAcceptanceSupportedAtom,
  factoryDeliverySupportedAtom,
  factoryEnvironment,
} from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import {
  describeFactoryAcceptanceFailure,
  describeFactoryDeliveryFailure,
  describeFactoryFailure,
  describeFactoryMergeFailure,
  factoryAcceptanceView,
  factoryIssueStartKey,
  factoryIssueTargetOf,
  isFactoryArtifactPrepareResult,
  isFactoryCommitIntent,
  isLiveFactoryDelivery,
  sameFactoryDeliveryPayload,
  type FactoryIssueAction,
  type FactoryIssueTarget,
  type FactoryFailure,
} from "./factoryIssues";

export function useOpenFactoryThread() {
  const selectDetail = useSelectWorkspaceDetail();
  return (environmentId: EnvironmentId, threadId: ThreadId) =>
    selectDetail({ name: "Thread", params: { environmentId, threadId } });
}

export interface FactoryStartSettings {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly repository: FactoryRepository | null;
  /** Names the issue host in failure text; null until the list has loaded. */
  readonly displayName: string | null;
  /** The server addresses issues by native key; without it only decimal numbers start. */
  readonly factoryIssueKeys: boolean;
  readonly modelSelection: ModelSelection | null;
  readonly modelLabel: string;
  readonly baseRef: string | null;
  readonly runtimeMode: RuntimeMode;
}

interface FactoryLaunchRequest {
  readonly environmentId: EnvironmentId;
  readonly input: FactoryIssueStartInput;
  readonly displayName: string | null;
  readonly key: string;
  /** The issue's native key; identifies the busy launch on screen. */
  readonly issueKey: string;
}

export interface FactoryIssueReviewSnapshot {
  readonly issue: FactoryIssue;
  readonly repository: FactoryRepository;
  readonly modelLabel: string;
  readonly request: FactoryLaunchRequest;
  readonly titleText: string;
  readonly bodyText: string | null;
}

export interface FactoryIssueReview {
  readonly snapshot: FactoryIssueReviewSnapshot;
  readonly failure: FactoryFailure | null;
}

interface ActionLifetime {
  readonly key: string;
  active: boolean;
  pending: boolean;
  review: FactoryIssueReview | null;
}

/**
 * New work pins its source and launch input when review opens. Retries keep that same input
 * and command id; a response cannot navigate or update a different inbox lifetime.
 */
export function useFactoryIssueActions(input: {
  readonly settings: FactoryStartSettings | null;
  readonly onSettled: () => void;
  readonly scopeKey: string | null;
}) {
  const { settings, onSettled, scopeKey } = input;
  const registry = use(RegistryContext);
  const run = useAtomCommand(factoryEnvironment.start, { reportFailure: false });
  const openThread = useOpenFactoryThread();
  const lifetime = useRef<ActionLifetime | null>(null);
  const commandIds = useRef(new Map<string, string>());
  const [state, setState] = useState<{
    readonly key: string | null;
    readonly busyIssue: string | null;
    readonly review: FactoryIssueReview | null;
  }>({ key: scopeKey, busyIssue: null, review: null });
  if (state.key !== scopeKey) setState({ key: scopeKey, busyIssue: null, review: null });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps in-flight server commands tied to the mounted view that started them.
  useLayoutEffect(() => {
    if (scopeKey === null) {
      lifetime.current = null;
      return;
    }
    const current: ActionLifetime = { key: scopeKey, active: true, pending: false, review: null };
    lifetime.current = current;
    return () => {
      current.active = false;
      current.review = null;
    };
  }, [scopeKey]);

  const launch = useCallback(
    async (request: FactoryLaunchRequest, snapshot: FactoryIssueReviewSnapshot | null) => {
      const current = lifetime.current;
      if (
        current === null ||
        !current.active ||
        current.key !== scopeKey ||
        current.pending ||
        (current.review?.snapshot ?? null) !== snapshot ||
        current.review?.failure?.kind === "changed"
      )
        return;
      current.pending = true;
      setState({
        key: scopeKey,
        busyIssue: request.issueKey,
        review: current.review,
      });
      const result = await run({ environmentId: request.environmentId, input: request.input });
      current.pending = false;
      if (!current.active || lifetime.current !== current) return;
      if (result._tag === "Failure") {
        const failure = isAtomCommandInterrupted(result)
          ? null
          : describeFactoryFailure(
              squashAtomCommandFailure(result),
              "Couldn't start the task",
              request.displayName ?? undefined,
            );
        if (current.review !== null) {
          current.review = { ...current.review, failure };
        } else if (failure !== null) {
          Dialog.alert(failure.title, failure.detail);
        }
        setState({ key: scopeKey, busyIssue: null, review: current.review });
        // Refresh only the inbox. The source and input in an open review never change.
        onSettled();
        return;
      }
      current.review = null;
      setState({ key: scopeKey, busyIssue: null, review: null });
      commandIds.current.delete(request.key);
      onSettled();
      openThread(request.environmentId, result.value.threadId);
    },
    [onSettled, openThread, run, scopeKey],
  );

  /**
   * A listing row carries no body, and its revision covers only what the row showed, so a start
   * or restart first reads the issue as it is now: the review shows that read's title and body,
   * and the launch pins that read's revision, never the row's.
   */
  const beginReview = useCallback(
    async (
      target: FactoryIssueTarget,
      issueKey: string,
      requestFor: (revisionSource: FactoryIssue) => FactoryLaunchRequest,
      repository: FactoryRepository,
    ) => {
      const current = lifetime.current;
      if (
        current === null ||
        !current.active ||
        current.key !== scopeKey ||
        current.pending ||
        settings === null
      )
        return;
      current.pending = true;
      setState({ key: scopeKey, busyIssue: issueKey, review: null });
      const read = await executeAtomQuery(
        registry,
        factoryEnvironment.readIssue({
          environmentId: settings.environmentId,
          input: { projectId: settings.projectId, ...target },
        }),
        { refresh: true, reportFailure: false },
      );
      current.pending = false;
      if (!current.active || lifetime.current !== current) return;
      if (read._tag === "Failure") {
        if (!isAtomCommandInterrupted(read)) {
          const failure = describeFactoryFailure(
            squashAtomCommandFailure(read),
            "Couldn't read the issue",
            settings.displayName ?? undefined,
          );
          Dialog.alert(failure.title, failure.detail);
        }
        setState({ key: scopeKey, busyIssue: null, review: null });
        onSettled();
        return;
      }
      const fresh = read.value.issue;
      current.review = {
        snapshot: {
          issue: { ...fresh, labels: [...fresh.labels] },
          repository: { ...repository },
          modelLabel: settings.modelLabel,
          request: requestFor(fresh),
          titleText: factoryIssueReviewText(fresh.title),
          bodyText: fresh.body === null ? null : factoryIssueReviewText(fresh.body),
        },
        failure: null,
      };
      setState({ key: scopeKey, busyIssue: null, review: current.review });
    },
    [onSettled, registry, scopeKey, settings],
  );

  const perform = useCallback(
    (issue: FactoryIssue, action: FactoryIssueAction) => {
      const current = lifetime.current;
      if (
        action.kind === "unavailable" ||
        current === null ||
        !current.active ||
        current.key !== scopeKey ||
        current.pending ||
        current.review !== null
      )
        return;
      if (action.kind === "open") {
        if (settings === null) return;
        openThread(settings.environmentId, action.task.threadId);
        return;
      }
      if (settings === null) return;
      // Every launch path addresses the issue; `factoryIssueAction` already refuses issues the
      // server cannot address, so this only narrows the type.
      const target = factoryIssueTargetOf(issue, settings.factoryIssueKeys);
      if (target === null) return;
      const issueKey = "key" in target ? target.key : String(target.issueNumber);
      const reserved =
        action.kind === "resume" && issue.task?.status === "launching" ? issue.task : null;
      const modelSelection = reserved?.modelSelection ?? settings.modelSelection;
      if (modelSelection === null) {
        Dialog.alert(
          m(msg("Choose a model")),
          m(msg("Pick a model and provider before starting a task.")),
        );
        return;
      }
      const repository = settings.repository;
      if (repository === null) {
        Dialog.alert(
          m(msg("Repository unavailable")),
          m(msg("Refresh the inbox before starting a task.")),
        );
        return;
      }
      const restartDeleted = action.kind === "restart";
      const baseRef = reserved?.baseRef ?? settings.baseRef;
      const requestFor = (revisionSource: FactoryIssue): FactoryLaunchRequest => {
        const key = factoryIssueStartKey({
          environmentId: settings.environmentId,
          projectId: settings.projectId,
          expectedRepositoryKey: repository.canonicalKey,
          issueKey,
          expectedIssueRevision: revisionSource.revision,
          restartDeleted,
          previousThreadId: restartDeleted ? (revisionSource.task?.threadId ?? null) : null,
        });
        let commandId = commandIds.current.get(key);
        if (commandId === undefined) {
          commandId = uuidv4();
          commandIds.current.set(key, commandId);
        }
        return {
          key,
          issueKey,
          environmentId: settings.environmentId,
          displayName: settings.displayName,
          input: {
            commandId: CommandId.make(commandId),
            projectId: settings.projectId,
            ...target,
            expectedRepositoryKey: repository.canonicalKey,
            expectedIssueRevision: revisionSource.revision,
            modelSelection: {
              ...modelSelection,
              ...(modelSelection.options === undefined
                ? {}
                : { options: modelSelection.options.map((option) => ({ ...option })) }),
            },
            runtimeMode: reserved?.runtimeMode ?? settings.runtimeMode,
            interactionMode: reserved?.interactionMode ?? "default",
            ...(baseRef === null ? {} : { baseRef }),
            ...(restartDeleted ? { restartDeleted: true } : {}),
            creationSource: "mobile",
          },
        };
      };
      if (action.kind === "resume") {
        void launch(requestFor(issue), null);
        return;
      }
      void beginReview(target, issueKey, requestFor, repository);
    },
    [beginReview, launch, openThread, scopeKey, settings],
  );

  const snapshot = state.review?.snapshot ?? null;
  const confirmReview = useCallback(() => {
    if (snapshot !== null) void launch(snapshot.request, snapshot);
  }, [launch, snapshot]);

  const closeReview = useCallback(() => {
    const current = lifetime.current;
    if (
      current === null ||
      !current.active ||
      current.key !== scopeKey ||
      current.pending ||
      current.review?.snapshot !== snapshot
    )
      return;
    current.review = null;
    setState({ key: scopeKey, busyIssue: null, review: null });
  }, [scopeKey, snapshot]);

  return {
    busyIssue: state.key === scopeKey ? state.busyIssue : null,
    review: state.key === scopeKey ? state.review : null,
    perform,
    confirmReview,
    closeReview,
  };
}

/** The accepted commit of one launched task. Accept pins the head the reviewer was last shown: `expectedHeadSha` always comes from the last read, never a fresh one, so the server refuses rather than accepting a commit nobody saw. A failure keeps that read on screen with its explanation; only an explicit refresh replaces what the reviewer is looking at. */
export function useFactoryAcceptCommit(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, projectId, threadId } = input;
  const supported = useAtomValue(factoryAcceptanceSupportedAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canAccept = useAtomValue(factoryEnvironment.acceptCommit.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    supported && canRead
      ? factoryEnvironment.readAcceptance({ environmentId, input: { projectId, threadId } })
      : null,
  );
  const run = useAtomCommand(factoryEnvironment.acceptCommit, { reportFailure: false });
  const key = JSON.stringify([environmentId, projectId, threadId]);
  const lifetime = useRef<{ readonly key: string; active: boolean; pending: boolean } | null>(null);
  const [state, setState] = useState<{
    readonly key: string;
    readonly pending: boolean;
    readonly failure: FactoryFailure | null;
  }>({ key, pending: false, failure: null });
  if (state.key !== key) setState({ key, pending: false, failure: null });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps in-flight server commands tied to the mounted view that started them.
  useLayoutEffect(() => {
    const current = { key, active: true, pending: false };
    lifetime.current = current;
    return () => {
      current.active = false;
    };
  }, [key]);

  const liveHeadSha = query.data?.liveHeadSha ?? null;
  const refreshQuery = query.refresh;
  const accept = useCallback(
    async (supersede: boolean) => {
      const current = lifetime.current;
      if (current === null || !current.active || current.pending || liveHeadSha === null) return;
      current.pending = true;
      setState({ key: current.key, pending: true, failure: null });
      const result = await run({
        environmentId,
        input: {
          projectId,
          threadId,
          expectedHeadSha: liveHeadSha,
          evidenceRefs: [],
          ...(supersede ? { supersede: true } : {}),
        },
      });
      current.pending = false;
      if (!current.active || lifetime.current !== current) return;
      if (result._tag === "Failure") {
        const failure = isAtomCommandInterrupted(result)
          ? null
          : describeFactoryAcceptanceFailure(squashAtomCommandFailure(result));
        setState({ key: current.key, pending: false, failure });
        return;
      }
      setState({ key: current.key, pending: false, failure: null });
      refreshQuery();
    },
    [environmentId, liveHeadSha, projectId, refreshQuery, run, threadId],
  );

  const refresh = useCallback(() => {
    if (lifetime.current?.pending) return;
    setState({ key, pending: false, failure: null });
    refreshQuery();
  }, [key, refreshQuery]);

  const current = state.key === key ? state : { pending: false, failure: null };
  return {
    supported: supported && canRead,
    canAccept,
    view: query.data === null ? null : factoryAcceptanceView(query.data),
    loading: query.isPending,
    readError: query.error,
    pending: current.pending,
    failure: current.failure,
    accept,
    refresh,
  };
}

const NO_DELIVERY_PREVIEW = Atom.make(
  AsyncResult.initial<FactoryDeliveryPrepareResult, unknown>(false),
).pipe(Atom.withLabel("mobile-factory-delivery-preview:none"));

type DeliveryPreview = AsyncResult.AsyncResult<FactoryDeliveryPrepareResult, unknown>;

// Only a settled success is grantable: a failed re-prepare must not leave the previous digest
// looking current, and a preview that is still re-reading may be about to change.
function settledPreview(preview: DeliveryPreview): FactoryCommitDeliveryPrepareResult | null {
  if (preview._tag !== "Success" || preview.waiting) return null;
  // Pull request previews are asked with commit payloads, so an artifact answer is never this
  // hook's to grant.
  return isFactoryArtifactPrepareResult(preview.value) ? null : preview.value;
}

function describeDeliveryFailure(
  kind: FactoryDeliveryCommitKind,
  error: unknown,
  displayName: string,
) {
  return kind === "merge-pr"
    ? describeFactoryMergeFailure(error, displayName)
    : describeFactoryDeliveryFailure(error, displayName);
}

interface DeliveryState {
  readonly key: string;
  // The payload of the last explicit Prepare. Previewing is a read, but it runs only on request
  // so typing never asks the server to recompute a digest per keystroke.
  readonly previewed: FactoryDeliveryPublishPayload | null;
  readonly mergePreviewed: PullRequestMergeMethod | null;
  readonly pending: boolean;
  // Tagged so a merge refusal shows under Merge and a publish refusal under Pull request.
  readonly failure: {
    readonly kind: FactoryDeliveryCommitKind;
    readonly failure: FactoryFailure;
  } | null;
}

function emptyDeliveryState(key: string): DeliveryState {
  return { key, previewed: null, mergePreviewed: null, pending: false, failure: null };
}

/** Publishing one task's accepted commit as a pull request, then merging that pull request. Each grant is single-use over the exact preview the human last saw: it echoes that prepare's head and payload digest, never a fresh read, so a moved head, a moved pull request, or an edited payload is refused by the server instead of delivered. The server performs the push, the pull request, and the merge; this hook only previews, grants, and reconciles a lost response. */
export function useFactoryDelivery(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly displayName: string;
}) {
  const { environmentId, projectId, threadId, displayName } = input;
  const supported = useAtomValue(factoryDeliverySupportedAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canGrant = useAtomValue(factoryEnvironment.grantDelivery.permissionAtom(environmentId));
  const canReconcile = useAtomValue(
    factoryEnvironment.reconcileDelivery.permissionAtom(environmentId),
  );
  const readable = supported && canRead;
  const deliveries = useEnvironmentQuery(
    readable
      ? factoryEnvironment.readDeliveries({ environmentId, input: { projectId, threadId } })
      : null,
  );
  const runGrant = useAtomCommand(factoryEnvironment.grantDelivery, { reportFailure: false });
  const runReconcile = useAtomCommand(factoryEnvironment.reconcileDelivery, {
    reportFailure: false,
  });
  const key = JSON.stringify([environmentId, projectId, threadId]);
  const lifetime = useRef<{ readonly key: string; active: boolean; pending: boolean } | null>(null);
  const [state, setState] = useState<DeliveryState>(() => emptyDeliveryState(key));
  if (state.key !== key) setState(emptyDeliveryState(key));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps in-flight server commands tied to the mounted view that started them.
  useLayoutEffect(() => {
    const current = { key, active: true, pending: false };
    lifetime.current = current;
    return () => {
      current.active = false;
    };
  }, [key]);
  // A settled command only updates the lifetime that sent it.
  const update = useCallback(
    (stateKey: string, patch: Partial<Omit<DeliveryState, "key">>) =>
      setState((previous) => (previous.key === stateKey ? { ...previous, ...patch } : previous)),
    [],
  );

  const current = state.key === key ? state : emptyDeliveryState(key);
  const { previewed, mergePreviewed } = current;

  const previewAtom: Atom.Atom<DeliveryPreview> =
    readable && previewed !== null
      ? factoryEnvironment.prepareDelivery({
          environmentId,
          input: { projectId, threadId, kind: "publish-pr", payload: previewed },
        })
      : NO_DELIVERY_PREVIEW;
  const preview = useAtomValue(previewAtom);
  const refreshPreview = useAtomRefresh(previewAtom);
  const prepared = settledPreview(preview);
  const previewFailure =
    preview._tag === "Failure"
      ? describeFactoryDeliveryFailure(Cause.squash(preview.cause), displayName)
      : null;

  const mergePreviewAtom: Atom.Atom<DeliveryPreview> =
    readable && mergePreviewed !== null
      ? factoryEnvironment.prepareDelivery({
          environmentId,
          input: {
            projectId,
            threadId,
            kind: "merge-pr",
            payload: { mergeMethod: mergePreviewed },
          },
        })
      : NO_DELIVERY_PREVIEW;
  const mergePreview = useAtomValue(mergePreviewAtom);
  const refreshMergePreview = useAtomRefresh(mergePreviewAtom);
  const mergePrepared = settledPreview(mergePreview);
  const mergePreviewFailure =
    mergePreview._tag === "Failure"
      ? describeFactoryMergeFailure(Cause.squash(mergePreview.cause), displayName)
      : null;

  const intents = (deliveries.data?.intents ?? []).filter(isFactoryCommitIntent);
  const publishIntents = intents.filter((intent) => intent.kind === "publish-pr");
  const mergeIntents = intents.filter((intent) => intent.kind === "merge-pr");
  const liveIntent = publishIntents.find(isLiveFactoryDelivery) ?? null;
  const liveMergeIntent = mergeIntents.find(isLiveFactoryDelivery) ?? null;
  // Merging only ever targets a pull request this task already published.
  const published = publishIntents.some((intent) => intent.status === "confirmed");

  const prepare = useCallback(
    (payload: FactoryDeliveryPublishPayload) => {
      if (lifetime.current?.pending) return;
      const next = { ...payload, title: payload.title.trim() };
      update(key, { previewed: next, failure: null });
      // Preparing the same text again must still re-read the head and acceptance.
      if (previewed !== null && sameFactoryDeliveryPayload(previewed, next)) refreshPreview();
    },
    [key, previewed, refreshPreview, update],
  );

  const prepareMerge = useCallback(
    (mergeMethod: PullRequestMergeMethod) => {
      if (lifetime.current?.pending) return;
      update(key, { mergePreviewed: mergeMethod, failure: null });
      // Preparing the same method again must still re-read the pull request head and checks.
      if (mergePreviewed === mergeMethod) refreshMergePreview();
    },
    [key, mergePreviewed, refreshMergePreview, update],
  );

  const runGrantFor = useCallback(
    async (
      kind: FactoryDeliveryCommitKind,
      grantFrom: FactoryCommitDeliveryPrepareResult | null,
    ) => {
      const current = lifetime.current;
      if (current === null || !current.active || current.pending || grantFrom === null) return;
      current.pending = true;
      update(current.key, { pending: true, failure: null });
      const result = await runGrant({
        environmentId,
        input: {
          projectId,
          threadId,
          kind,
          // A fresh id per grant: a failed intent is not live, so granting again must create a
          // new intent rather than replay the failed one.
          commandId: uuidv4(),
          expectedHeadSha: grantFrom.headSha,
          expectedPayloadDigest: grantFrom.payloadDigest,
          payload: grantFrom.payload,
        },
      });
      current.pending = false;
      if (!current.active || lifetime.current !== current) return;
      const failure =
        result._tag === "Failure" && !isAtomCommandInterrupted(result)
          ? {
              kind,
              failure: describeDeliveryFailure(kind, squashAtomCommandFailure(result), displayName),
            }
          : null;
      update(current.key, { pending: false, failure });
    },
    [displayName, environmentId, projectId, runGrant, threadId, update],
  );

  const grant = useCallback(() => runGrantFor("publish-pr", prepared), [prepared, runGrantFor]);
  const grantMerge = useCallback(
    () => runGrantFor("merge-pr", mergePrepared),
    [mergePrepared, runGrantFor],
  );

  const reconcile = useCallback(
    async (intent: FactoryCommitDeliveryIntent) => {
      const current = lifetime.current;
      if (current === null || !current.active || current.pending) return;
      current.pending = true;
      update(current.key, { pending: true, failure: null });
      const result = await runReconcile({
        environmentId,
        input: { projectId, intentId: intent.id },
      });
      current.pending = false;
      if (!current.active || lifetime.current !== current) return;
      const failure =
        result._tag === "Failure" && !isAtomCommandInterrupted(result)
          ? {
              kind: intent.kind,
              failure: describeDeliveryFailure(
                intent.kind,
                squashAtomCommandFailure(result),
                displayName,
              ),
            }
          : null;
      update(current.key, { pending: false, failure });
    },
    [displayName, environmentId, projectId, runReconcile, update],
  );

  const refreshDeliveries = deliveries.refresh;
  const refresh = useCallback(() => {
    if (lifetime.current?.pending) return;
    update(key, { failure: null });
    refreshDeliveries();
    if (previewed !== null) refreshPreview();
    if (mergePreviewed !== null) refreshMergePreview();
  }, [
    key,
    mergePreviewed,
    previewed,
    refreshDeliveries,
    refreshMergePreview,
    refreshPreview,
    update,
  ]);

  const failureFor = (kind: FactoryDeliveryCommitKind) =>
    current.failure?.kind === kind ? current.failure.failure : null;
  return {
    supported: readable,
    canGrant,
    canReconcile,
    publishIntents,
    mergeIntents,
    liveIntent,
    liveMergeIntent,
    published,
    deliveriesLoading: deliveries.isPending,
    deliveriesError: deliveries.error,
    prepared,
    preparing: previewed !== null && preview.waiting,
    previewFailure,
    mergePrepared,
    mergePreparing: mergePreviewed !== null && mergePreview.waiting,
    mergePreviewFailure,
    pending: current.pending,
    failure: failureFor("publish-pr"),
    mergeFailure: failureFor("merge-pr"),
    prepare,
    prepareMerge,
    grant,
    grantMerge,
    reconcile,
    refresh,
  };
}
