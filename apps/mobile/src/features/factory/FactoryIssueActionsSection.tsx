import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationReadScope,
  EnvironmentId,
  ProjectId,
  type FactoryClaimListResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { T, useGT, useMessages, Var } from "gt-react-native";
import { use, useMemo, type ReactNode } from "react";
import { View } from "react-native";

import { StatusPill } from "../../components/StatusPill";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  factoryEnvironment,
  factoryIssueKeysInput,
  factoryIssueKeysSupportedAtom,
} from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { PullRequestSectionHeading } from "../pull-requests/PullRequestSectionHeading";
import type { IssueParams } from "../issues/issueParams";
import { useFactoryInboxSelection } from "./factory-inbox-state";
import { factoryTaskStatusPill } from "./FactoryIssueRow";
import { FactoryAcceptedCommitSection } from "./FactoryAcceptedCommitSection";
import { FactoryIssueReviewModal } from "./FactoryIssueReviewModal";
import {
  claimsElsewhere,
  describeClaimsElsewhere,
  describeFactoryFailure,
  describeUnavailableClaims,
  factoryIssueAction,
  factoryIssueKeyOf,
  originKeyForFactoryIssue,
  planClaimTargets,
  resolveFactoryIssueSection,
  type FactoryClaimsUnavailable,
  type FactoryIssueTarget,
} from "./factoryIssues";
import { useFactoryIssueActions, type FactoryStartSettings } from "./useFactoryIssueActions";
import { useFactoryLaunchModel } from "./useFactoryLaunch";

const claimListTargets = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId })),
);

/**
 * One claim list per target environment, read together so the warning compares one consistent
 * set. Nothing refreshes on a timer: a claim another environment just admitted appears only on
 * an explicit refresh.
 */
const factoryClaimListsAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    Schema.decodeSync(claimListTargets)(key).map((target) => ({
      environmentId: target.environmentId,
      result: get(
        factoryEnvironment.listClaims({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            ...factoryIssueKeysInput(get(factoryIssueKeysSupportedAtom(target.environmentId))),
          },
        }),
      ),
    })),
  ).pipe(Atom.setIdleTTL(0), Atom.withLabel("mobile-factory-issue-claim-lists")),
);

interface FactoryIssueClaims {
  /** Only environments that answered. An absent environment is unknown, never "no claims". */
  readonly claimsByEnvironment: ReadonlyMap<EnvironmentId, FactoryClaimListResult>;
  /** Wording for environments that may hold claims but did not answer, or null when all did. */
  readonly unavailableNote: string | null;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly refresh: () => void;
}

/**
 * Claims for the issue's repository across every connected environment that holds a checkout of
 * it. Null while the environment does not advertise `factoryClaims`, so older servers show no
 * claim UI at all rather than a half-informed one.
 */
function useFactoryIssueClaims(input: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
}): FactoryIssueClaims | null {
  const { environmentId, project } = input;
  const messages = useMessages();
  const supported =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.factoryClaims === true;
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const readableIds = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const registry = use(RegistryContext);

  const plan = planClaimTargets({
    current: {
      environmentId,
      projectId: project.id,
      repositoryKey: project.repositoryIdentity?.canonicalKey ?? null,
    },
    environments: environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      connected: environment.connection.phase === "connected",
      claimsSupported: environment.serverConfig?.environment.capabilities.factoryClaims === true,
      canRead: readableIds.has(environment.environmentId),
    })),
    projects: allProjects.map((candidate) => ({
      environmentId: candidate.environmentId,
      id: candidate.id,
      repositoryKey: candidate.repositoryIdentity?.canonicalKey ?? null,
    })),
  });
  const targets = supported ? plan.targets : [];
  const lists = useAtomValue(factoryClaimListsAtom(JSON.stringify(targets)));

  const claimsByEnvironment = new Map<EnvironmentId, FactoryClaimListResult>();
  const failed: FactoryClaimsUnavailable[] = [];
  for (const { environmentId: target, result } of lists) {
    // A failed refetch keeps the previous success in the result; stale claims would read as
    // current, so a failure is reported as unreadable and its old data is dropped.
    if (result._tag === "Failure") {
      failed.push({ environmentId: target, reason: "failed" });
      continue;
    }
    if (result._tag === "Success") claimsByEnvironment.set(target, result.value);
  }

  if (!supported) return null;
  const labelOf = (id: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === id)?.label ?? id;
  return {
    claimsByEnvironment,
    unavailableNote: describeUnavailableClaims([...plan.unavailable, ...failed], labelOf, messages),
    labelOf,
    refresh: () => {
      for (const target of targets) {
        registry.refresh(
          factoryEnvironment.listClaims({
            environmentId: target.environmentId,
            input: {
              projectId: target.projectId,
              ...factoryIssueKeysInput(
                registry.get(factoryIssueKeysSupportedAtom(target.environmentId)),
              ),
            },
          }),
        );
      }
    },
  };
}

/**
 * The Factory's part of an issue: its task and claims, and the one place a task is started from.
 * Nothing renders unless the server runs the Factory and the issue is one it can address, so
 * trackers it cannot reach see the plain issue. Mirrors the web's `FactoryIssueActions`.
 */
export function FactoryIssueActionsSection(props: { readonly params: IssueParams }) {
  const environmentId = EnvironmentId.make(props.params.environmentId);
  const config = useEnvironmentServerConfig(environmentId);
  const factoryIssues = config?.environment.capabilities.factoryIssues === true;
  const factoryIssueKeys = config?.environment.capabilities.factoryIssueKeys === true;
  const project = useProjects().find(
    (candidate) =>
      candidate.environmentId === environmentId && String(candidate.id) === props.params.projectId,
  );
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const target = resolveFactoryIssueSection({
    factoryIssues,
    factoryIssueKeys,
    key: props.params.issueKey,
  });
  if (target === null || project === undefined || !canRead) return null;
  return (
    <FactoryIssueSection
      environmentId={environmentId}
      project={project}
      target={target}
      factoryIssueKeys={factoryIssueKeys}
    />
  );
}

function FactoryIssueSection(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly target: FactoryIssueTarget;
  readonly factoryIssueKeys: boolean;
}) {
  const { environmentId, project, target, factoryIssueKeys } = props;
  const gt = useGT();
  const messages = useMessages();
  const allProjects = useProjects();
  const issueKey = "key" in target ? target.key : String(target.issueNumber);
  const query = useEnvironmentQuery(
    factoryEnvironment.readIssue({
      environmentId,
      input: { projectId: project.id, ...target },
    }),
  );
  const canStart = useAtomValue(factoryEnvironment.start.permissionAtom(environmentId));
  const claims = useFactoryIssueClaims({ environmentId, project });
  const selection = useFactoryInboxSelection();
  const launch = useFactoryLaunchModel({
    ...selection,
    environmentId,
    projectId: project.id,
  });

  const defaultModelLabel = gt("Default model");
  const settings: FactoryStartSettings | null = useMemo(
    () =>
      query.data === null
        ? null
        : {
            environmentId,
            projectId: project.id,
            repository: query.data.repository,
            displayName: query.data.capabilities.displayName,
            factoryIssueKeys,
            modelSelection: launch.modelSelection,
            modelLabel: launch.label ?? defaultModelLabel,
            baseRef: selection.baseRef,
            runtimeMode: selection.runtimeMode,
          },
    [
      environmentId,
      project.id,
      query.data,
      factoryIssueKeys,
      launch.modelSelection,
      launch.label,
      defaultModelLabel,
      selection.baseRef,
      selection.runtimeMode,
    ],
  );
  const actions = useFactoryIssueActions({
    settings,
    scopeKey: JSON.stringify([environmentId, project.id, issueKey, canStart]),
    onSettled: () => {
      query.refresh();
      claims?.refresh();
    },
  });

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

  let body: ReactNode;
  if (failure !== null) {
    body = (
      <View accessibilityRole="alert" className="gap-1">
        <Text className="text-sm font-t3-semibold text-danger-foreground">{failure.title}</Text>
        <Text selectable className="text-xs text-foreground-muted">
          {failure.detail}
        </Text>
      </View>
    );
  } else if (data === null) {
    body = (
      <View className="items-center py-3">
        <AppActivityIndicator
          colorClassName="accent-icon"
          accessibilityLabel={gt("Loading Factory state")}
        />
      </View>
    );
  } else {
    const { issue, repository } = data;
    const action = factoryIssueAction(issue, messages, factoryIssueKeys);
    const originKey = originKeyForFactoryIssue(repository, issue);
    const claimWarning =
      claims === null
        ? null
        : describeClaimsElsewhere(
            claimsElsewhere(claims.claimsByEnvironment, originKey, environmentId),
            claims.labelOf,
            messages,
          );
    const taskProjectTitle =
      issue.task !== null && issue.task.projectId !== project.id
        ? (allProjects.find(
            (candidate) =>
              candidate.environmentId === environmentId && candidate.id === issue.task?.projectId,
          )?.title ?? gt("another project"))
        : null;
    const needsStart =
      action.kind === "start" || action.kind === "resume" || action.kind === "restart";
    const startAllowed =
      canStart && (issue.task?.status === "launching" || launch.modelSelection !== null);
    body = (
      <>
        {!canStart && needsStart ? (
          <View className="gap-1 rounded-2xl border border-warning-border bg-warning p-3">
            <Text className="text-xs leading-snug text-warning-foreground">
              <T>
                This connection cannot start tasks. Starting needs orchestration and source control
                write access; existing tasks can still be opened.
              </T>
            </Text>
          </View>
        ) : null}
        {claimWarning !== null ? (
          <View className="gap-1 rounded-2xl border border-warning-border bg-warning p-3">
            <Text className="text-xs leading-snug text-warning-foreground">{claimWarning}</Text>
          </View>
        ) : null}
        {issue.task !== null ? (
          <View className="gap-1.5">
            <View className="flex-row flex-wrap items-center gap-2">
              <StatusPill size="compact" {...factoryTaskStatusPill(issue.task.status, messages)} />
              <Text className="text-xs text-foreground-muted" selectable>
                {gt("Base {base} · started {time}", {
                  base: issue.task.baseRef.slice(0, 12),
                  time: new Date(issue.task.createdAt).toLocaleString(),
                })}
              </Text>
            </View>
            {taskProjectTitle !== null ? (
              <Text className="text-xs text-foreground-muted">
                <T>
                  Task lives in project <Var>{taskProjectTitle}</Var>.
                </T>
              </Text>
            ) : null}
          </View>
        ) : (
          <Text className="text-sm text-foreground-muted">
            <T>No Factory task has been started for this issue.</T>
          </Text>
        )}
        {action.kind === "unavailable" ? (
          <Text className="text-sm text-foreground-muted">{action.detail}</Text>
        ) : (
          <Button
            label={action.label}
            tone={action.kind === "open" ? "secondary" : "primary"}
            accessibilityLabel={gt("{action} for issue {number}", {
              action: action.label,
              number: factoryIssueKeyOf(issue) ?? issueKey,
            })}
            loading={actions.busyIssue === (factoryIssueKeyOf(issue) ?? issueKey)}
            disabled={needsStart && !startAllowed}
            onPress={() => actions.perform(issue, action)}
          />
        )}
        {action.kind === "open" && issue.number !== null ? (
          <FactoryAcceptedCommitSection
            environmentId={environmentId}
            projectId={action.task.projectId}
            threadId={action.task.threadId}
            issue={{ number: issue.number, title: issue.title, url: issue.url }}
            capabilities={data.capabilities}
          />
        ) : null}
        {actions.review ? (
          <FactoryIssueReviewModal
            review={actions.review}
            pending={actions.busyIssue !== null}
            onClose={actions.closeReview}
            onConfirm={actions.confirmReview}
          />
        ) : null}
      </>
    );
  }

  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-2">
        <PullRequestSectionHeading>
          <T>Factory</T>
        </PullRequestSectionHeading>
        <Button
          tone="text"
          label={gt("Refresh")}
          icon="arrow.clockwise"
          accessibilityLabel={gt("Refresh Factory state")}
          disabled={query.isPending}
          onPress={() => {
            query.refresh();
            claims?.refresh();
          }}
        />
      </View>
      {claims?.unavailableNote ? (
        <Text className="text-xs text-foreground-muted">{claims.unavailableNote}</Text>
      ) : null}
      {body}
    </View>
  );
}
