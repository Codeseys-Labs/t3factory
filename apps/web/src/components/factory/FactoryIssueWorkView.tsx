import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  FactoryAcceptanceError,
  type EnvironmentId,
  type FactoryIssue,
  type FactoryIssueCapabilities,
  type FactoryIssueTask,
  type FactoryReadinessOverrideId,
  type FactoryRepository,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { ChevronDownIcon, CircleDotIcon } from "lucide-react";
import { Fragment, useContext, useEffect, useId, useRef, useState } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { m, type MessageResolver } from "../../i18n/messages";
import { randomUUID } from "../../lib/utils";
import { factoryEnvironment, useFactoryReadinessSupported } from "../../state/factory";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { RelativeTime } from "../RelativeTime";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button, InlineButton } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { FactoryClaimIndicators } from "./FactoryClaimIndicators";
import { FactoryDeliveryPanel } from "./FactoryDeliveryPanel";
import { factoryClaimRowPresentation, originKeyForFactoryIssue } from "./factoryClaims.logic";
import { factoryPublishUnsupportedMessage } from "./factoryDelivery.logic";
import {
  FACTORY_OVERRIDE_ACTIONS,
  buildFactoryReadinessOverrideInput,
  describeFactoryFailure,
  factoryBlockersUnsupportedMessage,
  factoryIssueDisplayKey,
  factoryIssueKeyOf,
  factoryReadinessPresentation,
  factoryTaskPresentation,
  resolveFactoryIssueAction,
  safeExternalUrl,
  type FactoryFailure,
  type FactoryReadinessEdgeRow,
  type FactoryReadinessOverrideAction,
  type FactoryReadinessTone,
} from "./factoryIssues.logic";
import { groupFactoryIssuesByStage, type FactoryIssueLayout } from "./factoryIssues.views";
import { FactoryIssueFrontier } from "./FactoryIssueFrontier";
import { FactoryReadinessOverrideDialog } from "./FactoryReadinessOverrideDialog";
import type { FactoryClaimsView } from "./useFactoryClaims";

const MAX_VISIBLE_LABELS = 5;

type FactoryIssueWorkViewProps = {
  readonly environmentId: EnvironmentId;
  readonly layout: FactoryIssueLayout;
  readonly issues: ReadonlyArray<FactoryIssue>;
  readonly selectedProjectId: ProjectId;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
  readonly refreshing: boolean;
  /** Null when the environment does not advertise claims, which shows no claim UI at all. */
  readonly claims: FactoryClaimsView | null;
  readonly repository: FactoryRepository;
  readonly capabilities: FactoryIssueCapabilities;
  /** Reading an issue and starting a task on it happen in the Issues panel, not here. */
  readonly onOpenIssue: (issue: FactoryIssue) => void;
  readonly onOpenTask: (task: FactoryIssueTask) => void;
};

export function FactoryIssueWorkView(props: FactoryIssueWorkViewProps) {
  const gt = useGT();
  const messages = useMessages();
  // The parent keys this component by repository and page, but not presentation layout.
  const [expandedIssues, setExpandedIssues] = useState<ReadonlySet<string>>(() => new Set());
  const readinessSupported = useFactoryReadinessSupported(props.environmentId);
  const acceptanceSupported = useAtomValue(
    environmentPresentations.presentationAtom(props.environmentId),
    (presentation) =>
      presentation?.serverConfig?.environment.capabilities.factoryAcceptance === true,
  );
  const deliverySupported = useAtomValue(
    environmentPresentations.presentationAtom(props.environmentId),
    (presentation) => presentation?.serverConfig?.environment.capabilities.factoryDelivery === true,
  );

  const renderIssue = (issue: FactoryIssue) => {
    const identity = factoryIssueKeyOf(issue) ?? issue.url;
    return (
      <FactoryIssueEntry
        key={identity}
        layout={props.layout}
        environmentId={props.environmentId}
        claims={props.claims}
        repository={props.repository}
        capabilities={props.capabilities}
        readinessSupported={readinessSupported}
        acceptanceSupported={acceptanceSupported}
        deliverySupported={deliverySupported}
        issue={issue}
        selectedProjectId={props.selectedProjectId}
        projectTitleById={props.projectTitleById}
        onOpenIssue={props.onOpenIssue}
        onOpenTask={props.onOpenTask}
        expanded={expandedIssues.has(identity)}
        onToggleDetails={() => {
          setExpandedIssues((current) => {
            const next = new Set(current);
            if (next.has(identity)) next.delete(identity);
            else next.add(identity);
            return next;
          });
        }}
      />
    );
  };

  return (
    <div
      className="min-w-0 max-w-full data-[refreshing=true]:opacity-70"
      data-refreshing={props.refreshing}
      aria-busy={props.refreshing}
    >
      {props.layout === "table" ? (
        <div
          className="max-w-full overflow-x-auto rounded-lg border border-border/60 focus-visible:outline-2 focus-visible:outline-ring"
          role="region"
          aria-label={gt("Issues table, this page only")}
          tabIndex={0}
        >
          <table className="w-full min-w-5xl text-left text-sm">
            <caption className="sr-only">
              <T>Issues on this page</T>
            </caption>
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th scope="col" className="p-3 font-medium">
                  <T>Issue</T>
                </th>
                <th scope="col" className="p-3 font-medium">
                  <T>Source state</T>
                </th>
                <th scope="col" className="p-3 font-medium">
                  <T>Task state</T>
                </th>
                <th scope="col" className="p-3 font-medium">
                  <T>Labels</T>
                </th>
                <th scope="col" className="p-3 font-medium">
                  <T>Updated</T>
                </th>
                <th scope="col" className="p-3 font-medium">
                  <T>Actions</T>
                </th>
              </tr>
            </thead>
            <tbody>{props.issues.map(renderIssue)}</tbody>
          </table>
        </div>
      ) : (
        <div
          className="flex max-w-full items-start gap-3 overflow-x-auto pb-2 focus-visible:outline-2 focus-visible:outline-ring"
          role="region"
          aria-label={gt("Task stages, this page only")}
          tabIndex={0}
        >
          {groupFactoryIssuesByStage(props.issues).map((group) => {
            if (group.issues.length === 0) return null;
            const label =
              group.stage === "none"
                ? gt("No task")
                : factoryTaskPresentation(group.stage, messages).label;
            return (
              <section key={group.stage} className="w-80 shrink-0 space-y-2" aria-label={label}>
                <h3 className="flex items-center justify-between gap-2 px-1 text-sm font-medium">
                  <span>{label}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    <T>
                      <Var>{group.issues.length}</Var> on this page
                    </T>
                  </span>
                </h3>
                <ul className="flex flex-col gap-2">{group.issues.map(renderIssue)}</ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FactoryIssueEntry(
  props: Omit<FactoryIssueWorkViewProps, "issues" | "refreshing"> & {
    readonly issue: FactoryIssue;
    readonly expanded: boolean;
    readonly readinessSupported: boolean;
    readonly acceptanceSupported: boolean;
    readonly deliverySupported: boolean;
    readonly onToggleDetails: () => void;
  },
) {
  const gt = useGT();
  const messages = useMessages();
  const { issue, expanded } = props;
  const detailsId = useId();
  const action = resolveFactoryIssueAction(issue, messages);
  const presentation = issue.task ? factoryTaskPresentation(issue.task.status, messages) : null;
  const ownerTitle =
    issue.task && issue.task.projectId !== props.selectedProjectId
      ? (props.projectTitleById.get(issue.task.projectId) ?? gt("another project"))
      : null;
  const href = safeExternalUrl(issue.url);
  const displayKey = factoryIssueDisplayKey(issue);
  const showReadiness = issue.state === "open" && props.readinessSupported;

  const identity = (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
      <InlineButton
        className="min-w-0 shrink text-left [--inline-button-text-align:left] [--inline-button-white-space:normal] [overflow-wrap:anywhere]"
        onClick={() => props.onOpenIssue(issue)}
      >
        {issue.title}
      </InlineButton>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-muted-foreground text-xs underline-offset-4 hover:underline"
        >
          {displayKey}
        </a>
      ) : (
        <span className="shrink-0 text-muted-foreground text-xs">{displayKey}</span>
      )}
    </div>
  );
  const sourceState = (
    <Badge variant={issue.state === "open" ? "outline" : "secondary"}>
      <CircleDotIcon />
      {issue.state === "open" ? (
        <T context="issue state">Open</T>
      ) : (
        <T context="issue state">Closed</T>
      )}
    </Badge>
  );
  const updated = (
    <span className="text-muted-foreground text-xs">
      <RelativeTime timestamp={issue.updatedAt} />
    </span>
  );
  const labels =
    issue.labels.length > 0 ? (
      <div className="flex flex-wrap gap-1">
        {issue.labels.slice(0, MAX_VISIBLE_LABELS).map((label) => (
          <Badge key={label} variant="outline" size="sm">
            <span className="max-w-40 truncate">{label}</span>
          </Badge>
        ))}
        {issue.labels.length > MAX_VISIBLE_LABELS ? (
          <Badge variant="outline" size="sm">
            +{issue.labels.length - MAX_VISIBLE_LABELS}
          </Badge>
        ) : null}
      </div>
    ) : null;
  const taskState = presentation ? (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant={presentation.variant}>{presentation.label}</Badge>
      <span className="text-muted-foreground text-xs">{presentation.detail}</span>
      {ownerTitle ? (
        <span className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
          <T>
            Task lives in project <Var>{ownerTitle}</Var>.
          </T>
        </span>
      ) : null}
    </div>
  ) : (
    <Badge variant="outline">
      <T>No task</T>
    </Badge>
  );
  const claimPresentation =
    props.claims === null
      ? null
      : factoryClaimRowPresentation({
          claimsByEnvironment: props.claims.claimsByEnvironment,
          conflicts: props.claims.conflicts,
          environmentId: props.environmentId,
          originKey: originKeyForFactoryIssue(props.repository, issue),
          task: issue.task,
          labelOf: props.claims.labelOf,
          resolve: messages,
        });
  const taskStatus = (
    <>
      {taskState}
      {claimPresentation !== null ? (
        <FactoryClaimIndicators presentation={claimPresentation} />
      ) : null}
      {issue.task?.threadId && props.acceptanceSupported ? (
        <FactoryAcceptedCommit
          key={`${props.environmentId}:${issue.task.projectId}:${issue.task.threadId}`}
          environmentId={props.environmentId}
          projectId={issue.task.projectId}
          threadId={issue.task.threadId}
          deliverySupported={props.deliverySupported}
          capabilities={props.capabilities}
          issueTitle={issue.title}
          issueUrl={issue.url}
        />
      ) : null}
    </>
  );
  const actions = (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {showReadiness ? (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={expanded ? detailsId : undefined}
            aria-label={
              expanded
                ? gt("Hide readiness of issue {issueKey}", { issueKey: displayKey })
                : gt("Show readiness of issue {issueKey}", { issueKey: displayKey })
            }
            onClick={props.onToggleDetails}
          >
            <ChevronDownIcon className={expanded ? "rotate-180" : undefined} />
            <T>Readiness</T>
          </Button>
        ) : null}
        {action.kind === "start" ? (
          <Button size="sm" onClick={() => props.onOpenIssue(issue)}>
            <T>Review and start</T>
          </Button>
        ) : action.kind === "resume" ? (
          <Button size="sm" onClick={() => props.onOpenIssue(issue)}>
            <T>Review and resume</T>
          </Button>
        ) : action.kind === "restart" ? (
          <Button size="sm" variant="outline" onClick={() => props.onOpenIssue(issue)}>
            <T>Review new attempt</T>
          </Button>
        ) : action.kind === "open" ? (
          <Button size="sm" variant="outline" onClick={() => props.onOpenTask(action.task)}>
            <T>Open thread</T>
          </Button>
        ) : null}
      </div>
      {action.kind === "unavailable" ? (
        <p className="text-muted-foreground text-xs">{action.reason}</p>
      ) : null}
    </div>
  );
  const details =
    expanded && showReadiness ? (
      <div id={detailsId} className="min-w-0">
        {props.capabilities.blockedBy === "none" || issue.number === null ? (
          <p className="mt-1 border-border/60 border-t pt-3 text-muted-foreground text-xs">
            {factoryBlockersUnsupportedMessage(props.capabilities.displayName, messages)}
          </p>
        ) : (
          <FactoryIssueBlockers
            environmentId={props.environmentId}
            projectId={props.selectedProjectId}
            issueNumber={issue.number}
            displayName={props.capabilities.displayName}
          />
        )}
        {props.capabilities.subIssues && issue.number !== null ? (
          <FactoryIssueFrontier
            environmentId={props.environmentId}
            projectId={props.selectedProjectId}
            issueNumber={issue.number}
            displayName={props.capabilities.displayName}
          />
        ) : null}
      </div>
    ) : null;

  if (props.layout === "table") {
    return (
      <Fragment>
        <tr className="border-b border-border/60 align-top">
          <th scope="row" className="min-w-56 max-w-72 p-3 text-left font-normal">
            {identity}
          </th>
          <td className="p-3">{sourceState}</td>
          <td className="min-w-56 max-w-72 p-3">
            <div className="space-y-1.5">{taskStatus}</div>
          </td>
          <td className="min-w-40 max-w-56 p-3">{labels}</td>
          <td className="whitespace-nowrap p-3">{updated}</td>
          <td className="min-w-56 p-3">{actions}</td>
        </tr>
        {details ? (
          <tr className="border-b border-border/60">
            <td colSpan={6} className="p-3">
              {details}
            </td>
          </tr>
        ) : null}
      </Fragment>
    );
  }

  return (
    <li className="min-w-0 rounded-lg border border-border/60 bg-card p-3">
      <div className="space-y-3">
        <div className="min-w-0 flex-1 basis-48 space-y-1.5">
          {identity}
          <div className="flex flex-wrap items-center gap-2">
            {sourceState}
            <span className="text-muted-foreground text-xs">
              <T>
                updated <Var>{updated}</Var>
              </T>
            </span>
          </div>
          {labels}
          {taskStatus}
        </div>
        {actions}
      </div>
      {details ? <div className="mt-3">{details}</div> : null}
    </li>
  );
}

const isFactoryAcceptanceError = Schema.is(FactoryAcceptanceError);

function acceptanceFailureMessage(
  error: unknown,
  resolve: MessageResolver = m,
  fallbackMessage?: string,
): string {
  if (isFactoryAcceptanceError(error)) {
    switch (error.reason) {
      case "head-moved":
        return resolve(msg("The head moved while you were reviewing. Refresh and review again."));
      case "already-accepted":
        return resolve(
          msg(
            "This task already has an accepted commit. Refresh and use Re-accept at current head if it has changed.",
          ),
        );
      case "worktree-unavailable":
        return resolve(
          msg(
            "The worktree or live head is unavailable. Restore the worktree and refresh to accept a commit.",
          ),
        );
      case "unknown-thread":
        return resolve(msg("This thread is no longer available."));
      case "not-a-factory-task":
        return resolve(msg("This thread is not a claimed Factory task."));
    }
  }
  return describeFactoryFailure(error, fallbackMessage, undefined, resolve).message;
}

function FactoryAcceptedCommit(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly deliverySupported: boolean;
  readonly capabilities: FactoryIssueCapabilities;
  readonly issueTitle: string;
  readonly issueUrl: string;
}) {
  const { environmentId, projectId, threadId } = props;
  const gt = useGT();
  const messages = useMessages();
  const registry = useContext(RegistryContext);
  const headingId = useId();
  const disabledReasonId = useId();
  const query = useEnvironmentQuery(
    factoryEnvironment.readAcceptance({ environmentId, input: { projectId, threadId } }),
  );
  const canAccept = useAtomValue(factoryEnvironment.acceptCommit.permissionAtom(environmentId));
  const runAccept = useAtomCommand(factoryEnvironment.acceptCommit, {
    label: "factory accept commit",
    reportFailure: false,
  });
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps in-flight server commands tied to the mounted view that started them.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const data = query.data;
  const acceptance = data?.acceptance ?? null;
  const liveHeadSha = data?.liveHeadSha ?? null;
  const moved = acceptance !== null && data?.current === false;
  const readFailure =
    query.error === null ? null : acceptanceFailureMessage(query.failure, messages, query.error);
  const disabledReason = !canAccept
    ? gt("Accepting a commit needs operate permission on this environment.")
    : readFailure !== null
      ? readFailure
      : query.isPending || data === null
        ? gt("Reading the current head…")
        : liveHeadSha === null
          ? gt(
              "The worktree or live head is unavailable. Restore the worktree and refresh to accept a commit.",
            )
          : failure !== null
            ? gt("Refresh and review the current head before accepting again.")
            : null;

  const accept = async () => {
    if (inFlight.current || disabledReason !== null || liveHeadSha === null) return;
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    const result = await runAccept({
      environmentId,
      input: {
        projectId,
        threadId,
        // Only the observed head is eligible; the server rejects a concurrent head change.
        expectedHeadSha: liveHeadSha,
        evidenceRefs: [],
        ...(moved ? { supersede: true } : {}),
      },
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      query.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      setFailure(acceptanceFailureMessage(squashAtomCommandFailure(result), messages));
    }
  };

  return (
    <div role="group" aria-labelledby={headingId} aria-busy={saving || query.isPending}>
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={headingId} className="font-medium text-sm">
            <T>Accepted commit</T>
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={saving || query.isPending}
            aria-label={gt("Refresh accepted commit")}
            onClick={() => {
              setFailure(null);
              query.refresh();
            }}
          >
            <T>Refresh</T>
          </Button>
        </div>
        {acceptance !== null ? (
          <p className="text-muted-foreground text-xs">
            <T>
              <code>
                <Var>{acceptance.headSha.slice(0, 7)}</Var>
              </code>
              {" · "}
              <time dateTime={acceptance.acceptedAt}>
                <Var>{new Date(acceptance.acceptedAt).toLocaleString()}</Var>
              </time>
              {" · "}
              <Var>{acceptance.evidenceRefs.length}</Var> evidence references
            </T>
          </p>
        ) : data !== null ? (
          <p className="text-muted-foreground text-xs">
            <T>No commit accepted yet.</T>
          </p>
        ) : null}
        {moved ? (
          <Alert variant="warning">
            <AlertDescription>
              <T>Head moved since acceptance</T>
            </AlertDescription>
          </Alert>
        ) : null}
        {(acceptance === null || moved) && liveHeadSha !== null ? (
          <p className="text-muted-foreground text-xs">
            <T>
              Current head{" "}
              <code>
                <Var>{liveHeadSha.slice(0, 7)}</Var>
              </code>
            </T>
          </p>
        ) : null}
        {failure !== null ? (
          <Alert variant="error">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        ) : null}
        {acceptance === null || moved ? (
          <Button
            size="sm"
            variant="outline"
            disabled={saving || disabledReason !== null}
            aria-busy={saving}
            aria-describedby={disabledReason !== null ? disabledReasonId : undefined}
            onClick={() => void accept()}
          >
            {saving ? (
              <T>Accepting…</T>
            ) : moved ? (
              <T>Re-accept at current head</T>
            ) : (
              <T>Accept this commit</T>
            )}
          </Button>
        ) : null}
        {disabledReason !== null ? (
          <p id={disabledReasonId} className="text-muted-foreground text-xs" role="status">
            {disabledReason}
          </p>
        ) : null}
      </div>
      {props.deliverySupported && acceptance !== null && data?.current === true ? (
        props.capabilities.publish ? (
          <FactoryDeliveryPanel
            key={acceptance.id}
            environmentId={environmentId}
            projectId={projectId}
            threadId={threadId}
            issueTitle={props.issueTitle}
            issueUrl={props.issueUrl}
            acceptanceCurrent={data.current && readFailure === null && !query.isPending}
            capabilities={props.capabilities}
            onGranted={() => {
              registry.refresh(
                factoryEnvironment.readDeliveries({
                  environmentId,
                  input: { projectId, threadId },
                }),
              );
            }}
          />
        ) : (
          <p className="mt-3 text-muted-foreground text-xs">
            {factoryPublishUnsupportedMessage(props.capabilities.displayName, messages)}
          </p>
        )
      ) : null}
    </div>
  );
}

const READINESS_ALERT_VARIANT = {
  success: "success",
  warning: "warning",
  info: "info",
  neutral: "default",
} as const satisfies Record<FactoryReadinessTone, "success" | "warning" | "info" | "default">;

/** The edge exactly as the reviewer saw it; a refreshed table never changes what is confirmed. */
type PendingOverride = {
  readonly row: FactoryReadinessEdgeRow;
  readonly action: FactoryReadinessOverrideAction;
};

/**
 * Observed blocker evidence for one open issue. It mounts only while Details is expanded, so the
 * read happens once per expand: collapsing unmounts the query and expanding observes again.
 * Nothing here reaches Start; the verdict is information and never a gate. Disputes and waivers
 * are the reviewer's recorded decisions about single edges: they change this verdict only.
 */
function FactoryIssueBlockers(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly issueNumber: number;
  readonly displayName: string;
}) {
  const { environmentId, projectId, issueNumber, displayName } = props;
  const gt = useGT();
  const messages = useMessages();
  const headingId = useId();
  const nowMs = useNowSecond();
  const query = useEnvironmentQuery(
    factoryEnvironment.readIssueReadiness({
      environmentId,
      input: { projectId, issueNumber },
    }),
  );
  const canOverride = useAtomValue(
    factoryEnvironment.setIssueReadinessOverride.permissionAtom(environmentId),
  );
  const canRevoke = useAtomValue(
    factoryEnvironment.revokeIssueReadinessOverride.permissionAtom(environmentId),
  );
  const runSet = useAtomCommand(factoryEnvironment.setIssueReadinessOverride, {
    label: "factory readiness override",
    reportFailure: false,
  });
  const runRevoke = useAtomCommand(factoryEnvironment.revokeIssueReadinessOverride, {
    label: "factory readiness override revoke",
    reportFailure: false,
  });
  const [dialog, setDialog] = useState<PendingOverride | null>(null);
  const [saving, setSaving] = useState(false);
  const [revokingId, setRevokingId] = useState<FactoryReadinessOverrideId | null>(null);
  const [dialogFailure, setDialogFailure] = useState<FactoryFailure | null>(null);
  const [revokeFailure, setRevokeFailure] = useState<FactoryFailure | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps in-flight server commands tied to the mounted view that started them.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const failure =
    query.error === null
      ? null
      : describeFactoryFailure(query.failure, query.error, displayName, messages);
  const presentation =
    failure === null && query.data !== null
      ? factoryReadinessPresentation(query.data.readiness, nowMs, displayName, messages)
      : null;
  const refreshing = query.isPending;
  const busy = saving || revokingId !== null || refreshing;
  const hasControls =
    presentation?.edgeRows.some((row) => row.overrideAction !== null || row.overrideId !== null) ??
    false;
  const hasNewDecision = presentation?.edgeRows.some((row) => row.overrideAction !== null) ?? false;

  const submitOverride = async (pending: PendingOverride, reason: string) => {
    // The server owns deduplication; this only stops the same client double-submitting.
    if (inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setDialogFailure(null);
    const result = await runSet({
      environmentId,
      input: buildFactoryReadinessOverrideInput({
        commandId: CommandId.make(randomUUID()),
        projectId,
        issueNumber,
        row: pending.row,
        action: pending.action,
        reason,
      }),
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      setDialog(null);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    // The command observes the issue again, so the table behind the dialog already shows the
    // current edge while the dialog keeps the one that was reviewed.
    setDialogFailure(
      describeFactoryFailure(squashAtomCommandFailure(result), undefined, displayName, messages),
    );
  };

  const revoke = async (overrideId: FactoryReadinessOverrideId) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRevokingId(overrideId);
    setRevokeFailure(null);
    const result = await runRevoke({
      environmentId,
      input: { commandId: CommandId.make(randomUUID()), projectId, issueNumber, overrideId },
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setRevokingId(null);
    });
    if (!mounted.current) return;
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    setRevokeFailure(
      describeFactoryFailure(squashAtomCommandFailure(result), undefined, displayName, messages),
    );
  };

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      aria-busy={refreshing}
      className="mt-4 space-y-2 border-border/60 border-t pt-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={headingId} className="font-medium text-sm">
          <T>Blockers</T>
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setRevokeFailure(null);
            query.refresh();
          }}
          disabled={refreshing}
          aria-label={gt("Refresh blockers for issue #{issueNumber}", { issueNumber })}
        >
          <RefreshIcon size="sm" refreshing={refreshing} />
          <T>Refresh</T>
        </Button>
      </div>
      {failure !== null ? (
        <Alert variant="error">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : presentation === null ? (
        <p className="text-muted-foreground text-sm" role="status">
          <T>Observing blockers…</T>
        </p>
      ) : (
        <>
          {/* A group, not the default alert role: the relative time changes every minute and must not be re-announced. */}
          <Alert variant={READINESS_ALERT_VARIANT[presentation.tone]} role="group">
            <AlertDescription>{presentation.label}</AlertDescription>
          </Alert>
          {revokeFailure !== null ? (
            <Alert variant="error">
              <AlertTitle>{revokeFailure.title}</AlertTitle>
              <AlertDescription>{revokeFailure.message}</AlertDescription>
            </Alert>
          ) : null}
          {presentation.edgeRows.length > 0 ? (
            <Table>
              <caption className="sr-only">
                <T>
                  Blockers of issue #<Var>{issueNumber}</Var>
                </T>
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">
                    <T>Blocker</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Title</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>State</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Resolution</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Status</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Override</T>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {presentation.edgeRows.map((row) => {
                  const action = row.overrideAction;
                  const overrideId = row.overrideId;
                  const actionLabel =
                    action === null ? null : messages(FACTORY_OVERRIDE_ACTIONS[action].buttonLabel);
                  return (
                    <TableRow key={row.key}>
                      <TableCell>
                        {row.url !== null ? (
                          <a
                            href={row.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline-offset-4 hover:underline"
                          >
                            {row.locator}
                          </a>
                        ) : (
                          row.locator
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="min-w-40 max-w-96 whitespace-normal [overflow-wrap:anywhere]">
                          {row.title}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.stateLabel}
                        {row.closedAt !== null ? (
                          <>
                            {" · "}
                            <time dateTime={row.closedAt}>
                              <RelativeTime timestamp={row.closedAt} />
                            </time>
                          </>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div className="max-w-96 whitespace-normal [overflow-wrap:anywhere]">
                          <div>{row.resolutionLabel}</div>
                          {row.overrideLabel !== null ? (
                            <div className="text-muted-foreground">{row.overrideLabel}</div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell>{row.statusLabel}</TableCell>
                      <TableCell>
                        {action !== null && actionLabel !== null ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={
                              !canOverride || presentation.overridesLockedReason !== null || busy
                            }
                            aria-label={gt("{action} blocker {locator}", {
                              action: actionLabel,
                              locator: row.locator,
                            })}
                            onClick={() => {
                              setRevokeFailure(null);
                              setDialogFailure(null);
                              setDialog({ row, action });
                            }}
                          >
                            {actionLabel}
                          </Button>
                        ) : overrideId !== null ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={!canRevoke || busy}
                            aria-busy={revokingId === overrideId}
                            aria-label={gt("Revoke override on blocker {locator}", {
                              locator: row.locator,
                            })}
                            onClick={() => void revoke(overrideId)}
                          >
                            {revokingId === overrideId ? <T>Revoking…</T> : <T>Revoke</T>}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : null}
          {hasNewDecision && presentation.overridesLockedReason !== null ? (
            <p className="text-muted-foreground text-xs" role="status">
              {presentation.overridesLockedReason}
            </p>
          ) : null}
          {hasControls && (!canOverride || !canRevoke) ? (
            <p className="text-muted-foreground text-xs">
              <T>Recording or revoking overrides needs operate permission on this environment.</T>
            </p>
          ) : null}
          {presentation.inactiveOverrides.length > 0 ? (
            <div className="space-y-1">
              <p className="font-medium text-xs">
                <T>Past overrides</T>
              </p>
              <ul className="space-y-1 text-muted-foreground text-xs">
                {presentation.inactiveOverrides.map((override) => (
                  <li key={override.key} className="flex flex-wrap items-baseline gap-x-2">
                    <Badge variant="outline" size="sm">
                      {override.statusLabel}
                    </Badge>
                    <span className="[overflow-wrap:anywhere]">
                      <T>
                        <Var>{override.kindLabel}</Var> on <Var>{override.locator}</Var>:{" "}
                        <Var>{override.reason}</Var>
                      </T>
                    </span>
                    <span>
                      {override.revokedAt !== null ? (
                        <T>
                          revoked{" "}
                          <Var>
                            <RelativeTime timestamp={override.revokedAt} />
                          </Var>
                        </T>
                      ) : (
                        <T>
                          recorded{" "}
                          <Var>
                            <RelativeTime timestamp={override.createdAt} />
                          </Var>
                        </T>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {gt(
              "Observed from {displayName} blocked-by links. Evidence only: it never allows or prevents starting work. A dispute or waiver records your decision here and changes nothing on {displayName}. Refresh observes again.",
              { displayName },
            )}
          </p>
        </>
      )}
      {dialog !== null ? (
        <FactoryReadinessOverrideDialog
          row={dialog.row}
          action={dialog.action}
          displayName={displayName}
          canOperate={canOverride}
          pending={saving}
          failure={dialogFailure}
          onClose={() => {
            setDialog(null);
            setDialogFailure(null);
          }}
          onSubmit={(reason) => void submitOverride(dialog, reason)}
        />
      ) : null}
    </div>
  );
}
