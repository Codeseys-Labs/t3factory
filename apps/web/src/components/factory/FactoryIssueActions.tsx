import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationReadScope,
  CommandId,
  type EnvironmentId,
  type FactoryIssue,
  type FactoryIssueStartInput,
  type FactoryRepository,
  type IssueRef,
  type ModelSelection,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { useProjects, useServerConfigs } from "../../state/entities";
import {
  factoryEnvironment,
  useFactoryIssueKeysSupported,
  useFactoryReadinessSupported,
} from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { PullRequestSection } from "../pullRequest/PullRequestSummaryTab";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import {
  FactoryClaimIndicators,
  FactoryClaimWarning,
  FactoryClaimsUnavailableNote,
} from "./FactoryClaimIndicators";
import {
  claimsElsewhere,
  describeClaimsElsewhere,
  factoryClaimRowPresentation,
  originKeyForFactoryIssue,
} from "./factoryClaims.logic";
import {
  describeFactoryFailure,
  factoryIssueDisplayKey,
  factoryTaskPresentation,
  normalizeFactoryBaseRef,
  resolveFactoryIssueAction,
  resolveFactoryIssueSection,
  type FactoryFailure,
  type FactoryIssueTarget,
} from "./factoryIssues.logic";
import { FactoryIssueFrontier } from "./FactoryIssueFrontier";
import {
  FactoryLaunchFields,
  useFactoryLaunchDraft,
  useFactoryLaunchModelSettings,
} from "./FactoryLaunchControls";
import { FactoryReviewFailure, FactoryReviewSnapshot } from "./FactoryReview";
import { useFactoryClaims } from "./useFactoryClaims";

/**
 * The Factory's part of an issue: its task, claims and sub-issues, and the one place a task is
 * started from. Nothing renders unless the server runs the Factory and the issue is one it can
 * address, so trackers it cannot reach see the plain issue.
 */
export function FactoryIssueActions(props: {
  readonly environmentId: EnvironmentId;
  readonly reference: IssueRef;
}) {
  const { environmentId, reference } = props;
  const factoryIssues =
    useServerConfigs().get(environmentId)?.environment.capabilities.factoryIssues === true;
  const project = useProjects().find(
    (candidate) =>
      candidate.environmentId === environmentId && candidate.id === reference.projectId,
  );
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const factoryIssueKeys = useFactoryIssueKeysSupported(environmentId);
  const target = resolveFactoryIssueSection({
    factoryIssues,
    factoryIssueKeys,
    key: reference.key,
  });
  if (target === null || project === undefined || !canRead) return null;
  return <FactoryIssueSection environmentId={environmentId} project={project} target={target} />;
}

export function FactoryIssueSection(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly target: FactoryIssueTarget;
}) {
  const { environmentId, project, target } = props;
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const allProjects = useProjects();
  const readinessSupported = useFactoryReadinessSupported(environmentId);
  const query = useEnvironmentQuery(
    factoryEnvironment.readIssue({
      environmentId,
      input: { projectId: project.id, ...target },
    }),
  );
  const canStart = useAtomValue(factoryEnvironment.start.permissionAtom(environmentId));
  const runStart = useAtomCommand(factoryEnvironment.start, {
    label: "factory issue start",
    reportFailure: false,
  });
  const claims = useFactoryClaims({ environmentId, project });
  // Claims have no timer: every explicit refresh and every start observes them again with the issue.
  const refreshAll = () => {
    query.refresh();
    claims?.refresh();
  };

  // The dialog keeps the issue exactly as it was reviewed; a refresh never replaces it.
  const [dialog, setDialog] = useState<{
    readonly issue: FactoryIssue;
    readonly repository: FactoryRepository;
    readonly restart: boolean;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<FactoryFailure | null>(null);
  const startInFlight = useRef(false);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps in-flight server commands tied to the mounted view that started them.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const startIssue = async (
    issue: FactoryIssue,
    options: {
      readonly modelSelection: ModelSelection;
      readonly expectedRepositoryKey: string;
      readonly runtimeMode: FactoryIssueStartInput["runtimeMode"];
      readonly interactionMode: FactoryIssueStartInput["interactionMode"];
      readonly baseRef?: string;
      readonly restartDeleted: boolean;
    },
  ) => {
    // The server owns deduplication; this only stops the same client double-submitting.
    if (startInFlight.current) return;
    const input: FactoryIssueStartInput = {
      commandId: CommandId.make(randomUUID()),
      projectId: project.id,
      ...target,
      expectedRepositoryKey: options.expectedRepositoryKey,
      expectedIssueRevision: issue.revision,
      modelSelection: options.modelSelection,
      runtimeMode: options.runtimeMode,
      interactionMode: options.interactionMode,
      ...(options.baseRef !== undefined ? { baseRef: options.baseRef } : {}),
      ...(options.restartDeleted ? { restartDeleted: true } : {}),
    };
    startInFlight.current = true;
    setStarting(true);
    setStartFailure(null);
    const result = await runStart({ environmentId, input }).finally(() => {
      startInFlight.current = false;
      if (mounted.current) setStarting(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      refreshAll();
      setDialog(null);
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    setStartFailure(
      describeFactoryFailure(
        squashAtomCommandFailure(result),
        undefined,
        query.data?.capabilities.displayName,
        messages,
      ),
    );
    // The failure may mean the issue is stale (closed, deleted, already launched elsewhere).
    refreshAll();
  };

  const openTask = (task: NonNullable<FactoryIssue["task"]>) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, task.threadId)),
    });
  };

  const resume = (issue: FactoryIssue, repository: FactoryRepository) => {
    const task = issue.task;
    if (task === null || task.status !== "launching") return;
    void startIssue(issue, {
      modelSelection: task.modelSelection,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
      expectedRepositoryKey: repository.canonicalKey,
      restartDeleted: false,
    });
  };

  const failure =
    query.error === null
      ? null
      : describeFactoryFailure(
          query.failure,
          query.error,
          query.data?.capabilities.displayName,
          messages,
        );
  const data = failure === null ? query.data : null;
  const refreshing = query.isPending;

  const claimWarningFor = (issue: FactoryIssue, repository: FactoryRepository) =>
    claims === null
      ? null
      : describeClaimsElsewhere(
          claimsElsewhere(
            claims.claimsByEnvironment,
            originKeyForFactoryIssue(repository, issue),
            environmentId,
          ),
          claims.labelOf,
          messages,
        );

  const body = (() => {
    if (failure !== null) {
      return (
        <Alert variant={failure.kind === "unsupported" ? "info" : "error"}>
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      );
    }
    if (data === null) {
      return (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-8 w-full" />
        </div>
      );
    }
    const { issue, repository, capabilities } = data;
    const action = resolveFactoryIssueAction(issue, messages);
    const presentation = issue.task ? factoryTaskPresentation(issue.task.status, messages) : null;
    const taskProjectTitle =
      issue.task && issue.task.projectId !== project.id
        ? (allProjects.find(
            (candidate) =>
              candidate.environmentId === environmentId && candidate.id === issue.task?.projectId,
          )?.title ?? gt("another project"))
        : null;
    const originKey = originKeyForFactoryIssue(repository, issue);
    const claimWarning = claimWarningFor(issue, repository);
    const claimPresentation =
      claims === null
        ? null
        : factoryClaimRowPresentation({
            claimsByEnvironment: claims.claimsByEnvironment,
            conflicts: claims.conflicts,
            environmentId,
            originKey,
            task: issue.task,
            labelOf: claims.labelOf,
            resolve: messages,
          });
    const startDisabled = !canStart || starting;
    const needsStart =
      action.kind === "start" || action.kind === "resume" || action.kind === "restart";
    return (
      <>
        {!canStart && needsStart ? (
          <Alert variant="warning">
            <AlertDescription>
              <T>
                This connection cannot start tasks. Starting needs orchestration and source control
                write access; existing tasks can still be opened.
              </T>
            </AlertDescription>
          </Alert>
        ) : null}
        <FactoryClaimWarning message={claimWarning} />
        {presentation !== null ? (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={presentation.variant}>{presentation.label}</Badge>
              <span className="text-muted-foreground text-xs">{presentation.detail}</span>
            </div>
            {taskProjectTitle !== null ? (
              <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                <T>
                  Task lives in project <Var>{taskProjectTitle}</Var>.
                </T>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            <T>No Factory task has been started for this issue.</T>
          </p>
        )}
        {claimPresentation !== null ? (
          <FactoryClaimIndicators presentation={claimPresentation} />
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {action.kind === "start" ? (
            <Button
              size="sm"
              disabled={startDisabled}
              onClick={() => {
                setStartFailure(null);
                setDialog({ issue, repository, restart: false });
              }}
            >
              <T>Start task</T>
            </Button>
          ) : action.kind === "resume" ? (
            <Button
              size="sm"
              disabled={startDisabled}
              aria-busy={starting}
              onClick={() => resume(issue, repository)}
            >
              {starting ? <T>Resuming…</T> : <T>Resume launch</T>}
            </Button>
          ) : action.kind === "restart" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={startDisabled}
              onClick={() => {
                setStartFailure(null);
                setDialog({ issue, repository, restart: true });
              }}
            >
              <T>New attempt…</T>
            </Button>
          ) : action.kind === "open" ? (
            <Button size="sm" variant="outline" onClick={() => openTask(action.task)}>
              <T>Open thread</T>
            </Button>
          ) : null}
        </div>
        {action.kind === "unavailable" ? (
          <p className="text-muted-foreground text-xs">{action.reason}</p>
        ) : null}
        {startFailure !== null && dialog === null ? (
          <Alert variant="error">
            <AlertTitle>{startFailure.title}</AlertTitle>
            <AlertDescription>{startFailure.message}</AlertDescription>
          </Alert>
        ) : null}
        {issue.state === "open" &&
        issue.number !== null &&
        readinessSupported &&
        capabilities.subIssues ? (
          <FactoryIssueFrontier
            environmentId={environmentId}
            projectId={project.id}
            issueNumber={issue.number}
            displayName={capabilities.displayName}
          />
        ) : null}
      </>
    );
  })();

  return (
    <PullRequestSection
      title={gt("Factory")}
      actions={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Refresh Factory state")}
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={refreshAll}
        >
          <RefreshIcon size="sm" refreshing={refreshing} />
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <FactoryClaimsUnavailableNote note={claims?.unavailableNote ?? null} />
        {body}
        {dialog !== null ? (
          <FactoryStartDialog
            key={`${dialog.issue.key ?? dialog.issue.number}:${dialog.restart}`}
            environmentId={environmentId}
            project={project}
            issue={dialog.issue}
            restart={dialog.restart}
            repository={dialog.repository}
            canStart={canStart}
            pending={starting}
            failure={startFailure}
            claimWarning={claimWarningFor(dialog.issue, dialog.repository)}
            onClose={() => {
              setDialog(null);
              setStartFailure(null);
            }}
            onSubmit={(options) => {
              if (startFailure?.kind === "changed") return;
              void startIssue(dialog.issue, {
                ...options,
                expectedRepositoryKey: dialog.repository.canonicalKey,
                runtimeMode: "approval-required",
                interactionMode: "default",
              });
            }}
          />
        ) : null}
      </div>
    </PullRequestSection>
  );
}

function FactoryStartDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly issue: FactoryIssue;
  readonly restart: boolean;
  readonly repository: FactoryRepository;
  readonly canStart: boolean;
  readonly pending: boolean;
  readonly failure: FactoryFailure | null;
  readonly claimWarning: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (options: {
    readonly modelSelection: ModelSelection;
    readonly baseRef?: string;
    readonly restartDeleted: boolean;
  }) => void;
}) {
  const { issue, restart, pending } = props;
  const gt = useGT();
  const displayKey = factoryIssueDisplayKey(issue);
  // Defaults and model normalization stay pinned while the user reviews this issue.
  const settings = useFactoryLaunchModelSettings(props.environmentId, props.project);
  const draft = useFactoryLaunchDraft(settings);
  const { selection } = draft;
  const changed = props.failure?.kind === "changed";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {restart
              ? gt("Start a new attempt · {issueKey}", { issueKey: displayKey })
              : gt("Start task · {issueKey}", { issueKey: displayKey })}
          </DialogTitle>
          <DialogDescription>
            {restart ? (
              <T>
                The previous task's thread was deleted. Confirming creates a new isolated worktree
                and a new attempt for this issue.
              </T>
            ) : (
              <T>
                Creates a task in its own isolated git worktree and sends the issue to the selected
                agent.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <fieldset disabled={pending || changed} className="min-w-0 space-y-4">
            <p className="text-muted-foreground text-xs">
              <T>
                <Var>{`${props.repository.host}/${props.repository.repository}`}</Var> · task
                project <Var>{props.project.title}</Var>
              </T>
            </p>
            <FactoryClaimWarning message={props.claimWarning} />
            <FactoryReviewSnapshot
              heading={gt("Full issue snapshot")}
              intro={gt("Review the full title and description before confirming.")}
              fields={[
                {
                  label: gt("Title"),
                  text: issue.title,
                  emptyNote: gt("The source title is empty."),
                },
                {
                  label: gt("Description"),
                  text: issue.body,
                  emptyNote: gt("The source description is an empty string."),
                  missingNote: gt("This issue has no description. The source body is null."),
                },
              ]}
            />
            <FactoryLaunchFields
              environmentId={props.environmentId}
              disabled={pending || changed}
              draft={draft}
              untrustedText={gt("Issue text")}
            />
          </fieldset>
        </DialogPanel>
        {props.failure ? (
          <FactoryReviewFailure
            failure={props.failure}
            changed={changed}
            staleHint={gt(
              "This snapshot is no longer current. Close this dialog and reopen the issue to review the refreshed content before starting new work.",
            )}
          />
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={pending} />}>
            <T>Cancel</T>
          </DialogClose>
          <Button
            size="sm"
            disabled={!props.canStart || pending || changed || selection === null}
            aria-busy={pending}
            onClick={() => {
              if (!props.canStart || pending || changed || selection === null) return;
              const normalized = normalizeFactoryBaseRef(draft.baseRef);
              props.onSubmit({
                modelSelection: selection,
                restartDeleted: restart,
                ...(normalized !== undefined ? { baseRef: normalized } : {}),
              });
            }}
          >
            {pending ? <T>Starting…</T> : restart ? <T>Start new attempt</T> : <T>Start task</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
