import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  aggregateFactoryWork,
  factoryWorkKey,
  parseFactoryWorkSelection,
  planFactoryWorkOwners,
  selectFactoryWorkDetail,
  type FactoryWorkOwner,
  type FactoryWorkOwnerStatus,
} from "@t3tools/client-runtime/state/factory-work";
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type FactoryWorkHistoryInput,
  type FactoryWorkRef,
  type FactoryWorkSummary,
} from "@t3tools/contracts";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { factoryEnvironment, useFactoryWorkLists } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { factoryScopeSearchForMember } from "./factoryScope";
import { safeExternalUrl } from "./factoryIssues.logic";
import { parseFactoryIssueViewMode } from "./factoryIssues.views";
import { parseFactoryWorkBoardGrouping } from "./factoryWork.views";
import {
  FactoryWorkBoard,
  FactoryWorkItemConditions,
  FactoryWorkTable,
} from "./FactoryWorkCollectionViews";
import { FactoryOverviewPage } from "./FactoryOverviewPage";
import { FactoryWorkPrerequisites } from "./FactoryWorkPrerequisites";

const ownerMessages: Record<FactoryWorkOwnerStatus, string> = {
  current: "Current page. Refresh to observe changes.",
  loading: "Loading owner collection…",
  offline: "Owner offline. Reconnect to inspect or act.",
  unsupported: "Owner does not advertise Unified Work. Update its server.",
  forbidden: "Owner read access denied. Protected details are unavailable.",
  failed: "Owner read failed. This is not an empty collection.",
};

export function FactoryWorkPage() {
  const search = useSearch({ from: "/_chat/factory" });
  const { scope } = useSettingsScope();
  return (
    <FactoryWorkWorkspace
      key={JSON.stringify([
        scope.environmentIds,
        scope.members.map((member) => member.physicalProjectKey),
        search.workKind,
      ])}
    />
  );
}

function FactoryWorkWorkspace() {
  const search = useSearch({ from: "/_chat/factory" });
  const navigate = useNavigate();
  const { scope, groups } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  const projects = useProjects();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const [cursors, setCursors] = useState<
    ReadonlyMap<EnvironmentId, readonly (string | undefined)[]>
  >(new Map());
  const [showOverview, setShowOverview] = useState(false);
  const plan = planFactoryWorkOwners({
    environmentIds: scope.environmentIds,
    projects: scope.kind === "project" || scope.kind === "checkout" ? scope.members : null,
  });
  const access = new Map(
    environments.map((environment) => [
      environment.environmentId,
      environment.connection.phase !== "connected"
        ? ("offline" as const)
        : environment.serverConfig === null
          ? ("loading" as const)
          : environment.serverConfig.environment.capabilities.factoryWork !== true
            ? ("unsupported" as const)
            : !readable.has(environment.environmentId)
              ? ("forbidden" as const)
              : ("current" as const),
    ]),
  );
  const targets = plan
    .filter((target) => access.get(target.environmentId) === "current")
    .map((target) => ({
      environmentId: target.environmentId,
      input: {
        projectIds: target.projectIds,
        kind: search.workKind,
        cursor: cursors.get(target.environmentId)?.at(-1),
        limit: 25,
      },
    }));
  const { lists, refresh } = useFactoryWorkLists(targets);
  const owners: FactoryWorkOwner[] = plan.map((target) => {
    const result = lists.find((list) => list.environmentId === target.environmentId)?.result;
    let status: FactoryWorkOwnerStatus = access.get(target.environmentId) ?? "offline";
    if (status === "current") {
      if (result?._tag === "Failure") {
        status = Option.exists(
          Cause.findErrorOption(result.cause),
          Schema.is(EnvironmentAuthorizationError),
        )
          ? "forbidden"
          : "failed";
      } else if (!result || result.waiting || result._tag === "Initial") status = "loading";
    }
    return {
      environmentId: target.environmentId,
      status,
      page: result && status !== "forbidden" ? Option.getOrNull(AsyncResult.value(result)) : null,
    };
  });
  const aggregate = aggregateFactoryWork(owners);
  const selection = parseFactoryWorkSelection(search.work);
  const selectedStatus =
    selection === null
      ? "offline"
      : owners.find((owner) => owner.environmentId === selection.environmentId)?.status ===
          "forbidden"
        ? "forbidden"
        : (access.get(selection.environmentId) ?? "offline");
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  const projectLabel = (item: FactoryWorkSummary) =>
    projects.find(
      (candidate) =>
        candidate.environmentId === item.ref.environmentId && candidate.id === item.projectId,
    )?.title ?? `${item.projectId} (project unavailable)`;
  const projectOf = (item: FactoryWorkSummary) => {
    const group = groups.find((candidate) =>
      candidate.memberProjects.some(
        (member) => member.environmentId === item.ref.environmentId && member.id === item.projectId,
      ),
    );
    return group
      ? { key: group.projectKey, label: group.displayName }
      : {
          key: JSON.stringify([item.ref.environmentId, item.projectId]),
          label: `${projectLabel(item)} · ${labelOf(item.ref.environmentId)}`,
        };
  };
  const selectedKey = selection === null ? null : factoryWorkKey(selection);
  const select = (reference: FactoryWorkRef) => {
    void navigate({
      to: "/factory",
      search: { ...search, work: JSON.stringify(reference), workFrom: undefined },
      resetScroll: false,
    });
  };
  const pager = (owner: FactoryWorkOwner) => (
    <div className="flex gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={(cursors.get(owner.environmentId)?.length ?? 1) < 2}
        onClick={() => movePage(owner.environmentId, null)}
      >
        Previous page
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={owner.status !== "current" || !owner.page?.nextCursor}
        onClick={() => {
          if (owner.page?.nextCursor) movePage(owner.environmentId, owner.page.nextCursor);
        }}
      >
        Next page
      </Button>
    </div>
  );
  const layout = parseFactoryIssueViewMode(search.view);
  const grouping = parseFactoryWorkBoardGrouping(search.workGroup);
  const coversEveryPage =
    !aggregate.incomplete && [...cursors.values()].every((history) => history.length < 2);
  const movePage = (id: EnvironmentId, next: string | null) =>
    setCursors((previous) => {
      const map = new Map(previous);
      const history = previous.get(id) ?? [undefined];
      map.set(id, next === null ? history.slice(0, -1) : [...history, next].slice(-32));
      return map;
    });
  return (
    <section className="min-w-0 space-y-5" aria-labelledby="factory-work-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="factory-work-title" className="font-medium text-lg">
            Work
          </h2>
          <p className="text-sm text-muted-foreground">
            Retained admissions, authored briefs and sealed protocols. Raw discovery remains in
            Issues and Sources.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={refresh}>
          Refresh Work
        </Button>
      </div>
      <ToggleGroup
        aria-label="Work kind"
        value={[search.workKind ?? "all"]}
        onValueChange={(values) => {
          const next = values[0];
          if (
            next === "all" ||
            next === "issue" ||
            next === "feed" ||
            next === "brief" ||
            next === "protocol"
          ) {
            void navigate({
              to: "/factory",
              search: { ...search, workKind: next === "all" ? undefined : next },
            });
          }
        }}
      >
        <Toggle value="all">All work</Toggle>
        <Toggle value="issue">Issues</Toggle>
        <Toggle value="feed">Feed work</Toggle>
        <Toggle value="brief">Briefs</Toggle>
        <Toggle value="protocol">Protocols</Toggle>
      </ToggleGroup>
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          aria-label="Work layout"
          value={[layout]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "list" || next === "table" || next === "board") {
              void navigate({
                to: "/factory",
                search: { ...search, view: next },
                replace: true,
                resetScroll: false,
              });
            }
          }}
        >
          <Toggle value="list">List</Toggle>
          <Toggle value="table">Table</Toggle>
          <Toggle value="board">Board</Toggle>
        </ToggleGroup>
        {layout === "board" ? (
          <ToggleGroup
            aria-label="Board columns"
            value={[grouping]}
            onValueChange={(values) => {
              const next = values[0];
              if (next === "origin" || next === "project") {
                void navigate({
                  to: "/factory",
                  search: { ...search, workGroup: next === "origin" ? undefined : next },
                  replace: true,
                  resetScroll: false,
                });
              }
            }}
          >
            <Toggle value="origin">By origin</Toggle>
            <Toggle value="project">By admission project</Toggle>
          </ToggleGroup>
        ) : null}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">About Work states and coverage</summary>
        <p className="mt-2">
          Each environment has its own pages and observation time. Source matches cover loaded pages
          only. Planning stage is unavailable; open an item for execution and acceptance evidence.
          Source state is a snapshot saved at admission.
        </p>
      </details>
      {!isReady ? <p role="status">Loading environments…</p> : null}
      {isReady && plan.length === 0 ? <p>No environments in this scope.</p> : null}
      {layout === "list" ? (
        owners.map((owner) => (
          <div key={owner.environmentId} className="space-y-2 rounded-lg border p-3">
            <h3 className="font-medium text-sm">{labelOf(owner.environmentId)}</h3>
            <p role="status" className="text-xs text-muted-foreground">
              {ownerMessages[owner.status]}
              {owner.page ? ` Observed ${owner.page.fetchedAt}.` : ""}
            </p>
            {owner.status === "current" && owner.page?.items.length === 0 ? (
              <p>No retained work on this page.</p>
            ) : null}
            <ul className="space-y-2" aria-label={`Work on ${labelOf(owner.environmentId)}`}>
              {aggregate.items
                .filter(({ item }) => item.ref.environmentId === owner.environmentId)
                .map((entry) => (
                  <li key={factoryWorkKey(entry.item.ref)} className="space-y-1 rounded border p-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={entry.stale}
                      aria-pressed={selectedKey === factoryWorkKey(entry.item.ref)}
                      onClick={() => select(entry.item.ref)}
                    >
                      {entry.item.title}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {entry.item.ref.kind} · Admission/authoring project {projectLabel(entry.item)}{" "}
                      · {entry.item.createdAt}
                    </p>
                    <FactoryWorkItemConditions entry={entry} conflicts={aggregate.conflicts} />
                  </li>
                ))}
            </ul>
            {pager(owner)}
          </div>
        ))
      ) : (
        <>
          <ul className="space-y-2" aria-label="Owner pages">
            {owners.map((owner) => (
              <li
                key={owner.environmentId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <h3 className="font-medium text-sm">{labelOf(owner.environmentId)}</h3>
                  <p role="status" className="text-xs text-muted-foreground">
                    {ownerMessages[owner.status]}
                    {owner.page ? ` Observed ${owner.page.fetchedAt}.` : ""}
                    {owner.status === "current" && owner.page?.items.length === 0
                      ? " No retained work on this page."
                      : ""}
                  </p>
                </div>
                {pager(owner)}
              </li>
            ))}
          </ul>
          {plan.length > 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              {coversEveryPage
                ? "All retained work in this scope is shown."
                : "Showing loaded pages only. More work may be on other pages or unavailable environments."}
            </p>
          ) : null}
          {layout === "table" ? (
            <FactoryWorkTable
              entries={aggregate.items}
              conflicts={aggregate.conflicts}
              selectedKey={selectedKey}
              ownerLabel={labelOf}
              projectLabel={projectLabel}
              onSelect={select}
            />
          ) : (
            <FactoryWorkBoard
              entries={aggregate.items}
              conflicts={aggregate.conflicts}
              selectedKey={selectedKey}
              ownerLabel={labelOf}
              projectLabel={projectLabel}
              onSelect={select}
              grouping={grouping}
              kind={search.workKind}
              projectOf={projectOf}
            />
          )}
        </>
      )}
      {selection !== null ? (
        <FactoryWorkDetail
          key={factoryWorkKey(selection)}
          reference={selection}
          status={selectedStatus}
        />
      ) : null}
      <Button size="sm" variant="outline" onClick={() => setShowOverview((previous) => !previous)}>
        Advanced environment overview
      </Button>
      {showOverview ? <FactoryOverviewPage /> : null}
    </section>
  );
}

function focusSelectedWork(heading: HTMLHeadingElement | null) {
  heading?.focus();
}

function FactoryWorkDetail(props: {
  readonly reference: FactoryWorkRef;
  readonly status: FactoryWorkOwnerStatus;
}) {
  const { reference, status } = props;
  const search = useSearch({ from: "/_chat/factory" });
  const navigate = useNavigate();
  const { groups, scope } = useSettingsScope();
  const returnTo = parseFactoryWorkSelection(search.workFrom);
  const { environments } = useEnvironments();
  const environment = environments.find(
    (candidate) => candidate.environmentId === reference.environmentId,
  );
  const query = useEnvironmentQuery(
    status === "current"
      ? factoryEnvironment.readWork({
          environmentId: reference.environmentId,
          input: { ref: reference },
        })
      : null,
  );
  const data = selectFactoryWorkDetail(
    status,
    query.error === null && !query.isPending ? query.data : null,
  );
  const canIssue = useAtomValue(factoryEnvironment.start.permissionAtom(reference.environmentId));
  const canFeed = useAtomValue(
    factoryEnvironment.admitFeedCandidate.permissionAtom(reference.environmentId),
  );
  const canBrief = useAtomValue(
    factoryEnvironment.startKnowledgeTask.permissionAtom(reference.environmentId),
  );
  const canResearch = useAtomValue(
    factoryEnvironment.launchResearchRun.permissionAtom(reference.environmentId),
  );
  const canOperate =
    reference.kind === "issue"
      ? canIssue
      : reference.kind === "feed"
        ? canFeed
        : reference.kind === "brief"
          ? canBrief
          : canResearch;
  const group = groups.find((candidate) =>
    candidate.memberProjects.some(
      (member) =>
        member.environmentId === reference.environmentId && member.id === data?.reviewProjectId,
    ),
  );
  const member = group?.memberProjects.find(
    (candidate) =>
      candidate.environmentId === reference.environmentId && candidate.id === data?.reviewProjectId,
  );
  const sourceUrl = safeExternalUrl(data?.item.sourceUrl ?? "");
  const reviewSupported =
    reference.kind === "issue" || reference.kind === "feed"
      ? environment?.serverConfig?.environment.capabilities.factoryWork === true
      : reference.kind === "brief"
        ? environment?.serverConfig?.environment.capabilities.factoryKnowledge === true
        : environment?.serverConfig?.environment.capabilities.factoryResearch === true;
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-labelledby="factory-work-detail-title"
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          id="factory-work-detail-title"
          className="font-medium"
          tabIndex={-1}
          ref={focusSelectedWork}
        >
          Selected work
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigate({
              to: "/factory",
              search: { ...search, work: undefined, workFrom: undefined },
              resetScroll: false,
            });
          }}
        >
          Close detail
        </Button>
      </div>
      {returnTo !== null ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigate({
              to: "/factory",
              search: { ...search, work: JSON.stringify(returnTo), workFrom: undefined },
              resetScroll: false,
            });
          }}
        >
          Return to previous selection
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground break-all">
        Environment {reference.environmentId} · {reference.kind} · {reference.id}
      </p>
      {status !== "current" ? (
        <p role="status">{ownerMessages[status]}</p>
      ) : query.error ? (
        <p role="alert">{query.error}</p>
      ) : data === null ? (
        <p role="status">Loading selected work…</p>
      ) : (
        <>
          <h4 className="font-medium">{data.item.title}</h4>
          <p className="text-sm">
            Admission/authoring project: {data.item.projectId}. Current native review project:{" "}
            {data.reviewProjectId ?? "unavailable"}. Planning stage unavailable. Runtime is shown
            per execution below; idle is not completion.
          </p>
          <p className="text-xs text-muted-foreground">
            {reference.kind === "protocol"
              ? "Sealed protocol."
              : reference.kind === "brief"
                ? "Authored brief."
                : "Source snapshot saved at admission."}{" "}
            {data.item.revision === null
              ? "No stored source revision."
              : `${reference.kind === "protocol" ? "Protocol" : reference.kind === "brief" ? "Brief" : "Source"} revision ${data.item.revision}.`}{" "}
            Attention, readiness, acceptance currentness and delivery authority require their
            existing review reads.
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
            {data.snapshot}
          </pre>
          {data.snapshotTruncated ? (
            <p>Snapshot preview truncated. Open native review for full intent.</p>
          ) : null}
          {data.supersedes !== null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigate({
                  to: "/factory",
                  search: {
                    ...search,
                    work: JSON.stringify({ ...reference, id: data.supersedes }),
                  },
                });
              }}
            >
              Previous concrete brief: {data.supersedes}
            </Button>
          ) : null}
          {data.item.supersededBy !== null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void navigate({
                  to: "/factory",
                  search: {
                    ...search,
                    work: JSON.stringify({ ...reference, id: data.item.supersededBy }),
                  },
                });
              }}
            >
              Replacement brief: {data.item.supersededBy}
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {sourceUrl ? (
              <Button
                size="sm"
                variant="outline"
                render={<a href={sourceUrl} target="_blank" rel="noreferrer" />}
              >
                Open live source separately
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={
                !member ||
                !group ||
                !reviewSupported ||
                (reference.kind === "feed" && data.item.originConflict)
              }
              onClick={() => {
                if (!member || !group) return;
                const target = data.reviewTarget;
                const to =
                  target.kind === "issue"
                    ? "/factory/issues"
                    : target.kind === "feed"
                      ? "/factory/sources"
                      : target.kind === "brief"
                        ? "/factory/briefs"
                        : "/factory/research";
                void navigate({
                  to,
                  search: {
                    ...factoryScopeSearchForMember(member, group),
                    state: "all",
                    view: "list",
                    workReturn: JSON.stringify({
                      project: search.project,
                      machine: search.machine,
                      checkout: search.checkout,
                      work: JSON.stringify(reference),
                      workKind: search.workKind,
                      view: search.view,
                      workGroup: search.workGroup,
                    }),
                    reviewId:
                      target.kind === "brief"
                        ? target.briefId
                        : target.kind === "protocol"
                          ? target.protocolId
                          : undefined,
                    reviewIssue: target.kind === "issue" ? target.issueNumber : undefined,
                    reviewFeed:
                      target.kind === "feed"
                        ? JSON.stringify([target.sourceId, target.itemKey])
                        : undefined,
                  },
                });
              }}
            >
              Open exact native review / start / resume
            </Button>
            {data.projectCoordinatorThreadId ? (
              <Button
                size="sm"
                variant="outline"
                render={
                  <Link
                    to="/$environmentId/$threadId"
                    params={buildThreadRouteParams(
                      scopeThreadRef(reference.environmentId, data.projectCoordinatorThreadId),
                    )}
                  />
                }
              >
                Project coordinator context
              </Button>
            ) : null}
          </div>
          {!member ? (
            <p>
              Actions unavailable: the saved current review project is missing or ambiguous. Work
              provenance remains retained.
            </p>
          ) : !reviewSupported ? (
            <p>Native review unsupported by this owner.</p>
          ) : !canOperate ? (
            <p>
              Start/resume unavailable: operate permission is required on this saved owner.
              Read-only review remains available.
            </p>
          ) : null}
          {!data.projectAvailable ? (
            <p>The original admission/authoring project is no longer available.</p>
          ) : null}
          {reference.kind === "feed" && data.item.originConflict ? (
            <p>
              Native actions unavailable: legacy feed admissions conflict. Inspect each execution
              below; no member is chosen for you.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Project coordinator is project context, not historical item-coordinator provenance.
            Inspecting Work does not launch, reconcile, accept or publish.
          </p>
          <FactoryWorkPrerequisites
            reference={reference}
            status={status}
            withinFilter={(link) =>
              (search.workKind === undefined || search.workKind === link.ref.kind) &&
              (scope.kind !== "project" && scope.kind !== "checkout"
                ? true
                : scope.members.some(
                    (candidate) =>
                      candidate.environmentId === link.ref.environmentId &&
                      candidate.id === link.projectId,
                  ))
            }
            onOpen={(next) => {
              void navigate({
                to: "/factory",
                search: { ...search, work: JSON.stringify(next), workFrom: search.work },
                resetScroll: false,
              });
            }}
          />
          <FactoryWorkHistory reference={reference} />
        </>
      )}
    </section>
  );
}

function FactoryWorkHistory(props: { readonly reference: FactoryWorkRef }) {
  const [selection, setSelection] = useState<
    Omit<FactoryWorkHistoryInput, "ref" | "cursor" | "limit">
  >({ section: "executions" });
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const query = useEnvironmentQuery(
    factoryEnvironment.readWorkHistory({
      environmentId: props.reference.environmentId,
      input: { ref: props.reference, ...selection, cursor: cursors.at(-1), limit: 25 },
    }),
  );
  const data = query.error === null && !query.isPending ? query.data : null;
  const select = (next: typeof selection) => {
    setSelection(next);
    setCursors([undefined]);
  };
  return (
    <div className="space-y-3">
      <h4 className="font-medium">{selection.section} · bounded metadata</h4>
      {selection.section !== "executions" ? (
        <Button size="sm" variant="outline" onClick={() => select({ section: "executions" })}>
          Back to executions
        </Button>
      ) : null}
      {selection.section === "outputs" ? (
        <p className="text-xs text-muted-foreground">
          Acceptance pins do not assert currentness. Unknown publication never authorizes retry. Use
          native review for exact evidence and delivery actions.
        </p>
      ) : null}
      {query.error ? (
        <p role="alert">{query.error}</p>
      ) : data === null ? (
        <p role="status">Loading history…</p>
      ) : data.entries.length === 0 ? (
        <p>No retained {selection.section}. An unstarted item is not completed.</p>
      ) : (
        <ul className="space-y-2" aria-label="Work history">
          {data.entries.map((entry) => (
            <li key={entry.id} className="space-y-2 rounded border p-3 text-sm">
              <p className="break-all">
                {entry.label} · {entry.state}
                {entry.superseded ? " · superseded" : ""} · {entry.id}
              </p>
              {entry.pin ? <code className="block break-all text-xs">Pin: {entry.pin}</code> : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={entry.state === "missing" || entry.state === "reserved or missing"}
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={buildThreadRouteParams(
                        scopeThreadRef(props.reference.environmentId, entry.threadId),
                      )}
                    />
                  }
                >
                  Open owning thread
                </Button>
                {selection.section === "executions" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => select({ section: "runs", threadId: entry.threadId })}
                    >
                      V2 runs
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => select({ section: "outputs", threadId: entry.threadId })}
                    >
                      Outputs / acceptance / publication
                    </Button>
                  </>
                ) : selection.section === "runs" && entry.runId !== null ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      select({
                        section: "attempts",
                        threadId: entry.threadId,
                        runId: entry.runId ?? undefined,
                      })
                    }
                  >
                    Retry attempts
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={cursors.length < 2}
          onClick={() => setCursors((previous) => previous.slice(0, -1))}
        >
          Previous history page
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!data?.nextCursor}
          onClick={() => {
            if (data?.nextCursor)
              setCursors((previous) => [...previous, data.nextCursor ?? undefined].slice(-32));
          }}
        >
          Next history page
        </Button>
      </div>
    </div>
  );
}
