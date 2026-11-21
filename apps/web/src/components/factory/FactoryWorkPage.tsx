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
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  factoryEnvironment,
  factoryIssueKeysInput,
  useFactoryIssueKeysSupported,
  useFactoryWorkLists,
} from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { factoryScopeSearchForMember } from "./factoryScope";
import { safeExternalUrl } from "./factoryIssues.logic";
import { parseFactoryIssueViewMode } from "./factoryIssues.views";
import {
  FACTORY_WORK_MAX_PAGES,
  moveFactoryWorkPage,
  parseFactoryWorkBoardGrouping,
} from "./factoryWork.views";
import {
  FactoryWorkBoard,
  FactoryWorkItemConditions,
  FactoryWorkTable,
} from "./FactoryWorkCollectionViews";
import { FactoryOverviewPage } from "./FactoryOverviewPage";
import { FactoryPlanEditor } from "./FactoryPlanEditor";
import { FactoryWorkPrerequisites } from "./FactoryWorkPrerequisites";

const ownerMessages: Record<FactoryWorkOwnerStatus, string> = {
  current: msg("Current page. Refresh to observe changes."),
  loading: msg("Loading owner collection…"),
  offline: msg("Owner offline. Reconnect to inspect or act."),
  unsupported: msg("Owner does not advertise Unified Work. Update its server."),
  forbidden: msg("Owner read access denied. Protected details are unavailable."),
  failed: msg("Owner read failed. This is not an empty collection."),
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
  const gt = useGT();
  const messages = useMessages();
  const { scope, groups } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  const projects = useProjects();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const [cursors, setCursors] = useState<
    ReadonlyMap<EnvironmentId, readonly (string | undefined)[]>
  >(new Map());
  const [showOverview, setShowOverview] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
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
    )?.title ?? gt("{id} (project unavailable)", { id: item.projectId });
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
          label: gt("{project} · {environment}", {
            project: projectLabel(item),
            environment: labelOf(item.ref.environmentId),
          }),
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
    <div className="space-y-1">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={(cursors.get(owner.environmentId)?.length ?? 1) < 2}
          onClick={() => movePage(owner.environmentId, null)}
        >
          <T>Previous page</T>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={
            owner.status !== "current" ||
            !owner.page?.nextCursor ||
            (cursors.get(owner.environmentId)?.length ?? 1) >= FACTORY_WORK_MAX_PAGES
          }
          onClick={() => {
            if (owner.page?.nextCursor) movePage(owner.environmentId, owner.page.nextCursor);
          }}
        >
          <T>Next page</T>
        </Button>
      </div>
      {(cursors.get(owner.environmentId)?.length ?? 1) >= FACTORY_WORK_MAX_PAGES ? (
        <p className="text-xs text-muted-foreground">
          {gt(
            "Reached the {limit}-page limit for this owner. Go back or narrow the scope to inspect other work.",
            { limit: String(FACTORY_WORK_MAX_PAGES) },
          )}
        </p>
      ) : null}
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
      map.set(id, moveFactoryWorkPage(history, next));
      return map;
    });
  return (
    <section className="min-w-0 space-y-5" aria-labelledby="factory-work-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="factory-work-title" className="font-medium text-lg">
            <T>Work</T>
          </h2>
          <p className="text-sm text-muted-foreground">
            <T>
              Retained admissions, authored briefs and sealed protocols. Raw discovery remains in
              Issues and Sources.
            </T>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-expanded={showPlans}
            onClick={() => setShowPlans((previous) => !previous)}
          >
            {showPlans ? <T>Hide local plans</T> : <T>Local plans</T>}
          </Button>
          <Button size="sm" variant="outline" onClick={refresh}>
            <T>Refresh collection</T>
          </Button>
        </div>
      </div>
      {showPlans ? <FactoryPlanEditor /> : null}
      <ToggleGroup
        aria-label={gt("Work kind")}
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
        <Toggle value="all">
          <T>All work</T>
        </Toggle>
        <Toggle value="issue">
          <T>Issues</T>
        </Toggle>
        <Toggle value="feed">
          <T>Feed work</T>
        </Toggle>
        <Toggle value="brief">
          <T>Briefs</T>
        </Toggle>
        <Toggle value="protocol">
          <T>Protocols</T>
        </Toggle>
      </ToggleGroup>
      <div className="flex flex-wrap items-center gap-3">
        <ToggleGroup
          aria-label={gt("Work layout")}
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
          <Toggle value="list">
            <T>List</T>
          </Toggle>
          <Toggle value="table">
            <T>Table</T>
          </Toggle>
          <Toggle value="board">
            <T>Board</T>
          </Toggle>
        </ToggleGroup>
        {layout === "board" ? (
          <ToggleGroup
            aria-label={gt("Board columns")}
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
            <Toggle value="origin">
              <T>By origin</T>
            </Toggle>
            <Toggle value="project">
              <T>By admission project</T>
            </Toggle>
          </ToggleGroup>
        ) : null}
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          <T>About Work states and coverage</T>
        </summary>
        <p className="mt-2">
          <T>
            Each environment has its own pages and observation time. Source matches cover loaded
            pages only. Planning stage is unavailable; open an item for execution and acceptance
            evidence. Source state is a snapshot saved at admission.
          </T>
        </p>
      </details>
      {!isReady ? (
        <p role="status">
          <T>Loading environments…</T>
        </p>
      ) : null}
      {isReady && plan.length === 0 ? (
        <p>
          <T>No environments in this scope.</T>
        </p>
      ) : null}
      {layout === "list" ? (
        owners.map((owner) => (
          <div key={owner.environmentId} className="space-y-2 rounded-lg border p-3">
            <h3 className="font-medium text-sm">{labelOf(owner.environmentId)}</h3>
            <p role="status" className="text-xs text-muted-foreground">
              {messages(ownerMessages[owner.status])}
              {owner.page ? gt(" Observed {at}.", { at: owner.page.fetchedAt }) : ""}
            </p>
            {owner.status === "current" && owner.page?.items.length === 0 ? (
              <p>
                <T>No retained work on this page.</T>
              </p>
            ) : null}
            <ul
              className="space-y-2"
              aria-label={gt("Work on {label}", { label: labelOf(owner.environmentId) })}
            >
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
                      {gt("{kind} · Admission/authoring project {project} · {createdAt}", {
                        kind: entry.item.ref.kind,
                        project: projectLabel(entry.item),
                        createdAt: entry.item.createdAt,
                      })}
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
          <ul className="space-y-2" aria-label={gt("Owner pages")}>
            {owners.map((owner) => (
              <li
                key={owner.environmentId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <h3 className="font-medium text-sm">{labelOf(owner.environmentId)}</h3>
                  <p role="status" className="text-xs text-muted-foreground">
                    {messages(ownerMessages[owner.status])}
                    {owner.page ? gt(" Observed {at}.", { at: owner.page.fetchedAt }) : ""}
                    {owner.status === "current" && owner.page?.items.length === 0
                      ? gt(" No retained work on this page.")
                      : ""}
                  </p>
                </div>
                {pager(owner)}
              </li>
            ))}
          </ul>
          {plan.length > 0 ? (
            <p role="status" className="text-xs text-muted-foreground">
              {coversEveryPage ? (
                <T>All retained work in this scope is shown.</T>
              ) : (
                <T>
                  Showing loaded pages only. More work may be on other pages or unavailable
                  environments.
                </T>
              )}
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
        <T>Advanced environment overview</T>
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
  const gt = useGT();
  const messages = useMessages();
  const { groups, scope } = useSettingsScope();
  const returnTo = parseFactoryWorkSelection(search.workFrom);
  const { environments } = useEnvironments();
  const environment = environments.find(
    (candidate) => candidate.environmentId === reference.environmentId,
  );
  const issueKeysSupported = useFactoryIssueKeysSupported(reference.environmentId);
  const query = useEnvironmentQuery(
    status === "current"
      ? factoryEnvironment.readWork({
          environmentId: reference.environmentId,
          input: { ref: reference, ...factoryIssueKeysInput(issueKeysSupported) },
        })
      : null,
  );
  const history = useFactoryWorkHistory(reference, status);
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
          <T>Selected work</T>
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={status !== "current" || query.isPending || history.query.isPending}
            onClick={() => {
              query.refresh();
              history.query.refresh();
            }}
          >
            <T>Refresh selected work</T>
          </Button>
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
            <T>Close detail</T>
          </Button>
        </div>
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
          <T>Return to previous selection</T>
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground break-all">
        {gt("Environment {environmentId} · {kind} · {id}", {
          environmentId: reference.environmentId,
          kind: reference.kind,
          id: reference.id,
        })}
      </p>
      {status !== "current" ? (
        <p role="status">{messages(ownerMessages[status])}</p>
      ) : query.error ? (
        <p role="alert">{query.error}</p>
      ) : data === null ? (
        <p role="status">
          <T>Loading selected work…</T>
        </p>
      ) : (
        <>
          <h4 className="font-medium">{data.item.title}</h4>
          <p className="text-sm">
            {gt(
              "Admission/authoring project: {projectId}. Current native review project: {reviewProjectId}. Planning stage unavailable. Runtime is shown per execution below; idle is not completion.",
              {
                projectId: data.item.projectId,
                reviewProjectId: data.reviewProjectId ?? gt("unavailable"),
              },
            )}
          </p>
          <p className="text-xs text-muted-foreground">
            {reference.kind === "protocol"
              ? gt("Sealed protocol.")
              : reference.kind === "brief"
                ? gt("Authored brief.")
                : gt("Source snapshot saved at admission.")}{" "}
            {data.item.revision === null
              ? gt("No stored source revision.")
              : gt("{label} revision {revision}.", {
                  label:
                    reference.kind === "protocol"
                      ? gt("Protocol")
                      : reference.kind === "brief"
                        ? gt("Brief")
                        : gt("Source"),
                  revision: String(data.item.revision),
                })}{" "}
            <T>
              Attention, readiness, acceptance currentness and delivery authority require their
              existing review reads.
            </T>
          </p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">
            {data.snapshot}
          </pre>
          {data.snapshotTruncated ? (
            <p>
              <T>Snapshot preview truncated. Open native review for full intent.</T>
            </p>
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
              {gt("Previous concrete brief: {id}", { id: data.supersedes })}
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
              {gt("Replacement brief: {id}", { id: data.item.supersededBy })}
            </Button>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {sourceUrl ? (
              <Button
                size="sm"
                variant="outline"
                render={<a href={sourceUrl} target="_blank" rel="noreferrer" />}
              >
                <T>Open live source separately</T>
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
                      workFrom: search.workFrom,
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
                    reviewIssue:
                      target.kind === "issue" ? (target.issueNumber ?? target.key) : undefined,
                    reviewFeed:
                      target.kind === "feed"
                        ? JSON.stringify([target.sourceId, target.itemKey])
                        : undefined,
                  },
                });
              }}
            >
              <T>Open exact native review / start / resume</T>
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
                <T>Project coordinator context</T>
              </Button>
            ) : null}
          </div>
          {!member ? (
            <p>
              <T>
                Actions unavailable: the saved current review project is missing or ambiguous. Work
                provenance remains retained.
              </T>
            </p>
          ) : !reviewSupported ? (
            <p>
              <T>Native review unsupported by this owner.</T>
            </p>
          ) : !canOperate ? (
            <p>
              <T>
                Start/resume unavailable: operate permission is required on this saved owner.
                Read-only review remains available.
              </T>
            </p>
          ) : null}
          {!data.projectAvailable ? (
            <p>
              <T>The original admission/authoring project is no longer available.</T>
            </p>
          ) : null}
          {reference.kind === "feed" && data.item.originConflict ? (
            <p>
              <T>
                Native actions unavailable: legacy feed admissions conflict. Inspect each execution
                below; no member is chosen for you.
              </T>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            <T>
              Project coordinator is project context, not historical item-coordinator provenance.
              Inspecting Work does not launch, reconcile, accept or publish.
            </T>
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
          <FactoryWorkHistory reference={reference} history={history} />
        </>
      )}
    </section>
  );
}

function useFactoryWorkHistory(reference: FactoryWorkRef, status: FactoryWorkOwnerStatus) {
  const [selection, setSelection] = useState<
    Omit<FactoryWorkHistoryInput, "ref" | "cursor" | "limit">
  >({ section: "executions" });
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const query = useEnvironmentQuery(
    status === "current"
      ? factoryEnvironment.readWorkHistory({
          environmentId: reference.environmentId,
          input: { ref: reference, ...selection, cursor: cursors.at(-1), limit: 25 },
        })
      : null,
  );
  const data = query.error === null && !query.isPending ? query.data : null;
  const select = (next: typeof selection) => {
    setSelection(next);
    setCursors([undefined]);
  };
  return { selection, cursors, setCursors, query, data, select };
}

function FactoryWorkHistory(props: {
  readonly reference: FactoryWorkRef;
  readonly history: ReturnType<typeof useFactoryWorkHistory>;
}) {
  const gt = useGT();
  const { selection, cursors, setCursors, query, data, select } = props.history;
  return (
    <div className="space-y-3">
      <h4 className="font-medium">
        {gt("{section} · bounded metadata", { section: selection.section })}
      </h4>
      {selection.section !== "executions" ? (
        <Button size="sm" variant="outline" onClick={() => select({ section: "executions" })}>
          <T>Back to executions</T>
        </Button>
      ) : null}
      {selection.section === "outputs" ? (
        <p className="text-xs text-muted-foreground">
          <T>
            Acceptance pins do not assert currentness. Unknown publication never authorizes retry.
            Use native review for exact evidence and delivery actions.
          </T>
        </p>
      ) : null}
      {query.error ? (
        <p role="alert">{query.error}</p>
      ) : data === null ? (
        <p role="status">
          <T>Loading history…</T>
        </p>
      ) : data.entries.length === 0 ? (
        <p>
          {gt("No retained {section}. An unstarted item is not completed.", {
            section: selection.section,
          })}
        </p>
      ) : (
        <ul className="space-y-2" aria-label={gt("Work history")}>
          {data.entries.map((entry) => (
            <li key={entry.id} className="space-y-2 rounded border p-3 text-sm">
              <p className="break-all">
                {gt("{label} · {state}{superseded} · {id}", {
                  label: entry.label,
                  state: entry.state,
                  superseded: entry.superseded ? " · superseded" : "",
                  id: entry.id,
                })}
              </p>
              {entry.pin ? (
                <code className="block break-all text-xs">
                  <T>
                    Pin: <Var>{entry.pin}</Var>
                  </T>
                </code>
              ) : null}
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
                  <T>Open owning thread</T>
                </Button>
                {selection.section === "executions" ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => select({ section: "runs", threadId: entry.threadId })}
                    >
                      <T>V2 runs</T>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => select({ section: "outputs", threadId: entry.threadId })}
                    >
                      <T>Outputs / acceptance / publication</T>
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
                    <T>Retry attempts</T>
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
          onClick={() => setCursors((previous) => moveFactoryWorkPage(previous, null))}
        >
          <T>Previous history page</T>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!data?.nextCursor || cursors.length >= FACTORY_WORK_MAX_PAGES}
          onClick={() => {
            if (data?.nextCursor)
              setCursors((previous) => moveFactoryWorkPage(previous, data.nextCursor ?? null));
          }}
        >
          <T>Next history page</T>
        </Button>
      </div>
      {cursors.length >= FACTORY_WORK_MAX_PAGES ? (
        <p className="text-xs text-muted-foreground">
          {gt(
            "Reached the {limit}-page history limit. Go back or choose another history section to inspect other records.",
            { limit: String(FACTORY_WORK_MAX_PAGES) },
          )}
        </p>
      ) : null}
    </div>
  );
}
