import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FactoryIssue,
  type FactoryRepository,
  type ProjectId,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDotIcon,
  ExternalLinkIcon,
  FactoryIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  factoryEnvironment,
  factoryIssueKeysInput,
  useFactoryIssueKeysSupported,
} from "../../state/factory";
import { useEnvironments } from "../../state/environments";
import { useProjects, useServerConfigs } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { buildThreadRouteParams } from "../../threadRoutes";
import { RelativeTime } from "../RelativeTime";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  FACTORY_STATE_FILTERS,
  currentFactoryPage,
  describeFactoryFailure,
  factoryScopeKey,
  parseFactoryStateFilter,
  popFactoryPage,
  pushFactoryPage,
  safeExternalUrl,
  type FactoryIssueStateFilter,
} from "./factoryIssues.logic";
import { FactoryCheckoutChooser } from "./FactoryCheckoutChooser";
import { FactoryClaimsUnavailableNote } from "./FactoryClaimIndicators";
import { FactoryEmptyState } from "./FactoryEmptyState";
import { FactoryIssueWorkView } from "./FactoryIssueWorkView";
import { FactoryIssueSection } from "./FactoryIssueActions";
import {
  factoryIssueDisplayKey,
  factoryIssueKeyOf,
  factoryIssueTargetOf,
  resolveFactoryIssueOpenRoute,
} from "./factoryIssues.logic";
import { factoryIssueLayout, type FactoryIssueLayout } from "./factoryIssues.views";
import { useFactoryClaims } from "./useFactoryClaims";
import { useOpenFactoryIssue } from "./useOpenFactoryIssue";

import { useSettingsScope } from "../settings/SettingsScopeContext";
import { singleFactoryMember } from "./factoryScope";

export function FactoryIssuesPage() {
  const gt = useGT();
  const messages = useMessages();
  const search = useSearch({ from: "/_chat/factory" });
  const navigate = useNavigate({ from: "/factory/issues" });
  const { scope, groups, selectScope } = useSettingsScope();
  const { isReady, environments } = useEnvironments();
  const allProjects = useProjects();
  const readableIds = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const member = singleFactoryMember(scope);
  const environment = environments.find(
    (candidate) => candidate.environmentId === member?.environmentId,
  );
  const canRead = useEnvironmentScope(member?.environmentId ?? null, AuthOrchestrationReadScope);
  const project = allProjects.find(
    (candidate) => candidate.environmentId === member?.environmentId && candidate.id === member?.id,
  );
  const state = search.state;

  if (scope.kind === "unavailable") return null;
  if (!isReady) {
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="factory-issues-title">
      <div className="space-y-1">
        <h2 id="factory-issues-title" className="font-medium text-lg">
          <T>Issue queue</T>
        </h2>
        <p className="text-muted-foreground text-sm">
          <T>
            Review issues in one checkout before starting isolated, supervised work. Read and
            discuss an issue on the Issues page.
          </T>
        </p>
      </div>
      {member === null ? (
        <FactoryCheckoutChooser
          scope={scope}
          groups={groups}
          environments={environments}
          intro={gt(
            "Choose a checkout to open its issue queue. Checkouts of the same repository may share issues; they are not combined into a global queue.",
          )}
          emptyDescription={gt(
            "Connect an environment and add a repository checkout to use the issue queue.",
          )}
          statusFor={(owner) =>
            !owner
              ? gt("Environment unavailable")
              : owner.connection.phase !== "connected"
                ? gt("Offline. Reconnect to read issues")
                : owner.serverConfig === null
                  ? gt("Server capabilities unknown")
                  : owner.serverConfig.environment.capabilities.factoryIssues !== true
                    ? gt("Issue queue unsupported. Update this server")
                    : !readableIds.has(owner.environmentId)
                      ? gt("Read access unavailable")
                      : gt("Connected · issue queue available")
          }
          onChoose={selectScope}
        />
      ) : !environment || !project ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={gt("Checkout unavailable")}
          description={gt("This checkout is no longer available. Choose another scope.")}
        />
      ) : environment.connection.phase !== "connected" ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={gt("Environment offline")}
          description={gt("Reconnect {environment} to read this checkout''s issues.", {
            environment: environment.label,
          })}
        />
      ) : environment.serverConfig === null ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={gt("Server capabilities unknown")}
          description={gt(
            "Wait for this environment to finish connecting before opening its queue.",
          )}
        />
      ) : environment.serverConfig.environment.capabilities.factoryIssues !== true ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={gt("Issue queue unsupported")}
          description={gt("Update the server on {environment} to use the issue queue.", {
            environment: environment.label,
          })}
        />
      ) : !canRead ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={gt("Read access unavailable")}
          description={gt("This connection needs orchestration read access to list issues.")}
        />
      ) : (
        <>
          <ToggleGroup
            aria-label={gt("Issue state")}
            value={[state]}
            onValueChange={(values) => {
              const next = values[0];
              if (next !== undefined) {
                void navigate({
                  search: (previous) => ({ ...previous, state: parseFactoryStateFilter(next) }),
                  replace: true,
                });
              }
            }}
          >
            {FACTORY_STATE_FILTERS.map((filter) => (
              <Toggle key={filter.value} value={filter.value}>
                {messages(filter.label)}
              </Toggle>
            ))}
          </ToggleGroup>
          {search.reviewIssue !== undefined ? (
            <FactoryReviewIssue
              key={search.reviewIssue}
              environmentId={environment.environmentId}
              project={project}
              issueKey={search.reviewIssue}
              onDismiss={() => {
                void navigate({
                  search: (previous) => ({ ...previous, reviewIssue: undefined }),
                  replace: true,
                });
              }}
            />
          ) : (
            <FactoryIssueQueue
              key={factoryScopeKey(environment.environmentId, project.id, state)}
              environmentId={environment.environmentId}
              project={project}
              projectTitleById={
                new Map(
                  allProjects
                    .filter((candidate) => candidate.environmentId === environment.environmentId)
                    .map((candidate) => [candidate.id, candidate.title]),
                )
              }
              state={state}
              layout={factoryIssueLayout(search.view)}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * A link that names an issue by number, from before the Issues page held the reading and the
 * start. It reads the issue once to learn where it lives, then hands the reader to its panel.
 */
function FactoryReviewIssue(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly issueKey: number | string;
  readonly onDismiss: () => void;
}) {
  const { environmentId, project, issueKey } = props;
  const gt = useGT();
  const messages = useMessages();
  const keysSupported = useFactoryIssueKeysSupported(environmentId);
  const target = keysSupported
    ? { key: String(issueKey) }
    : typeof issueKey === "number"
      ? { issueNumber: issueKey }
      : null;
  const query = useEnvironmentQuery(
    target === null
      ? null
      : factoryEnvironment.readIssue({
          environmentId,
          input: { projectId: project.id, ...target },
        }),
  );
  const resolveOpener = useOpenFactoryIssue({ environmentId, projectId: project.id });
  const handled = useRef<string | null>(null);
  const url = query.data?.issue.url ?? null;
  const opener = url === null ? null : resolveOpener(url);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Hands the linked issue to the Issues page once its address is read.
  useEffect(() => {
    if (url === null || opener === null || handled.current === url) return;
    handled.current = url;
    opener({ replace: true });
  }, [url, opener]);

  if (target === null) {
    return (
      <FactoryEmptyState
        icon={<CircleDotIcon />}
        title={gt("Issue could not be opened")}
        description={gt(
          "This server cannot open issue {issueKey} by its tracker key. Update the server to open it.",
          { issueKey },
        )}
        action={
          <Button size="sm" variant="outline" onClick={props.onDismiss}>
            <T>Show the issue queue</T>
          </Button>
        }
      />
    );
  }
  if (query.error !== null) {
    const failure = describeFactoryFailure(
      query.failure,
      query.error,
      query.data?.capabilities.displayName,
      messages,
    );
    return (
      <FactoryEmptyState
        icon={<FactoryIcon />}
        title={failure.title}
        description={failure.message}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={query.refresh}
              disabled={query.isPending}
              aria-busy={query.isPending}
            >
              <RefreshIcon size="sm" refreshing={query.isPending} />
              <T>Retry</T>
            </Button>
            <Button size="sm" variant="outline" onClick={props.onDismiss}>
              <T>Show the issue queue</T>
            </Button>
          </div>
        }
      />
    );
  }
  if (query.data !== null && opener === null) {
    const { displayName } = query.data.capabilities;
    const href = safeExternalUrl(query.data.issue.url);
    return (
      <FactoryEmptyState
        icon={<CircleDotIcon />}
        title={gt("Issue could not be opened")}
        description={gt(
          "The Issues page could not open issue {issueKey}. Open it on {displayName} instead.",
          { issueKey: factoryIssueDisplayKey(query.data.issue), displayName },
        )}
        action={
          <div className="flex flex-wrap gap-2">
            {href ? (
              <Button
                size="sm"
                variant="outline"
                render={<a href={href} target="_blank" rel="noopener noreferrer" />}
              >
                <T>
                  Open on <Var>{displayName}</Var>
                </T>
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={props.onDismiss}>
              <T>Show the issue queue</T>
            </Button>
          </div>
        }
      />
    );
  }
  return (
    <div className="space-y-3" aria-busy>
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

function FactoryIssueQueue(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
  readonly state: FactoryIssueStateFilter;
  readonly layout: FactoryIssueLayout;
}) {
  const { environmentId, project, state, layout } = props;
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  const [pages, setPages] = useState<ReadonlyArray<number>>([1]);
  const page = currentFactoryPage(pages);
  const keysSupported = useFactoryIssueKeysSupported(environmentId);
  const query = useEnvironmentQuery(
    factoryEnvironment.list({
      environmentId,
      input: { projectId: project.id, state, page, ...factoryIssueKeysInput(keysSupported) },
    }),
  );
  const canStart = useAtomValue(factoryEnvironment.start.permissionAtom(environmentId));
  const claims = useFactoryClaims({ environmentId, project });
  const resolveOpener = useOpenFactoryIssue({ environmentId, projectId: project.id });
  const panelAvailable =
    useServerConfigs().get(environmentId)?.environment.capabilities.issues === true;
  const [inlineIssue, setInlineIssue] = useState<FactoryIssue | null>(null);
  // Claims have no timer: every explicit refresh observes them again with the list.
  const refreshAll = () => {
    query.refresh();
    claims?.refresh();
  };

  const openIssue = (issue: FactoryIssue) => {
    const open = resolveOpener(issue.url);
    const route = resolveFactoryIssueOpenRoute({
      panelAvailable,
      panelResolves: open !== null,
      startable: factoryIssueTargetOf(issue, keysSupported) !== null,
    });
    if (route === "panel") {
      open?.();
      return;
    }
    if (route === "inline-start") {
      setInlineIssue(issue);
      return;
    }
    const href = safeExternalUrl(issue.url);
    if (href !== null) window.open(href, "_blank", "noopener,noreferrer");
  };
  const inlineTarget =
    inlineIssue === null ? null : factoryIssueTargetOf(inlineIssue, keysSupported);

  const openTask = (task: NonNullable<FactoryIssue["task"]>) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, task.threadId)),
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

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RepositoryTarget repository={data?.repository ?? null} projectTitle={project.title} />
        <div className="flex flex-wrap items-center gap-2">
          {data ? (
            <span className="text-muted-foreground text-xs">
              <T>
                Updated{" "}
                <Var>
                  <RelativeTime timestamp={data.fetchedAt} />
                </Var>
              </T>
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={refreshAll}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            <RefreshIcon size="sm" refreshing={refreshing} />
            <T>Refresh</T>
          </Button>
        </div>
      </div>

      {!canStart ? (
        <Alert variant="warning">
          <AlertDescription>
            <T>
              This connection cannot start tasks. Starting needs orchestration and source control
              write access; existing tasks can still be opened.
            </T>
          </AlertDescription>
        </Alert>
      ) : null}

      <FactoryClaimsUnavailableNote note={claims?.unavailableNote ?? null} />

      {inlineIssue !== null && inlineTarget !== null ? (
        <div className="space-y-2 rounded-lg border border-border/60 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 font-medium text-sm [overflow-wrap:anywhere]">
              {inlineIssue.title}
            </p>
            <Button size="sm" variant="ghost" onClick={() => setInlineIssue(null)}>
              <T>Close</T>
            </Button>
          </div>
          <FactoryIssueSection
            key={factoryIssueKeyOf(inlineIssue) ?? inlineIssue.url}
            environmentId={environmentId}
            project={project}
            target={inlineTarget}
          />
        </div>
      ) : null}

      {failure !== null ? (
        <FactoryEmptyState
          icon={<FactoryIcon />}
          title={failure.title}
          description={failure.message}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={refreshAll}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
              <T>Retry</T>
            </Button>
          }
        />
      ) : data === null ? (
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <>
          <p className="text-muted-foreground text-xs">
            {state === "open"
              ? gt(
                  "Source filter: Open. Page {page} only, not all project work. Tasks linked to closed issues appear under Closed or All.",
                  { page },
                )
              : state === "closed"
                ? gt("Source filter: Closed. Page {page} only, not all project work.", { page })
                : gt("Source filter: All. Page {page} only, not all project work.", { page })}
          </p>
          {data.issues.length === 0 ? (
            <FactoryEmptyState
              icon={<CircleDotIcon />}
              title={
                state === "open"
                  ? gt("No open issues on this page")
                  : state === "closed"
                    ? gt("No closed issues on this page")
                    : gt("No issues on this page")
              }
              description={
                data.nextPage === null
                  ? gt("Nothing to show for this filter.")
                  : gt("{displayName} returned no issues on this page, but more pages exist.", {
                      displayName: data.capabilities.displayName,
                    })
              }
            />
          ) : (
            <FactoryIssueWorkView
              key={`${data.repository.canonicalKey}:${page}`}
              environmentId={environmentId}
              layout={layout}
              issues={data.issues}
              selectedProjectId={project.id}
              projectTitleById={props.projectTitleById}
              refreshing={refreshing}
              claims={claims}
              repository={data.repository}
              capabilities={data.capabilities}
              onOpenIssue={openIssue}
              onOpenTask={openTask}
            />
          )}
          <div className="flex items-center justify-between gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || refreshing}
              onClick={() => setPages(popFactoryPage(pages))}
            >
              <ChevronLeftIcon />
              <T>Previous</T>
            </Button>
            <span className="text-muted-foreground text-xs">
              <T>
                Page <Var>{page}</Var>
              </T>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={data.nextPage === null || refreshing}
              onClick={() => {
                if (data.nextPage !== null) setPages(pushFactoryPage(pages, data.nextPage));
              }}
            >
              <T>Next</T>
              <ChevronRightIcon />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function RepositoryTarget(props: {
  readonly repository: FactoryRepository | null;
  readonly projectTitle: string;
}) {
  const gt = useGT();
  const href = props.repository ? safeExternalUrl(props.repository.url) : null;
  return (
    <div className="min-w-0 space-y-0.5">
      <p className="text-muted-foreground text-xs">
        <T>Issues from</T>
      </p>
      {props.repository ? (
        <p className="flex min-w-0 items-center gap-1.5 font-medium text-sm">
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate underline-offset-4 hover:underline"
            >
              {props.repository.host}/{props.repository.repository}
            </a>
          ) : (
            <span className="min-w-0 truncate">
              {props.repository.host}/{props.repository.repository}
            </span>
          )}
          <ExternalLinkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          {gt("Resolving {projectTitle}''s repository…", { projectTitle: props.projectTitle })}
        </p>
      )}
    </div>
  );
}
