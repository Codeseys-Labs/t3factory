import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  StackActions,
  useNavigation,
  usePreventRemove,
  useRoute,
  type RouteProp,
} from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import {
  factoryWorkKey,
  parseFactoryWorkSelection,
  selectFactoryWorkDetail,
} from "@t3tools/client-runtime/state/factory-work";
import {
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  type EnvironmentId,
  type FactoryWorkReadResult,
  type FactoryWorkRef,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { use } from "react";
import { Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { factoryEnvironment, factoryIssueKeysInput } from "../../state/factory";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope } from "../../state/session";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  factoryWorkHistoryFor,
  moveFactoryWorkHistoryPage,
  openFactoryWorkReview,
  selectFactoryWorkHistory,
  selectFactoryWorkItem,
  useFactoryInboxSelection,
  useFactoryWorkView,
  type FactoryWorkDetailParams,
} from "./factory-inbox-state";
import { safeFactoryIssueUrl } from "./factoryIssues";
import {
  FACTORY_WORK_KIND_LABELS,
  FACTORY_WORK_HISTORY_MAX_PAGES,
  FACTORY_WORK_OWNER_MESSAGES,
  FACTORY_WORK_PAGE_LIMIT,
  factoryWorkAccess,
  resolveFactoryWorkReview,
} from "./factoryWorkList";
import type { FactoryWorkRoutes } from "./FactoryWorkSection";
import { FactoryWorkPrerequisites } from "./FactoryWorkPrerequisites";
import { useOpenFactoryThread } from "./useFactoryIssueActions";

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

type DetailRoutes = FactoryWorkRoutes & { SettingsFactoryIssues: undefined };

const HISTORY_TITLES = {
  executions: msg("Executions"),
  runs: msg("Runs"),
  attempts: msg("Retry attempts"),
  outputs: msg("Outputs, acceptance and publication"),
} as const;

const HISTORY_EMPTY = {
  executions: msg("No retained executions. An unstarted item is not completed."),
  runs: msg("No retained runs. An unstarted item is not completed."),
  attempts: msg("No retained retry attempts. An unstarted item is not completed."),
  outputs: msg(
    "No retained outputs, acceptance and publication. An unstarted item is not completed.",
  ),
} as const;

function Line(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-0.5 border-t border-border-subtle px-4 py-3">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text className="text-base text-foreground" selectable>
        {props.value}
      </Text>
    </View>
  );
}

function workHistoryQuery(
  reference: FactoryWorkRef,
  history: ReturnType<typeof factoryWorkHistoryFor>,
) {
  return factoryEnvironment.readWorkHistory({
    environmentId: reference.environmentId,
    input: {
      ref: reference,
      ...history.selection,
      cursor: history.cursors.at(-1),
      limit: FACTORY_WORK_PAGE_LIMIT,
    },
  });
}

function WorkHistory(props: { readonly reference: FactoryWorkRef; readonly work: string }) {
  const { reference, work } = props;
  const gt = useGT();
  const messages = useMessages();
  const view = useFactoryWorkView();
  const openThread = useOpenFactoryThread();
  const history = factoryWorkHistoryFor(view, work);
  const query = useEnvironmentQuery(workHistoryQuery(reference, history));
  const data = query.error === null ? query.data : null;
  const section = history.selection.section;
  const pageLimitReached = history.cursors.length + 1 >= FACTORY_WORK_HISTORY_MAX_PAGES;
  return (
    <SettingsSection title={messages(HISTORY_TITLES[section])}>
      <View className="gap-3 px-4 py-3">
        {section !== "executions" ? (
          <View className="items-start">
            <Button
              tone="text"
              label={gt("Back to executions")}
              onPress={() => selectFactoryWorkHistory(work, { section: "executions" })}
            />
          </View>
        ) : null}
        {section === "outputs" ? (
          <Text className="text-xs text-foreground-muted">
            <T>
              Acceptance pins don't assert currentness. An unknown publication never authorizes a
              retry. Exact evidence and delivery stay in the native review.
            </T>
          </Text>
        ) : null}
        {query.error ? (
          <View className="items-start gap-2">
            <Text className="text-sm text-danger-foreground">{query.error}</Text>
            <Button label={gt("Try again")} onPress={query.refresh} />
          </View>
        ) : data === null ? (
          <Text className="text-sm text-foreground-muted">
            <T>Loading history…</T>
          </Text>
        ) : data.entries.length === 0 ? (
          <Text className="text-sm text-foreground-muted">{messages(HISTORY_EMPTY[section])}</Text>
        ) : (
          data.entries.map((entry) => (
            <View key={entry.id} className="gap-2 rounded-2xl border border-border-subtle p-3">
              <Text className="text-sm text-foreground" selectable>
                {entry.superseded
                  ? gt("{label} · {state} · superseded", {
                      label: entry.label,
                      state: entry.state,
                    })
                  : gt("{label} · {state}", { label: entry.label, state: entry.state })}
              </Text>
              <Text className="text-xs text-foreground-muted" selectable>
                {entry.id}
              </Text>
              {entry.pin ? (
                <Text className="font-mono text-xs text-foreground-muted" selectable>
                  {gt("Pin: {pin}", { pin: entry.pin })}
                </Text>
              ) : null}
              <View className="flex-row flex-wrap gap-2">
                <Button
                  label={gt("Open owning thread")}
                  disabled={entry.state === "missing" || entry.state === "reserved or missing"}
                  onPress={() => openThread(reference.environmentId, entry.threadId)}
                />
                {section === "executions" ? (
                  <>
                    <Button
                      label={gt("Runs")}
                      accessibilityLabel={gt("Runs of {label}", { label: entry.label })}
                      onPress={() =>
                        selectFactoryWorkHistory(work, {
                          section: "runs",
                          threadId: entry.threadId,
                        })
                      }
                    />
                    <Button
                      label={gt("Outputs")}
                      accessibilityLabel={gt("Outputs, acceptance and publication of {label}", {
                        label: entry.label,
                      })}
                      onPress={() =>
                        selectFactoryWorkHistory(work, {
                          section: "outputs",
                          threadId: entry.threadId,
                        })
                      }
                    />
                  </>
                ) : section === "runs" && entry.runId !== null ? (
                  <Button
                    label={gt("Retry attempts")}
                    accessibilityLabel={gt("Retry attempts of {label}", { label: entry.label })}
                    onPress={() =>
                      selectFactoryWorkHistory(work, {
                        section: "attempts",
                        threadId: entry.threadId,
                        runId: entry.runId ?? undefined,
                      })
                    }
                  />
                ) : null}
              </View>
            </View>
          ))
        )}
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={gt("Previous page")}
            accessibilityLabel={gt("Previous history page")}
            disabled={history.cursors.length === 0}
            onPress={() => moveFactoryWorkHistoryPage(work, null)}
          />
          <Button
            label={gt("Next page")}
            accessibilityLabel={gt("Next history page")}
            disabled={!data?.nextCursor || pageLimitReached}
            onPress={() => {
              if (data?.nextCursor) moveFactoryWorkHistoryPage(work, data.nextCursor);
            }}
          />
        </View>
        {data?.nextCursor && pageLimitReached ? (
          <Text className="text-xs text-foreground-muted">
            <T>
              History page limit reached. Earlier pages remain available; choose a narrower history
              section to inspect more.
            </T>
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}

function WorkDetail(props: {
  readonly reference: FactoryWorkRef;
  readonly work: string;
  readonly data: FactoryWorkReadResult;
  readonly projectLabel: (projectId: ProjectId) => string | null;
  readonly capabilities: { readonly factoryIssues?: boolean; readonly factoryKnowledge?: boolean };
  readonly routeContext: FactoryWorkDetailParams;
}) {
  const { reference, work, data } = props;
  const gt = useGT();
  const messages = useMessages();
  const navigation = useNavigation<NativeStackNavigationProp<DetailRoutes>>();
  const openThread = useOpenFactoryThread();
  const scope = useFactoryInboxSelection();
  const view = useFactoryWorkView();
  const canStartIssue = useAtomValue(
    factoryEnvironment.start.permissionAtom(reference.environmentId),
  );
  const canStartBrief = useAtomValue(
    factoryEnvironment.startKnowledgeTask.permissionAtom(reference.environmentId),
  );
  const review = resolveFactoryWorkReview({
    detail: data,
    reviewProjectKnown:
      data.reviewProjectId !== null && props.projectLabel(data.reviewProjectId) !== null,
    capabilities: props.capabilities,
    canOperate: reference.kind === "issue" ? canStartIssue : canStartBrief,
    resolve: messages,
  });
  const sourceUrl = data.item.sourceUrl === null ? null : safeFactoryIssueUrl(data.item.sourceUrl);
  const openRelated = (id: string) => {
    const related = { ...reference, id };
    selectFactoryWorkItem(factoryWorkKey(related));
    navigation.push("SettingsFactoryWork", { work: JSON.stringify(related) });
  };
  const revisionLabel =
    reference.kind === "protocol"
      ? gt("Protocol")
      : reference.kind === "brief"
        ? gt("Brief")
        : gt("Source");
  return (
    <>
      <SettingsSection title={messages(FACTORY_WORK_KIND_LABELS[reference.kind])}>
        <View className="gap-1 px-4 py-3">
          <Text className="text-lg font-t3-medium text-foreground" selectable>
            {data.item.title}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {gt("Observed {observed} · created {created}", {
              observed: new Date(data.fetchedAt).toLocaleString(),
              created: new Date(data.item.createdAt).toLocaleString(),
            })}
          </Text>
        </View>
        <Line
          label={gt("Admission or authoring project")}
          value={
            data.projectAvailable
              ? (props.projectLabel(data.item.projectId) ??
                gt("{project} (unavailable here)", { project: data.item.projectId }))
              : gt("{project} · no longer available on its server", {
                  project:
                    props.projectLabel(data.item.projectId) ??
                    gt("{project} (unavailable here)", { project: data.item.projectId }),
                })
          }
        />
        <Line
          label={gt("Current native review project")}
          value={
            data.reviewProjectId === null
              ? gt("Unavailable")
              : (props.projectLabel(data.reviewProjectId) ??
                gt("{project} (unavailable here)", { project: data.reviewProjectId }))
          }
        />
        <Line
          label={gt("Source")}
          value={[
            reference.kind === "protocol"
              ? gt("Sealed protocol.")
              : reference.kind === "brief"
                ? gt("Authored brief.")
                : gt("Source snapshot saved at admission."),
            data.item.sourceState === null
              ? null
              : gt("Source state then: {state}.", { state: data.item.sourceState }),
            data.item.revision === null
              ? gt("No stored revision.")
              : gt("{label} revision {revision}.", {
                  label: revisionLabel,
                  revision: String(data.item.revision),
                }),
            data.item.sourceUrl ?? null,
          ]
            .filter((part): part is string => part !== null)
            .join(" ")}
        />
        <Line
          label={gt("Planning and runtime")}
          value={gt(
            "Planning stage unavailable. Runtime is shown per execution below; idle is not completion.",
          )}
        />
      </SettingsSection>

      <SettingsSection title={gt("Intent snapshot")}>
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground" selectable>
            {data.snapshot}
          </Text>
          {data.snapshotTruncated ? (
            <Text className="text-xs text-foreground-muted">
              <T>Preview truncated. The native review holds the full intent.</T>
            </Text>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection title={gt("Actions")}>
        <View className="items-start gap-3 px-4 py-3">
          {review.kind === "open" ? (
            <>
              <Button
                tone="primary"
                label={review.label}
                accessibilityHint={
                  review.section === "issues"
                    ? gt("Opens Issues for the review project. Back to Work returns here.")
                    : gt("Opens Briefs for the review project. Back to Work returns here.")
                }
                onPress={() => {
                  openFactoryWorkReview({
                    environmentId: reference.environmentId,
                    projectId: review.projectId,
                    section: review.section,
                    work,
                    returnTo: props.routeContext.returnTo,
                  });
                  navigation.dispatch(StackActions.push("SettingsFactoryIssues"));
                }}
              />
              {review.operateNote ? (
                <Text className="text-sm text-foreground-muted">{review.operateNote}</Text>
              ) : null}
            </>
          ) : (
            <Text className="text-sm text-foreground-muted">{review.reason}</Text>
          )}
          {sourceUrl ? (
            <Button
              label={gt("Open live source separately")}
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(sourceUrl)}
            />
          ) : null}
          {data.projectCoordinatorThreadId !== null ? (
            <Button
              label={gt("Project coordinator context")}
              onPress={() => {
                if (data.projectCoordinatorThreadId)
                  openThread(reference.environmentId, data.projectCoordinatorThreadId);
              }}
            />
          ) : null}
          {data.supersedes !== null ? (
            <Button
              label={gt("Previous concrete brief")}
              accessibilityLabel={gt("Previous concrete brief {id}", { id: data.supersedes })}
              onPress={() => {
                if (data.supersedes) openRelated(data.supersedes);
              }}
            />
          ) : null}
          {data.item.supersededBy !== null ? (
            <Button
              label={gt("Replacement brief")}
              accessibilityLabel={gt("Replacement brief {id}", { id: data.item.supersededBy })}
              onPress={() => {
                if (data.item.supersededBy) openRelated(data.item.supersededBy);
              }}
            />
          ) : null}
          <Text className="text-xs text-foreground-muted">
            <T>
              The project coordinator is project context, not this item's provenance. Inspecting
              Work doesn't launch, reconcile, accept or publish.
            </T>
          </Text>
        </View>
      </SettingsSection>

      <FactoryWorkPrerequisites
        key={factoryWorkKey(reference)}
        reference={reference}
        status="current"
        withinFilter={(link) =>
          (scope.environmentId === null || scope.environmentId === link.ref.environmentId) &&
          (scope.projectId === null || scope.projectId === link.projectId) &&
          (view.kind === null || view.kind === link.ref.kind)
        }
        onOpen={(target) =>
          navigation.push("SettingsFactoryWork", {
            work: JSON.stringify(target),
            returnTo: props.routeContext,
          })
        }
      />
      <WorkHistory reference={reference} work={work} />
    </>
  );
}

export function FactoryWorkDetailRouteScreen() {
  const gt = useGT();
  const messages = useMessages();
  const registry = use(RegistryContext);
  const view = useFactoryWorkView();
  const route = useRoute<RouteProp<FactoryWorkRoutes, "SettingsFactoryWork">>();
  const navigation = useNavigation<NativeStackNavigationProp<FactoryWorkRoutes>>();
  const returnTo = route.params?.returnTo;
  const previous = navigation.getState().routes.at(-2);
  const previousMatches =
    previous?.name === "SettingsFactoryWork" && previous.params?.work === returnTo?.work;
  const navigationReturn = (target: FactoryWorkDetailParams) => {
    if (previousMatches) navigation.goBack();
    else navigation.setParams({ ...target, returnTo: target.returnTo });
  };
  usePreventRemove(returnTo !== undefined, ({ data }) => {
    if (
      returnTo &&
      !previousMatches &&
      (data.action.type === "GO_BACK" || data.action.type === "POP")
    )
      navigation.setParams({ ...returnTo, returnTo: returnTo.returnTo });
    else navigation.dispatch(data.action);
  });
  const insets = useSafeAreaInsets();
  const work = route.params?.work;
  const reference = parseFactoryWorkSelection(work);
  const { environments } = useEnvironments();
  const projects = useProjects();
  const environmentId: EnvironmentId | null = reference?.environmentId ?? null;
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const access = reference === null ? "offline" : factoryWorkAccess(environment, canRead);
  const query = useEnvironmentQuery(
    reference !== null && access === "current"
      ? factoryEnvironment.readWork({
          environmentId: reference.environmentId,
          input: {
            ref: reference,
            ...factoryIssueKeysInput(
              environment?.serverConfig?.environment.capabilities.factoryIssueKeys === true,
            ),
          },
        })
      : null,
  );
  const status = isAuthorizationError(query.failure) ? "forbidden" : access;
  const data = selectFactoryWorkDetail(status, query.error === null ? query.data : null);
  const projectLabel = (projectId: ProjectId) =>
    projects.find(
      (project) =>
        !project.isScratch && project.environmentId === environmentId && project.id === projectId,
    )?.title ?? null;

  let body;
  if (reference === null || work === undefined) {
    body = (
      <EmptyState
        variant="plain"
        title={gt("Work unavailable")}
        detail={gt("This work reference can't be read. Go back and choose an item again.")}
      />
    );
  } else if (status !== "current") {
    body = (
      <EmptyState
        variant="plain"
        title={status === "loading" ? gt("Loading work") : gt("Can't inspect")}
        detail={messages(FACTORY_WORK_OWNER_MESSAGES[status])}
      />
    );
  } else if (query.error) {
    body = (
      <View className="items-start gap-3">
        <Text className="text-sm text-danger-foreground">{query.error}</Text>
        <Button tone="primary" label={gt("Try again")} onPress={query.refresh} />
      </View>
    );
  } else if (data === null) {
    body = (
      <Text className="text-sm text-foreground-muted">
        <T>Loading work…</T>
      </Text>
    );
  } else {
    body = (
      <WorkDetail
        reference={reference}
        work={work}
        data={data}
        projectLabel={projectLabel}
        capabilities={environment?.serverConfig?.environment.capabilities ?? {}}
        routeContext={route.params}
      />
    );
  }

  return (
    <SettingsScreen title={gt("Work")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {route.params?.returnTo ? (
          <View className="items-start">
            <Button
              label={gt("Return to previous selection")}
              accessibilityHint={gt(
                "Restores the Work detail you inspected this prerequisite from",
              )}
              onPress={() => {
                const target = route.params.returnTo;
                if (target) navigationReturn(target);
              }}
            />
          </View>
        ) : null}
        {reference !== null ? (
          <View className="flex-row flex-wrap items-center justify-between gap-2">
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted" selectable>
              {environment?.label ?? reference.environmentId} · {reference.kind} · {reference.id}
            </Text>
            <Button
              tone="text"
              label={gt("Refresh")}
              icon="arrow.clockwise"
              accessibilityLabel={gt("Refresh work details")}
              disabled={status !== "current" || query.isPending}
              onPress={() => {
                query.refresh();
                if (work !== undefined)
                  registry.refresh(workHistoryQuery(reference, factoryWorkHistoryFor(view, work)));
              }}
            />
          </View>
        ) : null}
        {body}
      </ScrollView>
    </SettingsScreen>
  );
}
