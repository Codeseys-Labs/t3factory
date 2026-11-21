import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  FACTORY_DELIVERY_BODY_MAX_CHARS,
  FACTORY_DELIVERY_TITLE_MAX_CHARS,
  type EnvironmentId,
  type FactoryDeliveryPrepareInput,
  type FactoryIssueCapabilities,
  type ProjectId,
  type PullRequestMergeMethod,
  type ThreadId,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { CircleDotIcon } from "lucide-react";
import { useContext, useEffect, useId, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { factoryEnvironment } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  canGrantFactoryDelivery,
  commitDeliveryPrepareResult,
  describeDeliveryStatus,
  factoryDeliveryFailureMessage,
  factoryDeliveryGrantDisabledReason,
  isCommitDeliveryIntent,
  isLiveFactoryDelivery,
  mergeGrantDisabledReason,
} from "./factoryDelivery.logic";
import { safeExternalUrl } from "./factoryIssues.logic";

const MERGE_METHOD_OPTIONS: ReadonlyArray<{
  readonly value: PullRequestMergeMethod;
  readonly label: string;
}> = [
  { value: "squash", label: msg("Squash", { $context: "merge method" }) },
  { value: "merge", label: msg("Merge commit") },
  { value: "rebase", label: msg("Rebase") },
];

export function FactoryDeliveryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly issueTitle: string;
  readonly issueUrl: string;
  readonly acceptanceCurrent: boolean;
  /** Merge controls need a host that can pin the merge to the accepted head. */
  readonly capabilities: Pick<FactoryIssueCapabilities, "displayName" | "headPinnedMerge">;
  readonly onGranted: () => void;
}) {
  const { environmentId, projectId, threadId } = props;
  const gt = useGT();
  const m = useMessages();
  const { displayName, headPinnedMerge } = props.capabilities;
  const registry = useContext(RegistryContext);
  const headingId = useId();
  const titleId = useId();
  const bodyId = useId();
  const draftId = useId();
  const disabledReasonId = useId();
  const reconcileReasonId = useId();
  const mergeHeadingId = useId();
  const mergeMethodId = useId();
  const mergeDisabledReasonId = useId();
  const [title, setTitle] = useState(props.issueTitle);
  const [body, setBody] = useState(() => gt("Issue: {url}", { url: props.issueUrl }));
  const [draft, setDraft] = useState(true);
  const [prepareInput, setPrepareInput] = useState<FactoryDeliveryPrepareInput | null>(null);
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod>("squash");
  const [mergePrepareInput, setMergePrepareInput] = useState<FactoryDeliveryPrepareInput | null>(
    null,
  );
  const [mergeFailure, setMergeFailure] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps in-flight server commands tied to the mounted view that started them.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const deliveries = useEnvironmentQuery(
    factoryEnvironment.readDeliveries({ environmentId, input: { projectId, threadId } }),
  );
  const preview = useEnvironmentQuery(
    prepareInput === null
      ? null
      : factoryEnvironment.prepareDelivery({ environmentId, input: prepareInput }),
  );
  const mergePreview = useEnvironmentQuery(
    mergePrepareInput === null
      ? null
      : factoryEnvironment.prepareDelivery({ environmentId, input: mergePrepareInput }),
  );
  const hasGrantPermission = useAtomValue(
    factoryEnvironment.grantDelivery.permissionAtom(environmentId),
  );
  const hasReconcilePermission = useAtomValue(
    factoryEnvironment.reconcileDelivery.permissionAtom(environmentId),
  );
  const runGrant = useAtomCommand(factoryEnvironment.grantDelivery, {
    label: gt("factory grant delivery"),
    reportFailure: false,
  });
  const runReconcile = useAtomCommand(factoryEnvironment.reconcileDelivery, {
    label: gt("factory reconcile delivery"),
    reportFailure: false,
  });

  // A thread's deliveries may include artifact comments; this panel only speaks for commits.
  const prepared = prepareInput === null ? null : commitDeliveryPrepareResult(preview.data);
  const intents = (deliveries.data?.intents ?? []).filter(isCommitDeliveryIntent);
  const existing =
    intents.find((intent) => intent.kind === "publish-pr" && isLiveFactoryDelivery(intent)) ??
    prepared?.existing ??
    null;
  const published = intents.some(
    (intent) => intent.kind === "publish-pr" && intent.status === "confirmed",
  );
  const mergePrepared =
    mergePrepareInput === null ? null : commitDeliveryPrepareResult(mergePreview.data);
  const mergeExisting =
    intents.find((intent) => intent.kind === "merge-pr" && isLiveFactoryDelivery(intent)) ??
    mergePrepared?.existing ??
    null;
  const mergeDisabledReason =
    mergeGrantDisabledReason(
      {
        displayName,
        acceptanceCurrent: props.acceptanceCurrent,
        existing: mergeExisting,
        hasPermission: hasGrantPermission,
        prepared: mergePrepared,
        mergeMethod,
      },
      m,
    ) ??
    (mergePreview.isPending
      ? gt("Preparing the merge…")
      : mergePreview.error !== null || mergeFailure !== null
        ? gt("Prepare again before granting the merge.")
        : deliveries.error !== null || deliveries.data === null || deliveries.isPending
          ? gt("Refresh delivery status before granting the merge.")
          : null);
  const pullRequest = mergePrepared?.pullRequest ?? null;
  const pullRequestHref = pullRequest === null ? null : safeExternalUrl(pullRequest.url);
  const conditions = {
    acceptanceCurrent: props.acceptanceCurrent && (prepared?.current ?? true),
    existing,
    hasPermission: hasGrantPermission,
  };
  const disabledReason =
    factoryDeliveryGrantDisabledReason(conditions, m) ??
    (prepared === null
      ? gt("Prepare the pull request before granting publication.")
      : preview.isPending
        ? gt("Preparing the pull request…")
        : preview.error !== null || failure !== null
          ? gt("Prepare again before granting publication.")
          : deliveries.error !== null || deliveries.data === null || deliveries.isPending
            ? gt("Refresh delivery status before granting publication.")
            : null);

  const invalidatePreview = () => {
    // An edit must require a fresh server digest, even if the previous query is cached.
    setPrepareInput(null);
    setFailure(null);
  };
  const prepare = () => {
    if (busy || preview.isPending || !props.acceptanceCurrent || title.trim().length === 0) return;
    const input: FactoryDeliveryPrepareInput = {
      projectId,
      threadId,
      kind: "publish-pr",
      payload: { title: title.trim(), body, draft },
    };
    registry.refresh(factoryEnvironment.prepareDelivery({ environmentId, input }));
    setFailure(null);
    setPrepareInput(input);
  };

  const grant = async () => {
    if (
      inFlight.current ||
      prepared === null ||
      disabledReason !== null ||
      !canGrantFactoryDelivery(conditions)
    ) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const result = await runGrant({
      environmentId,
      input: {
        projectId,
        threadId,
        kind: "publish-pr",
        commandId: randomUUID(),
        expectedHeadSha: prepared.headSha,
        expectedPayloadDigest: prepared.payloadDigest,
        payload: prepared.payload,
      },
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      setPrepareInput(null);
      props.onGranted();
    } else if (!isAtomCommandInterrupted(result)) {
      setFailure(factoryDeliveryFailureMessage(squashAtomCommandFailure(result), displayName));
      deliveries.refresh();
    }
  };

  const prepareMerge = () => {
    if (busy || mergePreview.isPending || !props.acceptanceCurrent || !published) return;
    const input: FactoryDeliveryPrepareInput = {
      projectId,
      threadId,
      kind: "merge-pr",
      payload: { mergeMethod },
    };
    registry.refresh(factoryEnvironment.prepareDelivery({ environmentId, input }));
    setMergeFailure(null);
    setMergePrepareInput(input);
  };

  const grantMerge = async () => {
    if (inFlight.current || !published || mergePrepared === null || mergeDisabledReason !== null) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMergeFailure(null);
    const result = await runGrant({
      environmentId,
      input: {
        projectId,
        threadId,
        kind: "merge-pr",
        commandId: randomUUID(),
        expectedHeadSha: mergePrepared.headSha,
        expectedPayloadDigest: mergePrepared.payloadDigest,
        payload: mergePrepared.payload,
      },
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    });
    if (!mounted.current) return;
    if (result._tag === "Success") {
      setMergePrepareInput(null);
      props.onGranted();
    } else if (!isAtomCommandInterrupted(result)) {
      setMergeFailure(
        factoryDeliveryFailureMessage(
          squashAtomCommandFailure(result),
          displayName,
          undefined,
          "merge-pr",
        ),
      );
      deliveries.refresh();
    }
  };

  const reconcile = async (intentId: string) => {
    if (inFlight.current || !hasReconcilePermission) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    const result = await runReconcile({ environmentId, input: { projectId, intentId } }).finally(
      () => {
        inFlight.current = false;
        if (mounted.current) setBusy(false);
      },
    );
    if (!mounted.current) return;
    if (result._tag === "Success") {
      deliveries.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      setFailure(factoryDeliveryFailureMessage(squashAtomCommandFailure(result), displayName));
    }
  };

  const readFailure =
    deliveries.error === null
      ? null
      : factoryDeliveryFailureMessage(
          deliveries.failure,
          displayName,
          deliveries.error,
          "publish-pr",
          m,
        );
  const prepareFailure =
    preview.error === null
      ? null
      : factoryDeliveryFailureMessage(preview.failure, displayName, preview.error, "publish-pr", m);
  const visibleFailure = failure ?? prepareFailure ?? readFailure;
  const mergePrepareFailure =
    mergePreview.error === null
      ? null
      : factoryDeliveryFailureMessage(
          mergePreview.failure,
          displayName,
          mergePreview.error,
          "merge-pr",
          m,
        );
  const visibleMergeFailure = mergeFailure ?? mergePrepareFailure;

  return (
    <section aria-labelledby={headingId} aria-busy={busy} className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={headingId} className="font-medium text-sm">
          <T>Publish pull request</T>
        </h4>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || deliveries.isPending}
          onClick={() => deliveries.refresh()}
          aria-label={gt("Refresh delivery status")}
        >
          <T>Refresh</T>
        </Button>
      </div>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          prepare();
        }}
      >
        <div className="space-y-1">
          <label htmlFor={titleId} className="text-xs">
            <T>Pull request title</T>
          </label>
          <Input
            id={titleId}
            value={title}
            maxLength={FACTORY_DELIVERY_TITLE_MAX_CHARS}
            required
            disabled={busy || preview.isPending}
            onChange={(event) => {
              setTitle(event.target.value);
              invalidatePreview();
            }}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={bodyId} className="text-xs">
            <T>Pull request body</T>
          </label>
          <Textarea
            id={bodyId}
            value={body}
            maxLength={FACTORY_DELIVERY_BODY_MAX_CHARS}
            disabled={busy || preview.isPending}
            onChange={(event) => {
              setBody(event.target.value);
              invalidatePreview();
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={draftId}
            checked={draft}
            disabled={busy || preview.isPending}
            onCheckedChange={(checked) => {
              setDraft(checked);
              invalidatePreview();
            }}
          />
          <label htmlFor={draftId} className="text-xs">
            <T>Draft pull request</T>
          </label>
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={
            busy || preview.isPending || !props.acceptanceCurrent || title.trim().length === 0
          }
        >
          {preview.isPending ? gt("Preparing…") : gt("Prepare")}
        </Button>
      </form>
      {prepared !== null && !preview.isPending && prepareFailure === null ? (
        <dl className="space-y-1 text-xs [overflow-wrap:anywhere]">
          <div>
            <dt>
              <T>Repository</T>
            </dt>
            <dd>{prepared.repository.canonicalKey}</dd>
          </div>
          <div>
            <dt>
              <T>Accepted head</T>
            </dt>
            <dd>
              <code>{prepared.headSha.slice(0, 7)}</code>
            </dd>
          </div>
          <div>
            <dt>
              <T>Host base branch</T>
            </dt>
            <dd>{prepared.baseBranch ?? gt("No reviewed destination")}</dd>
          </div>
          <div>
            <dt>
              <T>Launch snapshot</T>
            </dt>
            <dd>{prepared.baseRef}</dd>
          </div>
          <div>
            <dt>
              <T>Payload digest</T>
            </dt>
            <dd>
              <code>{prepared.payloadDigest.slice(0, 7)}</code>
            </dd>
          </div>
        </dl>
      ) : null}
      {visibleFailure !== null ? (
        <Alert variant="error">
          <AlertDescription>{visibleFailure}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-1">
        <Button
          size="sm"
          disabled={busy || disabledReason !== null}
          aria-describedby={disabledReason === null ? undefined : disabledReasonId}
          onClick={() => void grant()}
        >
          <T>Grant publish</T>
        </Button>
        {disabledReason !== null ? (
          <p id={disabledReasonId} className="text-muted-foreground text-xs">
            {disabledReason}
          </p>
        ) : null}
      </div>
      {published && headPinnedMerge ? (
        <section aria-labelledby={mergeHeadingId} className="space-y-2">
          <h4 id={mergeHeadingId} className="font-medium text-sm">
            <T>Merge</T>
          </h4>
          <div className="space-y-1">
            <label htmlFor={mergeMethodId} className="text-xs">
              <T>Merge method</T>
            </label>
            <Select
              value={mergeMethod}
              disabled={busy || mergePreview.isPending}
              onValueChange={(value) => {
                if (value !== "merge" && value !== "squash" && value !== "rebase") return;
                setMergeMethod(value);
                // A changed method needs its own server digest before a grant can be offered.
                setMergePrepareInput(null);
                setMergeFailure(null);
              }}
            >
              <SelectTrigger id={mergeMethodId} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {MERGE_METHOD_OPTIONS.filter(
                  (option) =>
                    pullRequest === null || pullRequest.mergeMethods.includes(option.value),
                ).map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {m(option.label)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || mergePreview.isPending || !props.acceptanceCurrent}
            onClick={prepareMerge}
          >
            {mergePreview.isPending ? gt("Preparing merge…") : gt("Prepare merge")}
          </Button>
          {mergePrepared !== null &&
          pullRequest !== null &&
          !mergePreview.isPending &&
          mergePrepareFailure === null ? (
            <>
              <dl className="space-y-1 text-xs [overflow-wrap:anywhere]">
                <div>
                  <dt>
                    <T>Pull request</T>
                  </dt>
                  <dd>
                    {pullRequestHref === null ? (
                      `#${pullRequest.number}`
                    ) : (
                      <a
                        href={pullRequestHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-4"
                      >
                        #{pullRequest.number}
                      </a>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>
                    <T>Accepted head</T>
                  </dt>
                  <dd>
                    <code>{mergePrepared.headSha.slice(0, 7)}</code>
                  </dd>
                </div>
                <div>
                  <dt>
                    <T>Pull request head</T>
                  </dt>
                  <dd>
                    {pullRequest.headSha === null ? (
                      gt("Unavailable")
                    ) : (
                      <code>{pullRequest.headSha.slice(0, 7)}</code>
                    )}
                  </dd>
                  <dd>
                    {pullRequest.headSha === mergePrepared.headSha
                      ? gt("Matches the accepted commit.")
                      : gt("Does not match the accepted commit.")}
                  </dd>
                </div>
                <div>
                  <dt>
                    <T>Mergeability</T>
                  </dt>
                  <dd>{pullRequest.mergeability}</dd>
                </div>
                <div>
                  <dt>
                    <T>Checks</T>
                  </dt>
                  <dd>{pullRequest.checksSummary ?? gt("Check status unavailable.")}</dd>
                </div>
              </dl>
              {pullRequest.isDraft ? (
                <Alert variant="warning">
                  <AlertDescription>
                    <T>This pull request is a draft. Mark it ready for review before merging.</T>
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : null}
          {visibleMergeFailure !== null ? (
            <Alert variant="error">
              <AlertDescription>{visibleMergeFailure}</AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-1">
            <Button
              size="sm"
              disabled={busy || mergeDisabledReason !== null}
              aria-describedby={mergeDisabledReason === null ? undefined : mergeDisabledReasonId}
              onClick={() => void grantMerge()}
            >
              <T>Grant merge</T>
            </Button>
            {mergeDisabledReason !== null ? (
              <p id={mergeDisabledReasonId} className="text-muted-foreground text-xs">
                {mergeDisabledReason}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}
      {deliveries.data === null && readFailure === null ? (
        <p role="status" className="text-muted-foreground text-xs">
          <T>Reading deliveries…</T>
        </p>
      ) : null}
      <ul aria-label={gt("Pull request deliveries")} className="space-y-2 text-xs">
        {intents.map((intent) => {
          const href = intent.remote === null ? null : safeExternalUrl(intent.remote.url);
          return (
            <li key={intent.id} className="space-y-1">
              <p className="[overflow-wrap:anywhere]">
                {"title" in intent.payload ? intent.payload.title : gt("Merge pull request")}
              </p>
              {intent.status === "pending" || intent.status === "sending" ? (
                <Badge variant="outline">
                  <CircleDotIcon />
                  {describeDeliveryStatus(intent, displayName, m)}
                </Badge>
              ) : intent.status === "confirmed" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {describeDeliveryStatus(intent, displayName, m)}
                  </Badge>
                  {href !== null && intent.remote !== null ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-4"
                    >
                      #{intent.remote.number}
                    </a>
                  ) : null}
                </div>
              ) : (
                <p className="[overflow-wrap:anywhere]">
                  {describeDeliveryStatus(intent, displayName, m)}
                </p>
              )}
              {intent.status === "unknown" || intent.status === "failed" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || !hasReconcilePermission}
                  aria-describedby={hasReconcilePermission ? undefined : reconcileReasonId}
                  onClick={() => void reconcile(intent.id)}
                >
                  <T>Reconcile</T>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {!hasReconcilePermission &&
      intents.some((intent) => intent.status === "unknown" || intent.status === "failed") ? (
        <p id={reconcileReasonId} className="text-muted-foreground text-xs">
          <T>Reconciling needs operate and source-control write permissions on this environment.</T>
        </p>
      ) : null}
    </section>
  );
}
